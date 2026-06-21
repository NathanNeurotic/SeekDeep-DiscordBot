// SeekDeep Tauri shell library entry point.
//
// v2 — auto-spawn local_ai_server.py as a sidecar process. See sidecar.rs
// for the boot sequence (probe :7865, extract bundled resources, find python,
// spawn server, kill child on close). The loading.html page is the initial
// window URL; it polls /health and redirects to chat.html once the server is up.
//
// v2.1 features:
//   * `restart_sidecar` Tauri command — kills the child + re-runs boot_sequence.
//     Called by gui/ml-deps.js after pip install completes (torch can't be
//     hot-imported into a running Python process, so we need a clean restart).
//   * System tray icon — Show/Quit menu. Close window = hide to tray (server
//     stays running); tray Quit = actually exit + kill child.
//   * Left-click tray = toggle window visibility.

mod sidecar;

use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};

use sidecar::SidecarState;

#[tauri::command]
fn install_python_deps(app: tauri::AppHandle) -> Result<String, String> {
    let runtime = sidecar::app_runtime_dir(&app)?;
    let python = sidecar::find_python(&runtime).ok_or("PYTHON_NOT_FOUND".to_string())?;
    sidecar::pip_install(&python, &runtime)
}

/// Install heavy ML deps (torch, transformers, diffusers, accelerate, etc.).
/// Kills the running sidecar first because pip can't overwrite .pyd / .py
/// files that the live Python process has imported (WinError 32 on
/// Windows). After pip completes (success or failure), respawns the
/// sidecar so the user lands back in a working state.
///
/// Returns pip's combined stdout/stderr so the frontend can render it in
/// the install modal. The respawn happens asynchronously after the pip
/// call returns; the page should reload itself once /health is back.
#[tauri::command]
async fn install_ml_deps(app: tauri::AppHandle) -> Result<String, String> {
    // async so the Tauri main thread isn't blocked for 5-10 minutes
    // while pip downloads ~2 GB. The window's message pump stays
    // responsive, which means Windows stops painting "Not Responding"
    // on the title bar and the renderer keeps animating the progress
    // log as ml-install:line events stream in.
    let app_inner = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let runtime = sidecar::app_runtime_dir(&app_inner)?;
        let python = sidecar::find_python(&runtime).ok_or("PYTHON_NOT_FOUND".to_string())?;

        // 1. Kill the running sidecar (releases file handles on torch/etc.)
        let state = app_inner.state::<SidecarState>();
        sidecar::kill_child(state.inner());
        sidecar::emit_status(&app_inner, "RESTARTING");
        // Give Windows a moment to release the file handles. Python's
        // process exit doesn't always release immediately on AV-scanned
        // installs.
        std::thread::sleep(Duration::from_millis(800));

        // 2. Run pip install — streams ml-install:line events as it
        //    downloads so the GUI modal updates in real time.
        sidecar::pip_install_ml(&app_inner, &python, &runtime)
    }).await;

    // 3. Respawn the sidecar regardless of pip outcome — even if pip failed OR
    //    the blocking task PANICKED. The sidecar was already killed above, so an
    //    early `?` on a JoinError here (the old code) would leave the user with
    //    no server and no recovery, violating the "respawn regardless" guarantee.
    //    Spawn the respawn unconditionally, THEN propagate any join error.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        sidecar::boot_sequence(handle);
    });

    result.map_err(|e| format!("install task join: {e}"))?
}

/// Reinstall torch + torchvision + torchaudio against a specific CUDA
/// variant. Same kill-pip-respawn dance as install_ml_deps, but the
/// pip args target only the torch trio + the variant index URL. Wired
/// to the chat playground's "wrong wheel" Fix button — one click and
/// the user is on the right wheel for their GPU.
///
/// `variant` is one of: cu118, cu121, cu124, cu126, cu128, cpu.
/// (Validated in sidecar::pip_install_torch_variant.)
#[tauri::command]
async fn install_torch_variant(app: tauri::AppHandle, variant: String) -> Result<String, String> {
    let app_inner = app.clone();
    let var = variant.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let runtime = sidecar::app_runtime_dir(&app_inner)?;
        let python = sidecar::find_python(&runtime).ok_or("PYTHON_NOT_FOUND".to_string())?;

        let state = app_inner.state::<SidecarState>();
        sidecar::kill_child(state.inner());
        sidecar::emit_status(&app_inner, "RESTARTING");
        std::thread::sleep(Duration::from_millis(800));

        sidecar::pip_install_torch_variant(&app_inner, &python, &runtime, &var)
    }).await;

    // Respawn regardless of pip outcome OR a panic in the blocking task — the
    // sidecar was already killed above, so spawn the respawn unconditionally
    // before propagating any join error (see install_ml_deps for the rationale).
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        sidecar::boot_sequence(handle);
    });

    result.map_err(|e| format!("install task join: {e}"))?
}

#[tauri::command]
fn retry_spawn(app: tauri::AppHandle) -> Result<(), String> {
    // The "try again" button after CRASH_GAVE_UP. Grant a fresh crash budget so
    // the new watchdog doesn't inherit the saturated counter and immediately
    // give up again. (retry_spawn bypasses kill_child, which resets it for the
    // restart/install paths, so reset it explicitly here too.)
    if let Ok(mut g) = app.state::<SidecarState>().respawn_attempts.lock() {
        *g = 0;
    }
    let handle = app.clone();
    thread::spawn(move || {
        sidecar::boot_sequence(handle);
    });
    Ok(())
}

/// AUD-003: allowlist gate for `open_external`. The desktop bridge opens a
/// frontend-supplied URL in the system browser; an unvalidated opener turns any
/// GUI XSS into an arbitrary-URL / local-protocol-handler opener. Policy:
///
///   * `discord:` — allowed (the first-party deep-link the prompts page uses;
///     `discord://-/channels/<g>/<c>`). No host check — it's a fixed OS handler,
///     and the `https://discord.com/...` form is the fallback covered below.
///   * `https:`   — allowed only for the small product host allowlist.
///   * everything else (`http:`, `file:`, `javascript:`, `data:`, other custom
///     schemes) — refused.
///
/// Returns Ok(()) when the URL may be opened, or Err(reason) to refuse.
fn open_external_url_allowed(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("unparseable URL: {e}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme == "discord" {
        return Ok(());
    }
    if scheme != "https" {
        return Err(format!("blocked URL scheme '{scheme}' (only https + discord: are allowed)"));
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err("blocked: https URL has no host".to_string());
    }
    // Product hosts only. Subdomains match via the leading-dot suffix check so a
    // look-alike like `github.com.evil.com` or `evilgithub.com` is refused.
    const ALLOWED_HOSTS: &[&str] = &[
        "github.com",
        "raw.githubusercontent.com",
        "objects.githubusercontent.com",
        "discord.com",
        "discord.gg",
        "python.org",
        "huggingface.co",
        "pytorch.org",
        "ollama.com",
        "ollama.ai",
        "docker.com",
        "nvidia.com",
        // Hosts the GUI itself links to (installer help + the About-page partner
        // link) — without these, those <a> links route to open_external and get
        // refused. All are first-party product/partner destinations.
        "git-scm.com",
        "nodejs.org",
        "virustotal.com",
        "demonbot.win",
    ];
    // Exact match, or a dot-boundary subdomain. strip_suffix avoids the
    // per-call heap allocation `format!(".{h}")` would do (per PR review).
    let allowed = ALLOWED_HOSTS.iter().any(|&h| {
        host == h || host.strip_suffix(h).map_or(false, |prefix| prefix.ends_with('.'))
    });
    if allowed {
        Ok(())
    } else {
        Err(format!("blocked host '{host}' (not in the SeekDeep open-external allowlist)"))
    }
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // AUD-003: validate scheme + host before handing the URL to the OS opener.
    open_external_url_allowed(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("open_url: {e}"))
}

#[cfg(test)]
mod open_external_tests {
    use super::open_external_url_allowed as chk;

    #[test]
    fn allows_product_https_hosts() {
        assert!(chk("https://github.com/NathanNeurotic/SeekDeep-DiscordBot/releases/tag/v1.2.3").is_ok());
        assert!(chk("https://raw.githubusercontent.com/x/y/main/file").is_ok());
        assert!(chk("https://www.python.org/downloads/").is_ok());      // www. subdomain
        assert!(chk("https://ollama.com/download").is_ok());
        assert!(chk("https://cdn-lfs.huggingface.co/repos/x").is_ok()); // subdomain
        assert!(chk("https://discord.com/channels/1/2").is_ok());
        assert!(chk("https://developer.nvidia.com/cuda").is_ok());
        assert!(chk("https://git-scm.com/").is_ok());                // installer help link
        assert!(chk("https://nodejs.org/").is_ok());                 // installer help link
        assert!(chk("https://www.virustotal.com/").is_ok());         // installer scan link (www. subdomain)
        assert!(chk("https://www.demonbot.win/").is_ok());           // About-page partner link
    }

    #[test]
    fn allows_first_party_discord_deeplink() {
        assert!(chk("discord://-/channels/123/456").is_ok());
    }

    #[test]
    fn blocks_dangerous_schemes() {
        assert!(chk("http://github.com/x").is_err());        // plain http
        assert!(chk("file:///etc/passwd").is_err());
        assert!(chk("javascript:alert(1)").is_err());
        assert!(chk("data:text/html,<script>alert(1)</script>").is_err());
        assert!(chk("tauri://localhost/x").is_err());        // custom scheme
        assert!(chk("ms-msdt:/id").is_err());                // OS handler abuse
    }

    #[test]
    fn blocks_unapproved_and_lookalike_hosts() {
        assert!(chk("https://evil.example.com/x").is_err());
        assert!(chk("https://github.com.evil.com/x").is_err());  // suffix-append attack
        assert!(chk("https://evilgithub.com/x").is_err());       // no dot boundary
        assert!(chk("https://evilhuggingface.co/x").is_err());
    }

    #[test]
    fn blocks_unparseable_and_hostless() {
        assert!(chk("not a url").is_err());
        assert!(chk("https://").is_err());
    }
}

/// Open the SeekDeep log directory in the OS file manager. Used by the
/// loading overlay's "View server log" button when boot fails, so the
/// user can read `server.log` without hunting through `%APPDATA%`.
#[tauri::command]
fn view_logs(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = sidecar::app_log_dir(&app)?;
    // Ensure the dir exists so the opener doesn't error on a fresh install
    // that hasn't spawned the server yet.
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("mkdir log_dir: {e}"))?;
    let path_str = log_dir.to_string_lossy().to_string();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("open_path: {e}"))
}

/// Kill the spawned Python sidecar and re-run the boot sequence. Called from
/// the frontend after `deps.install.complete` fires — torch / transformers /
/// diffusers carry native extensions that can't be hot-imported into an
/// already-initialized Python process, so a clean restart is the only path
/// to get the new libraries loaded.
///
/// We block briefly between kill and spawn so the OS reclaims port 7865;
/// without that delay the new uvicorn would fail to bind. 500 ms is enough
/// on every OS I've tested.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    sidecar::kill_child(state.inner());
    // User-initiated restart sweeps orphan local_ai_server.py processes too,
    // not just the tracked child. Repeated Restart clicks (or a Restart while
    // a previous Tauri session's orphan was still wedged on :7865) would
    // otherwise stack duplicate python.exe interpreters that all try to bind
    // 7865 and lose. boot_sequence's LAUNCH_REAPED guard only fires once per
    // Tauri launch, so manual Restart deliberately bypasses it here.
    sidecar::kill_orphan_ai_servers();
    sidecar::emit_status(&app, "RESTARTING");
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        sidecar::boot_sequence(handle);
    });
    Ok(())
}

/// Compare this build's version (from CARGO_PKG_VERSION, sourced from
/// package.json) against the latest GitHub release tag. Returns:
///   { current, latest, update_available, release_url }
///
/// Synchronous std::process call to `curl` to avoid pulling in reqwest +
/// a TLS stack just for a single GET. Curl ships with Windows since
/// 1809 (April 2018) and is part of the base macOS + Linux installs we
/// support, so it's a safe assumption.
///
/// Called by the frontend on chat.html load. Surfaces a toast / banner
/// (via notify.js) if a newer tag exists upstream.
#[tauri::command]
fn check_for_update() -> Result<serde_json::Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = "https://api.github.com/repos/NathanNeurotic/SeekDeep-DiscordBot/releases/latest";
    // TAU-9: pin curl to %SystemRoot%\System32\curl.exe on Windows (PATH-hijack).
    let out = std::process::Command::new(sidecar::resolve_system_tool("curl"))
        .args([
            "-s", "-L",
            "-H", "Accept: application/vnd.github+json",
            "-H", "User-Agent: SeekDeep-Tauri",
            "--max-time", "8",
            url,
        ])
        .output()
        .map_err(|e| format!("curl invocation failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("curl exited {}", out.status));
    }
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("parse GitHub response: {e}"))?;
    let latest_tag = parsed.get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let release_url = parsed.get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/NathanNeurotic/SeekDeep-DiscordBot/releases")
        .to_string();
    // Compare the dotted numeric components as integers — a plain string compare
    // mis-orders unequal-width versions (lexically "10.35.5" < "10.35.46" and
    // 10.40.0 vs 10.5.0 both invert). The "nightly" tag is skipped explicitly.
    fn version_is_newer(latest: &str, current: &str) -> bool {
        fn parts(s: &str) -> Vec<u64> {
            s.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0)).collect()
        }
        let (a, b) = (parts(latest), parts(current));
        for i in 0..a.len().max(b.len()) {
            let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
            if x != y { return x > y; }
        }
        false
    }
    let update_available = !latest_tag.is_empty()
        && latest_tag.as_str() != "nightly"
        && version_is_newer(&latest_tag, &current);
    Ok(serde_json::json!({
        "current": current,
        "latest": latest_tag,
        "update_available": update_available,
        "release_url": release_url,
    }))
}

/// Resolve the Docker CLI to a trusted ABSOLUTE path when Docker Desktop is
/// installed in its standard location, else fall back to a bare `docker` (PATH).
/// Audit L-4 follow-up to the TAU-9 note: prefer the absolute binary so a
/// polluted PATH (or a repo-/runtime-local `docker.exe`) isn't run on the common
/// Docker-Desktop install. The PATH fallback is deliberately kept so a
/// non-standard install still detects — worst case it degrades to the existing
/// "not_installed" result, never the hijack of a known-good absolute binary.
#[cfg(windows)]
fn resolve_docker_cli() -> std::ffi::OsString {
    for c in [
        r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        r"C:\Program Files\Docker\Docker\resources\docker.exe",
    ] {
        if std::path::Path::new(c).is_file() {
            return std::ffi::OsString::from(c);
        }
    }
    std::ffi::OsString::from("docker")
}
#[cfg(target_os = "macos")]
fn resolve_docker_cli() -> std::ffi::OsString {
    // Same L-4 hardening as Windows: prefer a standard absolute binary so a
    // polluted PATH (or a cwd-local `docker`) can't shadow it. `is_file()`
    // follows symlinks, so the Homebrew/Docker-Desktop symlinks resolve.
    //   1. Docker Desktop's bundled binary (installer-owned — highest trust).
    //   2. /usr/local/bin/docker — the symlink Docker Desktop installs, and
    //      the Intel-Homebrew prefix.
    //   3. /opt/homebrew/bin/docker — the Apple-Silicon Homebrew prefix.
    // The Homebrew prefixes are user-writable so they're not a hard trust
    // boundary, but pinning them still beats PATH-order shadowing and is never
    // worse than the bare-`docker` fallback below.
    for p in [
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
    ] {
        if std::path::Path::new(p).is_file() {
            return std::ffi::OsString::from(p);
        }
    }
    std::ffi::OsString::from("docker")
}
#[cfg(all(not(windows), not(target_os = "macos")))]
fn resolve_docker_cli() -> std::ffi::OsString {
    // Linux/BSD: PATH resolution. CLI install paths vary by distro/runtime
    // (apt, snap, rootless) with no single canonical absolute path to pin.
    std::ffi::OsString::from("docker")
}

/// Try to start Docker Desktop. Returns one of:
///   { ok: true,  state: "running"        }  — `docker info` already works, no action needed.
///   { ok: true,  state: "launched"       }  — Docker was installed but not running; we launched it.
///   { ok: false, state: "not_installed"  }  — `docker --version` failed; user needs the Install link.
///   { ok: false, state: "launch_failed", detail: "..." }  — found Docker exe but spawn failed.
///
/// Called from the Installer page's Docker row instead of jumping straight
/// to the "Install Docker" link. Saves users who already have Docker
/// installed but never launched the Desktop app from a useless trip to
/// docker.com.
#[tauri::command]
fn try_start_docker_desktop() -> Result<serde_json::Value, String> {
    // Docker CLI resolution is pinned-where-possible by resolve_docker_cli()
    // (audit L-4): the absolute Docker Desktop path on a standard install, with a
    // bare `docker` (PATH) fallback for non-standard installs. Step 3 below
    // launches Docker Desktop.exe from fixed absolute paths via the pinned cmd.
    let docker_cli = resolve_docker_cli();
    // 1. Probe: is Docker already running? Use the BOUNDED daemon check — a
    //    half-started Docker Desktop / WSL2 backend can make `docker info` hang
    //    for a long time or indefinitely, which is exactly the transient state
    //    this "try to start Docker" path is invoked in. The old unbounded
    //    `.status()` could spin the Installer button forever and tie up a Tauri
    //    command worker. (Mirrors the start_searxng_stack path.)
    if docker_daemon_up(&docker_cli) {
        return Ok(serde_json::json!({ "ok": true, "state": "running" }));
    }
    // 2. Probe: is Docker installed at all? (bounded `--version`.)
    let mut ver = std::process::Command::new(&docker_cli);
    ver.arg("--version");
    if !run_capture_within(ver, Duration::from_secs(10)).0 {
        return Ok(serde_json::json!({ "ok": false, "state": "not_installed" }));
    }
    // 3. Docker is installed but not running. Try to launch Docker Desktop.
    match launch_docker_desktop() {
        Ok(()) => Ok(serde_json::json!({ "ok": true, "state": "launched" })),
        Err(detail) => Ok(serde_json::json!({ "ok": false, "state": "launch_failed", "detail": detail })),
    }
}

/// Launch Docker Desktop (or the platform daemon). Shared by
/// `try_start_docker_desktop` and the SearXNG-stack command below so there's
/// one launch implementation. Ok(()) = spawn succeeded (the daemon still
/// needs ~20-30s to come up); Err(detail) = couldn't find/launch it.
#[cfg(windows)]
fn launch_docker_desktop() -> Result<(), String> {
    // Standard install paths. If the user has it elsewhere, every spawn fails
    // and we surface a "launch manually" detail.
    let candidates = [
        r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
        r"C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            // TAU-9: pin cmd to %SystemRoot%\System32\cmd.exe (PATH-hijack).
            if std::process::Command::new(sidecar::resolve_system_tool("cmd"))
                .args(["/C", "start", "", path])
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    Err("couldn't find Docker Desktop.exe in the default install paths; launch it manually from the Start menu.".to_string())
}
#[cfg(target_os = "macos")]
fn launch_docker_desktop() -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Docker"])
        .spawn()
        .map(|_| ())
        .map_err(|_| "open -a Docker failed".to_string())
}
#[cfg(all(not(windows), not(target_os = "macos")))]
fn launch_docker_desktop() -> Result<(), String> {
    // Linux: Docker is usually a systemd service. Try systemctl start.
    let st = std::process::Command::new("systemctl")
        .args(["--user", "start", "docker"])
        .status();
    if matches!(st, Ok(s) if s.success()) {
        Ok(())
    } else {
        Err("systemctl --user start docker failed; try `sudo systemctl start docker`".to_string())
    }
}

/// Run a command with a wall-clock timeout, capturing stdout/stderr.
/// `std::process` has no built-in timeout, so we spawn, drain both pipes on
/// threads (a full pipe buffer would otherwise deadlock the child), and poll
/// `try_wait` until the deadline — killing the child if it overruns. Returns
/// (exited-zero, stdout, stderr, timed_out). Used for every `docker` call in
/// the SearXNG stack so a half-started daemon or a slow image pull can't wedge
/// the wait loop forever.
fn run_capture_within(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> (bool, String, String, bool) {
    use std::io::Read;
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, String::new(), format!("spawn failed: {e}"), false),
    };
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_handle = thread::spawn(move || {
        let mut s = String::new();
        if let Some(ref mut p) = out_pipe {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let err_handle = thread::spawn(move || {
        let mut s = String::new();
        if let Some(ref mut p) = err_pipe {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let deadline = std::time::Instant::now() + timeout;
    let (success, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.success(), false),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (false, true);
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(_) => break (false, false),
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    (success, stdout, stderr, timed_out)
}

/// Is the Docker daemon answering? Mirrors gui_endpoints.py
/// `_seekdeep_docker_daemon_up` (bounded `docker info`).
fn docker_daemon_up(docker_cli: &std::ffi::OsStr) -> bool {
    let mut c = std::process::Command::new(docker_cli);
    c.args(["info", "--format", "{{.ServerVersion}}"]);
    run_capture_within(c, Duration::from_secs(12)).0
}

/// Is SearXNG answering on loopback :8080? Mirrors gui_endpoints.py
/// `_seekdeep_searxng_reachable` — both the Python boot path and the firstrun
/// check hardcode 8080 for the container, so we match exactly.
fn searxng_reachable() -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080);
    TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).is_ok()
}

/// How long to wait for the Docker daemon after launching Docker Desktop
/// (poll every 4s). Matches the Python boot autostart budget.
const SEARXNG_DAEMON_WAIT_S: u64 = 120;

/// Gap 3 — one-click "bring up web search" for onboarding.
///
/// Atomically: probe SearXNG → ensure the Docker daemon is up (launching
/// Docker Desktop and waiting up to ~2 min if needed) → start the SearXNG
/// container. Uses the SAME container name, port (8080), and config volume
/// (`<runtime>/searxng`) as the Python boot path
/// (gui_endpoints.py `_seekdeep_ensure_searxng_stack`), so whichever layer
/// starts SearXNG the other sees it — no divergence.
///
/// Lives in the desktop shell (not the Python server) so it can recover web
/// search even when the AI server is wedged/down — the shell is the
/// always-available layer. Emits `searxng-stack:status` events
/// ({stage, detail}) so the GUI can show live progress through the long wait.
///
/// Result `state`:
///   already_up            — SearXNG already answering (ok).
///   started               — container launched, answers in ~5-15s (ok).
///   docker_not_installed  — no docker CLI; route to the Install step.
///   docker_launch_failed  — found nothing to launch / spawn failed.
///   daemon_timeout        — launched Docker but the daemon didn't answer in time.
///   searxng_failed        — `docker run` failed (detail carries the reason).
#[tauri::command]
async fn start_searxng_stack(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_inner = app.clone();
    // async + spawn_blocking: the daemon wait can take up to ~2 min and the
    // image pull longer; the Tauri main thread must stay responsive.
    tauri::async_runtime::spawn_blocking(move || ensure_searxng_stack_blocking(&app_inner))
        .await
        .map_err(|e| format!("searxng task join: {e}"))?
}

fn ensure_searxng_stack_blocking(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let emit = |stage: &str, detail: &str| {
        let _ = app.emit(
            "searxng-stack:status",
            serde_json::json!({ "stage": stage, "detail": detail }),
        );
    };

    // 0. Already up? Nothing to do.
    if searxng_reachable() {
        emit("already_up", "SearXNG is already answering on :8080.");
        return Ok(serde_json::json!({ "ok": true, "state": "already_up" }));
    }

    let docker_cli = resolve_docker_cli();

    // 1. Ensure the Docker daemon is up.
    if !docker_daemon_up(&docker_cli) {
        emit("checking_docker", "Docker daemon is down — checking for Docker Desktop…");
        // Installed at all?
        let mut ver = std::process::Command::new(&docker_cli);
        ver.arg("--version");
        let installed = run_capture_within(ver, Duration::from_secs(10)).0;
        if !installed {
            emit("docker_not_installed", "Docker isn't installed.");
            return Ok(serde_json::json!({ "ok": false, "state": "docker_not_installed" }));
        }
        // 2. Launch Docker Desktop.
        emit("launching_docker", "Launching Docker Desktop…");
        if let Err(detail) = launch_docker_desktop() {
            emit("docker_launch_failed", &detail);
            return Ok(serde_json::json!({ "ok": false, "state": "docker_launch_failed", "detail": detail }));
        }
        // 3. Wait for the daemon (poll every 4s up to the budget).
        emit("waiting_daemon", "Waiting for the Docker daemon (up to 2 min)…");
        let deadline = std::time::Instant::now() + Duration::from_secs(SEARXNG_DAEMON_WAIT_S);
        loop {
            thread::sleep(Duration::from_secs(4));
            if docker_daemon_up(&docker_cli) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let detail = format!(
                    "Docker daemon didn't answer within {SEARXNG_DAEMON_WAIT_S}s; it may still be starting — retry shortly."
                );
                emit("daemon_timeout", &detail);
                return Ok(serde_json::json!({ "ok": false, "state": "daemon_timeout", "detail": detail }));
            }
        }
    }

    // 4. Daemon is up — SearXNG may have come back with it (restart=unless-stopped).
    if searxng_reachable() {
        emit("already_up", "SearXNG is already answering on :8080.");
        return Ok(serde_json::json!({ "ok": true, "state": "already_up" }));
    }

    // 5. Start the container — same name/port/volume as the Python boot path.
    emit("starting_searxng", "Starting the SearXNG container…");
    let runtime = sidecar::app_runtime_dir(app)?;
    let searxng_dir = runtime.join("searxng");
    std::fs::create_dir_all(&searxng_dir).map_err(|e| format!("create searxng config dir: {e}"))?;
    let vol = format!("{}:/etc/searxng:rw", searxng_dir.display());
    let image = std::env::var("SEEKDEEP_SEARXNG_IMAGE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "searxng/searxng:latest".to_string());

    // Idempotent: drop any stale container so the flags below take effect
    // (matches the Python path / seekdeep_launcher.bat).
    let mut rm = std::process::Command::new(&docker_cli);
    rm.args(["rm", "-f", "seekdeep-searxng"]);
    let _ = run_capture_within(rm, Duration::from_secs(15));

    let mut run = std::process::Command::new(&docker_cli);
    run.args([
        "run", "-d", "--name", "seekdeep-searxng",
        "--restart", "unless-stopped", "-p", "8080:8080",
        "-e", "BASE_URL=http://localhost:8080/",
        "-e", "INSTANCE_NAME=SeekDeep",
        "-v", &vol, &image,
    ]);
    // First run pulls the image (~hundreds of MB) — bound generously.
    let (ok, out, err, timed_out) = run_capture_within(run, Duration::from_secs(180));
    if timed_out {
        let detail = "docker run timed out — the first run pulls the SearXNG image; retry once the pull finishes.".to_string();
        emit("searxng_failed", &detail);
        return Ok(serde_json::json!({ "ok": false, "state": "searxng_failed", "detail": detail }));
    }
    if !ok {
        let mut detail = if !err.trim().is_empty() { err.trim().to_string() } else { out.trim().to_string() };
        if detail.is_empty() {
            detail = "docker run failed".to_string();
        }
        if detail.len() > 300 {
            detail.truncate(300);
        }
        emit("searxng_failed", &detail);
        return Ok(serde_json::json!({ "ok": false, "state": "searxng_failed", "detail": detail }));
    }
    let container_id: String = out.trim().chars().take(12).collect();
    emit("started", "SearXNG started — it answers in ~5-15s.");
    Ok(serde_json::json!({ "ok": true, "state": "started", "container_id": container_id }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            install_python_deps,
            install_ml_deps,
            install_torch_variant,
            retry_spawn,
            open_external,
            restart_sidecar,
            check_for_update,
            view_logs,
            try_start_docker_desktop,
            start_searxng_stack,
        ])
        .setup(|app| {
            // TAU-N1: honour SEEKDEEP_* knobs set in <runtime>/.env. The shell
            // never loaded .env, so SEEKDEEP_PYTHON / SEEKDEEP_TAURI_* /
            // SEEKDEEP_CLOSE_HIDES_TO_TRAY were dead unless exported to the real
            // environment. Must run first — before find_python, the sidecar
            // spawn, and the window/exit handlers read any of these.
            if let Ok(runtime) = sidecar::app_runtime_dir(app.handle()) {
                sidecar::load_runtime_env(&runtime);
            }

            // --- System tray ---------------------------------------------
            // Build the tray icon + menu. Close-to-tray means SeekDeep can
            // keep serving the Discord bot in the background while the main
            // window is hidden. The tray menu is the ONLY way to actually
            // exit (sets quit_requested → window close handler kills child).
            // Tray menu: flat list with separators for readability. Grouped
            // by purpose (window control · navigation · services · external
            // links · quit). Every nav item emits a `tray:nav` event the
            // webview listens for (gui/nav.js); fallback to w.eval for the
            // case where main isn't loaded yet.
            let show_item    = MenuItem::with_id(app, "show",       "Show SeekDeep",         true, None::<&str>)?;
            let hide_item    = MenuItem::with_id(app, "hide",       "Hide window",           true, None::<&str>)?;
            let sep1         = PredefinedMenuItem::separator(app)?;
            let nav_cc       = MenuItem::with_id(app, "nav_cc",     "Open Control Center",   true, None::<&str>)?;
            let nav_chat     = MenuItem::with_id(app, "nav_chat",   "Open Chat playground",  true, None::<&str>)?;
            let nav_models   = MenuItem::with_id(app, "nav_models", "Open Model picker",     true, None::<&str>)?;
            let nav_logs     = MenuItem::with_id(app, "nav_logs",   "Open Logs viewer",      true, None::<&str>)?;
            let nav_config   = MenuItem::with_id(app, "nav_config", "Open Bot config",       true, None::<&str>)?;
            let sep2         = PredefinedMenuItem::separator(app)?;
            let restart_item = MenuItem::with_id(app, "restart_server", "Restart AI server", true, None::<&str>)?;
            let self_update  = MenuItem::with_id(app, "self_update",    "Self-update from GitHub", true, None::<&str>)?;
            let open_logs    = MenuItem::with_id(app, "open_logs_dir",  "Open log folder",   true, None::<&str>)?;
            let open_env     = MenuItem::with_id(app, "open_env",       "Open .env file",    true, None::<&str>)?;
            let sep3         = PredefinedMenuItem::separator(app)?;
            let nightly      = MenuItem::with_id(app, "open_nightly",   "Check for updates (nightly releases)", true, None::<&str>)?;
            let about        = MenuItem::with_id(app, "open_about",     "About SeekDeep",    true, None::<&str>)?;
            let sep4         = PredefinedMenuItem::separator(app)?;
            let quit_item    = MenuItem::with_id(app, "quit",       "Quit SeekDeep",         true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &show_item, &hide_item, &sep1,
                &nav_cc, &nav_chat, &nav_models, &nav_logs, &nav_config, &sep2,
                &restart_item, &self_update, &open_logs, &open_env, &sep3,
                &nightly, &about, &sep4,
                &quit_item,
            ])?;

            TrayIconBuilder::with_id("seekdeep-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SeekDeep")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "restart_server" => {
                        let state = app.state::<SidecarState>();
                        sidecar::kill_child(state.inner());
                        sidecar::emit_status(app, "RESTARTING");
                        let handle = app.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(500));
                            sidecar::boot_sequence(handle);
                        });
                    }
                    // --- Navigation actions ---
                    // Show window first (in case user has it hidden) then emit
                    // a tray:nav event the webview listens for. nav.js routes
                    // based on the `to` field. Fallback: w.eval if event
                    // listener not yet attached on a freshly-shown window.
                    "nav_cc" | "nav_chat" | "nav_models" | "nav_logs" | "nav_config" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
                            let (page, hash) = match event.id.as_ref() {
                                "nav_cc"     => ("app.html", "#launcher"),
                                "nav_chat"   => ("chat.html", ""),
                                "nav_models" => ("app.html", "#open-model-catalog"),
                                "nav_logs"   => ("app.html", "#logs"),
                                "nav_config" => ("app.html", "#config"),
                                _ => ("app.html", ""),
                            };
                            let _ = app.emit("tray:nav", serde_json::json!({"page": page, "hash": hash}));
                            // For the model picker specifically, if we're already on app.html,
                            // call the window function directly so it opens even when the
                            // hash is unchanged from a previous tray click.
                            let eval_js = if event.id.as_ref() == "nav_models" {
                                format!(
                                    "if(!window.location.pathname.endsWith('/app.html'))location.href='app.html{0}';else if(typeof window.SeekDeepOpenModelCatalog==='function')window.SeekDeepOpenModelCatalog('chat');else location.hash='{0}';",
                                    hash
                                )
                            } else {
                                format!(
                                    "if(!window.location.pathname.endsWith('/{0}'))location.href='{0}{1}';else if('{1}')location.hash='{1}';",
                                    page, hash
                                )
                            };
                            // SECURITY (audit H-3): w.eval() bypasses CSP. eval_js
                            // here is built ONLY from hardcoded page/hash literals;
                            // never interpolate user/untrusted data into eval strings
                            // (the other eval sites below use only literals + the
                            // urlsafe GUI token, which is JS-string-safe).
                            let _ = w.eval(&eval_js);
                        }
                    }
                    "self_update" => {
                        // Hit the local /system/self-update endpoint via the
                        // webview's JS, which already has the GUI token. The
                        // tray itself doesn't have token access without
                        // duplicating that plumbing in Rust.
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
                            // Fetch the GUI token explicitly so this works
                            // even when nav.js's fetch monkey-patch isn't
                            // loaded yet (e.g. tray click during loading
                            // splash, which deliberately skips nav.js).
                            // Also auto-restart the sidecar after a successful
                            // update so the new code actually takes effect.
                            let _ = w.eval(r#"
                                (async () => {
                                  const sdn = window.SeekDeepNotify;
                                  const toast = (t, title, body, ttl=8000) => sdn?.toast?.({tone:t, title, body, ttl});
                                  let token = '';
                                  try {
                                    const tr = await fetch('http://127.0.0.1:7865/token');
                                    if (tr.ok) { const tj = await tr.json(); token = tj.token || tj.value || ''; }
                                  } catch {}
                                  if (!token) { toast('bad', 'Self-update failed', 'Could not fetch GUI token from /token'); return; }
                                  window.__seekdeepRestartingUntil = Date.now() + 15000;
                                  try {
                                    const r = await fetch('http://127.0.0.1:7865/system/self-update', {
                                      method: 'POST',
                                      headers: {'Content-Type': 'application/json', 'X-SeekDeep-Token': token},
                                      body: '{}'
                                    });
                                    const j = await r.json();
                                    if (!r.ok || !j.ok) { toast('bad', 'Self-update failed', j.detail || j.error || ('HTTP '+r.status)); return; }
                                    const count = (j.downloaded || j.updated || []).length;
                                    toast('good', 'Self-update OK', `Updated ${count} file(s) -- restarting AI server now...`, 5000);
                                    // Auto-restart so the patched code takes effect.
                                    try {
                                      if (window.__TAURI__?.core) await window.__TAURI__.core.invoke('restart_sidecar');
                                      else await fetch('http://127.0.0.1:7865/launcher/ai-server/restart', {method:'POST', headers:{'X-SeekDeep-Token': token}});
                                      toast('good', 'AI server restarting', `Will be live in a few seconds.`, 5000);
                                    } catch (re) {
                                      toast('warn', 'Restart failed', 'Update applied but restart did not fire — restart manually. ' + (re.message||re));
                                    }
                                  } catch (e) {
                                    toast('bad', 'Self-update failed', String(e.message||e));
                                  }
                                })();
                            "#);
                        }
                    }
                    "open_logs_dir" => {
                        // Open <runtime>/logs/ in the OS file manager.
                        if let Ok(log_dir) = sidecar::app_log_dir(app) {
                            let _ = std::fs::create_dir_all(&log_dir);
                            use tauri_plugin_opener::OpenerExt;
                            let _ = app.opener().open_path(log_dir.to_string_lossy().to_string(), None::<&str>);
                        }
                    }
                    "open_env" => {
                        // Open <runtime>/.env in the user's default editor.
                        if let Ok(runtime) = sidecar::app_runtime_dir(app) {
                            let env_path = runtime.join(".env");
                            use tauri_plugin_opener::OpenerExt;
                            let _ = app.opener().open_path(env_path.to_string_lossy().to_string(), None::<&str>);
                        }
                    }
                    "open_nightly" => {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = app.opener().open_url(
                            "https://github.com/NathanNeurotic/SeekDeep-DiscordBot/releases/tag/nightly",
                            None::<&str>,
                        );
                    }
                    "open_about" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
                            let _ = w.eval("location.href='index.html';");
                        }
                    }
                    "quit" => {
                        // Set the quit-requested flag so any pending
                        // CloseRequested event actually exits instead of
                        // hiding to tray. Sweep all SeekDeep processes
                        // synchronously BEFORE app.exit(0) — Exit handler
                        // runs again as belt-and-suspenders but doing the
                        // kill up front means the user doesn't watch the
                        // tray icon disappear while node.exe is still
                        // sitting in Task Manager.
                        let state = app.state::<SidecarState>();
                        if let Ok(mut g) = state.quit_requested.lock() {
                            *g = true;
                        }
                        sidecar::shutdown_all(state.inner());
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click on the tray icon → toggle main window.
                    // (Right-click opens the menu by default on every OS.)
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // --- Boot sidecar in background ------------------------------
            // Run the boot sequence in a background thread so the loading.html
            // page can render immediately. The window's initial URL points at
            // the loading page (see tauri.conf.json), which polls /health and
            // redirects to chat.html as soon as the server binds 7865.
            let handle = app.handle().clone();
            thread::spawn(move || {
                sidecar::boot_sequence(handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building SeekDeep")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                // Default: close-to-tray. The X button HIDES the window and the
                // app keeps serving Discord in the background (standard Slack /
                // Discord behavior). The visible tray icon signals it's still
                // running; right-click the tray icon -> "Quit SeekDeep" does the
                // full shutdown (kills bot + AI server). Opt out — make the X
                // fully quit and sweep everything — with
                // SEEKDEEP_CLOSE_HIDES_TO_TRAY=0 (or false/off) in .env.
                let state = app.state::<SidecarState>();
                let quitting = state.quit_requested.lock().map(|g| *g).unwrap_or(false);
                let close_hides_to_tray = std::env::var("SEEKDEEP_CLOSE_HIDES_TO_TRAY")
                    .ok()
                    .map(|s| !matches!(s.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
                    .unwrap_or(true);
                if !quitting && close_hides_to_tray {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                } else {
                    // Full sweep: tracked AI child + every orphan python.exe
                    // running local_ai_server.py + every node.exe running
                    // index.js. Honors SEEKDEEP_TAURI_KEEP_BOT_ON_EXIT for
                    // users who want the Discord bot to outlive Tauri.
                    sidecar::shutdown_all(state.inner());
                }
            }
            RunEvent::Exit => {
                // Belt-and-suspenders sweep on full app exit. shutdown_all
                // is idempotent (kill_child clears its tracked Option on
                // first call; orphan sweeps no-op when there's nothing to
                // kill) so re-running after CloseRequested is safe and
                // catches anything the prior path missed.
                let state = app.state::<SidecarState>();
                sidecar::shutdown_all(state.inner());
            }
            _ => {}
        });
}

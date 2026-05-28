// SeekDeep sidecar — spawns local_ai_server.py from the user's Python install.
//
// Architectural principle: the bundled .exe carries OUR code (the FastAPI server,
// the GUI files, our requirements list) but NOT a Python runtime. Python is a
// system dependency the user installs once; everything after that happens
// in-app (find python, pip install our requirements, spawn the server, kill on
// exit) — the user never opens a terminal or visits the install dir.
//
// First-run flow:
//   1. Tauri Rust shell extracts bundled resources to app_data_dir/app/
//   2. Probe 127.0.0.1:7865 — if alive (user already has the .bat running), no-op
//   3. Find python: <app_data>/.venv/Scripts/python.exe → system python3/python/py
//   4. If python missing → emit sidecar:status PYTHON_NOT_FOUND, loading.html
//      surfaces "Get Python 3.11+" button (which opens python.org via tauri-plugin-opener)
//   5. Quick import probe: `python -c "import fastapi, uvicorn"`. If it errors,
//      emit DEPS_MISSING; loading.html surfaces "Install Python deps" button
//      which calls the install_python_deps command below
//   6. Spawn local_ai_server.py from app_data_dir, redirecting stdout/stderr
//      to app_data_dir/logs/server.log so the user has something to share if
//      it fails
//   7. The loading page is already polling /health, so as soon as the server
//      binds 7865 it'll redirect to chat.html
//
// On window close: child process is killed via the AppState held in tauri::State.

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

// Fresh-boot guard. False on the first spawn_server of an app launch, true
// for every subsequent spawn (crash-respawn, restart_sidecar after ML deps
// install, etc). Used to set SEEKDEEP_FRESH_BOOT=1 ONLY on the first spawn
// so the Python side knows to kill orphan bot processes from previous user
// sessions without nuking the user's intentionally-running bot mid-session.
static FIRST_SPAWN_DONE: AtomicBool = AtomicBool::new(false);

// Windows: CREATE_NO_WINDOW (0x08000000) prevents spawned console apps
// from opening a black cmd-window alongside the Tauri shell. Without it,
// every python.exe / pip.exe call pops a stray terminal that floats on
// top of the app — extremely ugly UX. Linux/macOS Command::spawn doesn't
// have this problem (no auto-attached console).
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Wrap Command construction so all subprocess spawns get CREATE_NO_WINDOW
/// on Windows. On other platforms this is a passthrough.
fn quiet_command(program: &Path) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Same as quiet_command but takes a &str (for `py`, `python3`, etc. that
/// resolve via PATH lookup).
fn quiet_command_str(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

use tauri::{AppHandle, Emitter, Manager};

// Held in tauri's app-state so the spawn handle survives across commands and
// can be killed cleanly on window-close. Mutex because tauri command handlers
// can be invoked concurrently.
//
// `quit_requested` disambiguates the WindowEvent::CloseRequested handler:
// when false (default), close-X means "hide to tray, keep the server running";
// when true (tray Quit menu item set it), close-X means "actually exit + kill
// the child". The tray menu's Quit handler is the only thing that flips it.
//
// `intentional_kill` tells the crash-recovery watchdog NOT to respawn the
// child when it dies — because the user clicked Restart, Quit, or invoked
// install_python_deps which we wrap in a restart. Auto-consumed by the
// watchdog: it reads + clears in one shot.
//
// `respawn_attempts` is the consecutive-crash counter. Resets every time
// the server stays alive long enough to be considered healthy.
#[derive(Default)]
pub struct SidecarState {
    pub child: Mutex<Option<Child>>,
    pub quit_requested: Mutex<bool>,
    pub intentional_kill: Mutex<bool>,
    pub respawn_attempts: Mutex<u32>,
    // Set true at the top of boot_sequence; if a concurrent caller (user
    // mashes Restart, watchdog races with restart_sidecar) sees it already
    // true, they return without re-spawning. Without this, two boot_sequence
    // calls would each spawn a child, the second one wins state.child, the
    // first becomes orphaned-but-trying-to-bind-7865 → "Application shutdown
    // complete" → looks like the server is crash-looping.
    pub boot_in_progress: AtomicBool,
    // Incremented every time boot_sequence successfully spawns a child.
    // Every watchdog snapshots the generation at its own start. When it
    // wakes up, if the generation has advanced, it knows a newer watchdog
    // exists for the new child and silently exits. Stops the "two watchdogs
    // racing to consume intentional_kill" bug where the second watchdog
    // sees false (already consumed by the first) and respawns the child
    // that was just intentionally killed.
    pub watchdog_generation: AtomicU64,
}

/// Probe 127.0.0.1:7865 with a short connect timeout. True = some listener
/// is on that port. Doesn't tell us WHO is listening — see server_identity()
/// for the version-aware variant boot_sequence actually uses now.
pub fn server_already_listening() -> bool {
    let addr = "127.0.0.1:7865".parse().expect("hardcoded loopback addr");
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Server identity check. Whatever is on :7865, ask it `GET /health` and
/// return its reported version string. None = nothing responded, or the
/// response wasn't a valid SeekDeep server. Some(version) = SeekDeep is
/// up and reports that version.
///
/// This replaces the raw TCP probe in boot_sequence so we can tell the
/// difference between:
///   - this same install's SeekDeep server (reuse safely)
///   - a stale older SeekDeep server from a previous install (auto-kill
///     + spawn the new one)
///   - some unrelated process binding :7865 (refuse to clobber)
/// Was the root cause of "I installed v10.35.3 but title bar shows
/// v10.35.0" — the prior install's server kept its port and the new
/// install's sidecar said "external server up, won't spawn" and reused
/// the old code instead of extracting + spawning fresh.
pub fn server_identity() -> Option<String> {
    use std::io::{Read, Write};
    let addr = "127.0.0.1:7865".parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
    let req = "GET /health HTTP/1.1\r\nHost: 127.0.0.1:7865\r\nConnection: close\r\n\r\n";
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    // Read up to 64 KB of response then stop — /health bodies fit comfortably.
    while buf.len() < 64_000 {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    // Split headers from body and parse the body as JSON. Trivial parser —
    // no need to pull in reqwest/serde_json just for this one probe.
    let body_start = text.find("\r\n\r\n")?;
    let body = &text[body_start + 4..];
    // Look for "version":"X.Y.Z" — robust to additional whitespace.
    let v_key = "\"version\"";
    let v_idx = body.find(v_key)?;
    let after = &body[v_idx + v_key.len()..];
    let colon = after.find(':')?;
    let after_colon = &after[colon + 1..];
    let quote_start = after_colon.find('"')?;
    let after_quote = &after_colon[quote_start + 1..];
    let quote_end = after_quote.find('"')?;
    Some(after_quote[..quote_end].to_string())
}

/// Kill whatever process is bound to 127.0.0.1:7865. Used when we detect a
/// stale SeekDeep server (version mismatch with the freshly-installed app)
/// before we spawn the new one. Best-effort — if the kill fails the
/// subsequent uvicorn bind will fail noisily and the user sees the real
/// error in the loading overlay.
///
/// Windows path: `netstat -ano | findstr :7865` to grab the PID, then
/// `taskkill /F /PID <pid>`. Unix path: `lsof -ti :7865 | xargs kill -9`.
pub fn kill_listener_on_7865() {
    #[cfg(windows)]
    {
        // netstat output looks like:
        //   TCP    127.0.0.1:7865    0.0.0.0:0    LISTENING    12345
        // We want the last column (PID).
        let out = quiet_command_str("netstat")
            .args(["-ano", "-p", "TCP"])
            .output();
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                if line.contains(":7865") && line.contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        if pid.chars().all(|c| c.is_ascii_digit()) {
                            let _ = quiet_command_str("taskkill")
                                .args(["/F", "/PID", pid])
                                .status();
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg("lsof -ti :7865 | xargs -r kill -9")
            .status();
        let _ = out;
    }
}

/// Kill every node.exe whose command line names index.js. Called from the
/// RunEvent::Exit handler in lib.rs so closing SeekDeep doesn't leave the
/// Discord bot running as an orphan — without this, the bot keeps polling
/// the now-dead AI server's /health and reports "OFFLINE / unreachable"
/// to anyone using @SeekDeep until the user relaunches the app.
///
/// Scope: any node.exe whose cmdline contains "index.js". On a SeekDeep
/// dev box where the user happens to also be running an unrelated Node
/// project under index.js, the unrelated one would also get killed — but
/// the same trade-off ships in seekdeep_launcher.bat's :cleanStaleBotOnly,
/// and the symmetry is intentional (we want one boot-time mechanism on
/// the Python side and one shutdown-time mechanism on the Rust side, both
/// using the same matching rule). Power users can opt out by setting
/// SEEKDEEP_TAURI_KEEP_BOT_ON_EXIT=1 in .env.
pub fn kill_orphan_bots() {
    // Opt-out hatch for users who run a remote-backend bot that doesn't
    // depend on the local AI server and want it to keep serving Discord
    // when Tauri is minimized-to-tray and later quit.
    if std::env::var("SEEKDEEP_TAURI_KEEP_BOT_ON_EXIT")
        .ok()
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
    {
        return;
    }
    #[cfg(windows)]
    {
        // Enumerate node.exe via WMI, kill any whose command line contains
        // index.js. Single powershell shell-out — no console flash thanks
        // to quiet_command_str's CREATE_NO_WINDOW.
        let ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" \
                  | Where-Object { $_.CommandLine -like '*index.js*' } \
                  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        let _ = quiet_command_str("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", ps])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg("pgrep -f 'node.*index.js' | xargs -r kill -9")
            .status();
    }
}

/// Resolve where extracted-on-first-run files live. We use Tauri's
/// app_data_dir + "/app" so the directory layout is:
///   %APPDATA%/SeekDeep/app/local_ai_server.py
///   %APPDATA%/SeekDeep/app/gui/...
///   %APPDATA%/SeekDeep/app/logs/server.log
pub fn app_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(data.join("app"))
}

/// Logs live UNDER the runtime dir (not as a sibling of it) so that
/// gui_endpoints' /logs/tail — which scans <repo_root>/logs/ where
/// repo_root falls back to the directory containing gui_endpoints.py —
/// finds them. Previously this was app_data_dir/logs/ which diverged
/// from the viewer's scan dir, producing "no log file found" toasts.
pub fn app_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_runtime_dir(app)?.join("logs"))
}

/// Copy bundled resources to app_data_dir/app on first run or version mismatch.
/// The version stamp file (`.bundled_version`) is what we use to decide
/// whether the extracted copy is stale; on every new release the bundled
/// version bumps and we re-extract over the top.
///
/// We deliberately copy file-by-file (not recursive blat) so the user's
/// gitignored data/ + logs/ + outputs/ subdirs aren't wiped on update.
fn installed_version_for_diagnostic(stamp: &Path) -> Option<String> {
    // Returns the previously-installed version string if a stamp exists.
    // Currently unused for gating (we always re-extract) but kept around
    // so a future cache-aware extraction can reuse it cheaply.
    std::fs::read_to_string(stamp).ok().map(|s| s.trim().to_string())
}

/// True iff the bundled gui_endpoints.py in resource_dir is newer than the
/// extracted copy at runtime. Used to bypass the EXTERNAL_SERVER_RUNNING
/// short-circuit in boot_sequence() so a fresh MSI install with the SAME
/// CARGO_PKG_VERSION still triggers re-extraction. Without this check,
/// reinstalling the nightly MSI over a running same-version SeekDeep just
/// updates _up_/ but never refreshes the extracted runtime — every bug
/// fix shipped without a version bump becomes invisible to users.
fn bundle_is_newer_than_runtime(app: &AppHandle) -> bool {
    let runtime = match app_runtime_dir(app) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let resource_root = match app.path().resource_dir() {
        Ok(p) => p,
        Err(_) => return false,
    };
    // Probe gui_endpoints.py specifically — it's the most-edited file and
    // a reliable canary for "the bundle changed."
    let bundle_candidates = [
        resource_root.join("_up_").join("gui_endpoints.py"),
        resource_root.join("gui_endpoints.py"),
    ];
    let runtime_path = runtime.join("gui_endpoints.py");
    let runtime_mtime = match fs::metadata(&runtime_path).and_then(|m| m.modified()) {
        Ok(m) => m,
        Err(_) => return true,  // runtime missing — definitely need to extract
    };
    for src in &bundle_candidates {
        if let Ok(meta) = fs::metadata(src) {
            if let Ok(bundle_mtime) = meta.modified() {
                if bundle_mtime > runtime_mtime {
                    return true;
                }
                return false;  // found bundle, it's NOT newer
            }
        }
    }
    false  // no bundle gui_endpoints.py found — odd, but don't force extract
}

pub fn maybe_extract_resources(app: &AppHandle) -> Result<(), String> {
    let runtime = app_runtime_dir(app)?;
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable: {e}"))?;

    fs::create_dir_all(&runtime).map_err(|e| format!("mkdir {runtime:?}: {e}"))?;
    fs::create_dir_all(runtime.join("data")).ok();
    fs::create_dir_all(runtime.join("outputs")).ok();

    let bundled_version = env!("CARGO_PKG_VERSION");
    let stamp = runtime.join(".bundled_version");
    let self_updated = runtime.join(".self-updated");
    // Previously gated re-extraction on the stamp version. That broke
    // every bug fix to the bundled Python: as long as CARGO_PKG_VERSION
    // didn't bump, users running a newer .msi would skip extraction and
    // keep running the OLD local_ai_server.py from the first install.
    // The CORS-middleware fix shipped with the bundle but every user
    // stuck on a pre-CORS extracted copy.
    //
    // Policy: always re-extract on boot, EXCEPT for files the server's
    // /system/self-update endpoint has hot-patched (listed in
    // .self-updated). Without this carve-out, a user who self-updates
    // through the GUI loses the patch on every Tauri restart because
    // the stale bundle clobbers it.
    let _ = installed_version_for_diagnostic(&stamp);
    let skip_list: Vec<String> = match fs::read_to_string(&self_updated) {
        Ok(s) => s.lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(|l| l.trim().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    let should_skip = |rel: &str| -> bool {
        skip_list.iter().any(|p| p == rel)
    };

    // Files to copy from resource_dir → runtime. Mirror tauri.conf.json's
    // bundle.resources list; if you bump that, bump this too.
    //
    // Tauri 2 places resources declared with `../` in tauri.conf.json under
    // a `_up_/` prefix inside resource_dir to keep them sandboxed. So
    // `../local_ai_server.py` lands at `<resource_dir>/_up_/local_ai_server.py`,
    // NOT at `<resource_dir>/local_ai_server.py`. We probe both locations
    // because Tauri 1 (and some configurations of v2) used the flat layout.
    let files = [
        "local_ai_server.py",
        "gui_endpoints.py",
        "warmup_local_cache.py",
        "package.json",
        "requirements-local.txt",
        "requirements-ml.txt",
        ".env.default",
        // scripts/doctor.mjs is run by the Installer's System check step
        // via `node scripts/doctor.mjs`. Without these copied into the
        // runtime dir, the spawn fails with Cannot find module — broke
        // the System check probe in fresh Tauri installs.
        "scripts/doctor.mjs",
        "scripts/preflight.mjs",
        "scripts/smoke_gui_endpoints.py",
    ];
    let mut copied: u32 = 0;
    let mut skipped: u32 = 0;
    for f in files {
        if should_skip(f) {
            skipped += 1;
            continue;
        }
        // Try the Tauri-2-with-../-prefix layout first; fall back to flat.
        let candidates = [
            resource_root.join("_up_").join(f),
            resource_root.join(f),
        ];
        let dst = runtime.join(f);
        // Ensure parent dir exists (e.g. for nested paths like scripts/doctor.mjs).
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        for src in &candidates {
            if src.is_file() {
                fs::copy(src, &dst).map_err(|e| format!("cp {src:?} -> {dst:?}: {e}"))?;
                copied += 1;
                break;
            }
        }
    }

    // gui/ directory — recursive copy. Same `_up_` fallback.
    // copy_dir_skipping respects the skip_list so individual self-updated
    // files (gui/setup-wizard.html, gui/chat.html, …) survive even when
    // the rest of gui/ is re-extracted.
    let gui_candidates = [
        resource_root.join("_up_").join("gui"),
        resource_root.join("gui"),
    ];
    let gui_dst = runtime.join("gui");
    for gui_src in &gui_candidates {
        if gui_src.is_dir() {
            copy_dir_skipping(gui_src, &gui_dst, &skip_list, "gui")?;
            copied += 1;
            break;
        }
    }
    let _ = (copied, skipped);  // silence unused-warning in release

    // If we found nothing, the bundle is malformed (or we're looking in the
    // wrong place). Surface the failure rather than silently writing the
    // stamp — otherwise next boot would skip extraction entirely and pip
    // would fail again with "no such file or directory".
    if copied == 0 {
        return Err(format!(
            "no bundled resources found under {} (or {}/_up_/) — \
             possible Tauri-resources layout change",
            resource_root.display(),
            resource_root.display(),
        ));
    }

    // Seed .env from .env.default if no .env exists yet. The Tweaks panel
    // writes via POST /config, which edits .env in-place — so we just need
    // it to exist with sane defaults.
    let env_dst = runtime.join(".env");
    if !env_dst.exists() {
        let env_default = runtime.join(".env.default");
        if env_default.is_file() {
            fs::copy(&env_default, &env_dst).ok();
        }
    }

    fs::write(&stamp, bundled_version).map_err(|e| format!("write stamp: {e}"))?;
    Ok(())
}

/// Recursive copy that respects a skip-list of paths (relative to the
/// runtime dir, e.g. "gui/setup-wizard.html"). Used during boot-time
/// resource extraction so files the user has hot-patched via the
/// /system/self-update endpoint don't get clobbered by the .msi's
/// stale bundle. `prefix` is the path segment we're inside (e.g.
/// "gui") so per-file skips can be expressed as "gui/foo.html".
fn copy_dir_skipping(src: &Path, dst: &Path, skip: &[String], prefix: &str) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };
        if skip.iter().any(|s| s == &rel) {
            continue;  // hot-patched; leave the runtime copy alone
        }
        if path.is_dir() {
            copy_dir_skipping(&path, &target, skip, &rel)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|e| format!("cp {path:?} -> {target:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Find a Python interpreter we can spawn. Order:
///   1. SEEKDEEP_PYTHON env var (absolute path override — for users with
///      a working venv outside the runtime dir, e.g. the dev `.venv` in
///      the cloned repo. Set in `.env` to point at the same Python the
///      .bat launcher uses, so the GUI sidecar doesn't fall back to a
///      system Python that lacks torch).
///   2. <runtime>/.venv/Scripts/python.exe   (Windows venv extracted by Tauri)
///   3. <runtime>/.venv/bin/python           (Unix venv)
///   4. py.exe -3 (Windows Python launcher; preferred on Windows because
///      the Microsoft Store python.exe stub launches the Store installer
///      instead of starting Python). Walks `py -0p` output to skip
///      versions known to lack PyTorch wheels (3.13+ as of now).
///   5. python3 / python on PATH
///
/// Returns None if we can't find anything usable.
pub fn find_python(runtime: &Path) -> Option<PathBuf> {
    // Honor SEEKDEEP_PYTHON override first. Users hitting the "Python
    // 3.14 detected but no torch" trap (because their .venv lives in
    // the cloned-repo dir, not the Tauri runtime dir) can point this at
    // their working interpreter without us having to guess.
    if let Ok(env_py) = std::env::var("SEEKDEEP_PYTHON") {
        let p = PathBuf::from(env_py.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let venv_candidates = [
        runtime.join(".venv").join("Scripts").join("python.exe"),
        runtime.join(".venv").join("bin").join("python"),
        runtime.join(".venv").join("bin").join("python3"),
    ];
    for c in &venv_candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }

    // Windows: prefer the `py` launcher over a bare `python.exe`. The MS
    // Store ships a 0-byte `python.exe` STUB on every fresh Win10/11
    // install that opens the Store when invoked — `py` skips that stub.
    //
    // BUT: `py -3` returns the HIGHEST-installed Python 3.x. If the user
    // has both 3.14 and 3.11 installed, that's 3.14 — which has no
    // PyTorch wheels yet. So we walk `py -0p` and prefer a torch-
    // compatible version (≤ 3.12 right now) before falling back to
    // whatever `py -3` picks. Matches the max_torch_supported value
    // reported by /system/runtime so the GUI and the sidecar agree on
    // what counts as usable.
    #[cfg(windows)]
    {
        if let Some(p) = py_launcher_prefer_torch_compat() {
            return Some(p);
        }
        // Fallback: bare `py -3` (highest 3.x) — last resort if the
        // walker couldn't parse `py -0p` or found nothing torch-
        // compatible. Better to spawn against 3.14 and let pip / torch
        // surface the clear error than to give up entirely.
        if let Ok(out) = quiet_command_str("py").args(["-3", "--version"]).output() {
            if out.status.success() {
                if let Ok(exec) = quiet_command_str("py")
                    .args(["-3", "-c", "import sys; print(sys.executable)"])
                    .output()
                {
                    if exec.status.success() {
                        let path = String::from_utf8_lossy(&exec.stdout).trim().to_string();
                        if !path.is_empty() {
                            let pb = PathBuf::from(&path);
                            if pb.is_file() && !is_windows_store_stub(&pb) {
                                return Some(pb);
                            }
                        }
                    }
                }
            }
        }
    }

    // Fall back to system Python. We test invocation AND verify the exe
    // isn't the Windows Store stub (which would otherwise pass --version
    // by launching the Store, then exit successfully with empty stdout).
    for name in &["python3", "python"] {
        if let Ok(out) = quiet_command_str(name).arg("--version").output() {
            if out.status.success() {
                // Resolve to actual path so we can stub-check.
                if let Ok(exec) = quiet_command_str(name)
                    .args(["-c", "import sys; print(sys.executable)"])
                    .output()
                {
                    if exec.status.success() {
                        let path = String::from_utf8_lossy(&exec.stdout).trim().to_string();
                        if !path.is_empty() {
                            let pb = PathBuf::from(&path);
                            if pb.is_file() && !is_windows_store_stub(&pb) {
                                return Some(pb);
                            }
                        }
                    }
                }
                // If we couldn't resolve a path, accept the name as-is (the
                // env-resolved PATH lookup will work for the spawn too).
                return Some(PathBuf::from(name));
            }
        }
    }
    None
}

/// The Microsoft Store ships a 0-byte python.exe at
/// %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe on every fresh Win10/11
/// install. Invoking it launches the Store installer instead of starting
/// Python, which is a terrible UX for a sidecar. Detect by path substring.
#[cfg(windows)]
fn is_windows_store_stub(p: &Path) -> bool {
    let s = p.to_string_lossy().to_lowercase().replace('/', "\\");
    s.contains("\\microsoft\\windowsapps\\python")
}

#[cfg(not(windows))]
fn is_windows_store_stub(_p: &Path) -> bool { false }

/// Maximum Python minor version with current PyTorch wheel coverage.
/// Bump this when pytorch.org adds wheels for the next 3.x. Keep in
/// sync with gui_endpoints.py /system/runtime python.max_torch_supported
/// so the GUI and sidecar agree on what counts as torch-compatible.
const MAX_TORCH_PY_MINOR: u32 = 12;

/// Walk `py -0p` output and return the path to the highest-numbered
/// Python ≤ 3.MAX_TORCH_PY_MINOR. None if py launcher isn't installed,
/// no qualifying versions are present, or every parsed entry resolves
/// to the Windows Store stub. This is the layer that fixes the
/// "Python 3.14 default but no torch wheels exist" trap on machines
/// that ALSO have a 3.11 / 3.12 installed alongside 3.14.
///
/// `py -0p` output format (Windows Python launcher 3.x):
///   -V:3.14 *      C:\Users\me\AppData\Local\Programs\Python\Python314\python.exe
///   -V:3.12        C:\Users\me\AppData\Local\Programs\Python\Python312\python.exe
///   -V:3.11        C:\Python311\python.exe
/// We parse `-V:<major>.<minor>` + the path (last whitespace-separated
/// token on the line).
#[cfg(windows)]
fn py_launcher_prefer_torch_compat() -> Option<PathBuf> {
    let out = quiet_command_str("py").args(["-0p"]).output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    // (minor_version, path) pairs for every 3.x entry we can parse.
    let mut candidates: Vec<(u32, PathBuf)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // Want lines that start with -V:3. — skip non-3.x and headers.
        // Use match-continue, not ?, so a line we can't parse doesn't
        // abort the whole walk (e.g. blank lines, header rows).
        let v_idx = match trimmed.find("-V:3.") { Some(i) => i, None => continue };
        let after_v = &trimmed[v_idx + "-V:3.".len()..];
        // Minor version: digits until space, asterisk, or tab.
        let minor_str: String = after_v.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if minor_str.is_empty() { continue; }
        let minor: u32 = match minor_str.parse() { Ok(n) => n, Err(_) => continue };
        if minor > MAX_TORCH_PY_MINOR { continue; }
        // Path: last whitespace-separated chunk that contains "python".
        let path_str = trimmed.split_whitespace()
            .filter(|s| s.to_lowercase().contains("python"))
            .last();
        if let Some(p) = path_str {
            let pb = PathBuf::from(p);
            if pb.is_file() && !is_windows_store_stub(&pb) {
                candidates.push((minor, pb));
            }
        }
    }
    // Highest torch-compatible minor wins (3.12 > 3.11 > 3.10 > ...).
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, p)| p)
}

/// Quick smoke test: does this Python have our minimum boot deps installed?
/// If false, the user needs to run install_python_deps before we can spawn.
///
/// Must match what local_ai_server.py actually imports at module top, NOT a
/// wishlist. httpx used to be in this probe but local_ai_server.py never
/// imports it at boot — including httpx made the probe fail on systems
/// where httpx wasn't installed and triggered a needless pip install loop.
/// fastapi + uvicorn + pydantic + dotenv + PIL is the actual minimum.
pub fn deps_present(python: &Path) -> bool {
    let out = quiet_command(python)
        .arg("-c")
        .arg("import fastapi, uvicorn, pydantic, dotenv, PIL")
        .output();
    matches!(out, Ok(o) if o.status.success())
}

/// Spawn `python local_ai_server.py` with cwd = runtime dir and stdout/stderr
/// redirected to <log_dir>/server.log. Returns the child handle so the caller
/// can store it for shutdown.
///
/// Sets SEEKDEEP_EMIT_LOG_LINES=on in the child env so the bus pumps
/// `log.line` events; that means app.html's logs viewer lights up LIVE
/// instead of falling back to 3s /logs/tail polling. Cheap to enable
/// for the Tauri single-user case (event rate is bounded and the Tauri
/// shell is the only consumer).
pub fn spawn_server(python: &Path, runtime: &Path, log_dir: &Path) -> Result<Child, String> {
    fs::create_dir_all(log_dir).map_err(|e| format!("mkdir {log_dir:?}: {e}"))?;
    let log_path = log_dir.join("server.log");
    let log_file = fs::File::create(&log_path).map_err(|e| format!("create log: {e}"))?;
    let log_clone = log_file.try_clone().map_err(|e| format!("clone log fd: {e}"))?;

    // Fresh-boot flag — set on the FIRST spawn of an app launch only. The
    // Python startup hook reads this and reaps orphan bot processes from
    // a previous user session. Mid-session respawns (ML install, restart,
    // crash watchdog) don't set it so the user's running bot survives.
    let is_fresh_boot = !FIRST_SPAWN_DONE.swap(true, Ordering::SeqCst);

    let mut cmd = quiet_command(python);
    cmd.arg("local_ai_server.py")
        .current_dir(runtime)
        .env("SEEKDEEP_EMIT_LOG_LINES", "on")
        .env("SEEKDEEP_TAURI_SHELL", "1");
    if is_fresh_boot {
        cmd.env("SEEKDEEP_FRESH_BOOT", "1");
    }
    let child = cmd
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_clone))
        .spawn()
        .map_err(|e| format!("spawn python local_ai_server.py: {e}"))?;
    Ok(child)
}

/// Run `python -m pip install -r requirements-local.txt` and capture
/// combined output. Called from the install_python_deps Tauri command
/// when the user clicks "Install Python deps" on the loading screen.
///
/// Flag selection:
///   * `--user` is ONLY safe for system-Python — it puts site-packages
///     in `%APPDATA%\Python\PythonXY\site-packages`. For a venv python
///     it's an error (pip refuses to mix venv + user installs). We
///     detect a venv by looking for `.venv` in the path and drop the
///     flag in that case.
///   * `--no-cache-dir` sidesteps the common "WARNING: Cache entry
///     deserialization failed" failure mode on machines where the pip
///     wheel cache got corrupted. We're installing 7 small wheels;
///     re-fetching each is cheap vs. a mysterious cache-driven fail.
///   * `--disable-pip-version-check` keeps the output clean.
///
/// Output is also written to `<log_dir>/pip.log` (best-effort) so the
/// "View server log" button can surface it even when the loading-page
/// status line truncates the inline display.
pub fn pip_install(python: &Path, runtime: &Path) -> Result<String, String> {
    let req = runtime.join("requirements-local.txt");

    // Venv detection. `.venv` segment anywhere in the python path means
    // we're already inside one; --user would error.
    let py_str = python.to_string_lossy().to_lowercase();
    let in_venv = py_str.contains(".venv") || py_str.contains("/venv/") || py_str.contains("\\venv\\");

    let mut args: Vec<&str> = vec!["-m", "pip", "install", "--upgrade",
                                    "--no-cache-dir", "--disable-pip-version-check", "-r"];
    if !in_venv {
        args.insert(3, "--user");
    }

    let out = quiet_command(python)
        .args(&args)
        .arg(&req)
        .current_dir(runtime)
        .output()
        .map_err(|e| format!("invoke pip: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!(
        "$ {} {} {}\n\n---STDOUT---\n{}\n---STDERR---\n{}\n",
        python.display(),
        args.join(" "),
        req.display(),
        stdout, stderr,
    );

    // Best-effort log dump for the View-server-log button.
    if let Ok(log_dir) = app_log_dir_from_runtime(runtime) {
        let _ = fs::create_dir_all(&log_dir);
        let _ = fs::write(log_dir.join("pip.log"), &combined);
    }

    if !out.status.success() {
        return Err(combined);
    }
    Ok(combined)
}

/// Heavy-deps variant of pip_install. Used by the install_ml_deps Tauri
/// command, which the chat-page banner triggers when the user accepts the
/// "~2 GB ML libraries" install.
///
/// Crucial difference from pip_install: the local AI server may already be
/// RUNNING when this fires (it must, in fact, since the banner appears on
/// chat.html after a successful boot). The server has fastapi/pydantic/etc.
/// imported, and ANY of those getting upgraded mid-flight is fine — but
/// upgrading torch/transformers/diffusers means overwriting .pyd / .py
/// files that Python has open, and on Windows that hard-errors with
/// WinError 32 (process cannot access file because it is being used).
///
/// So we kill the sidecar BEFORE pip runs, then signal the caller to
/// restart it after — both via the SidecarState the lib.rs command holds.
pub fn pip_install_ml(app: &AppHandle, python: &Path, runtime: &Path) -> Result<String, String> {
    use std::io::{BufRead, BufReader};

    let req = runtime.join("requirements-ml.txt");
    let py_str = python.to_string_lossy().to_lowercase();
    let in_venv = py_str.contains(".venv") || py_str.contains("/venv/") || py_str.contains("\\venv\\");

    let mut args: Vec<&str> = vec!["-m", "pip", "install", "--upgrade",
                                    "--no-cache-dir", "--disable-pip-version-check", "-r"];
    if !in_venv {
        args.insert(3, "--user");
    }

    // Spawn pip as a long-lived child, stream stdout/stderr line-by-line
    // and emit each line as a Tauri "ml-install:line" event so the GUI
    // modal can render real-time progress instead of freezing on a
    // 5-10 minute .output() wait. Previous .output() implementation
    // caused the Tauri main window to show "Not Responding" and the
    // user to wonder if the install had crashed.
    let mut child = quiet_command(python)
        .args(&args)
        .arg(&req)
        .current_dir(runtime)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("invoke pip: {e}"))?;

    let cmdline = format!("$ {} {} {}\n", python.display(), args.join(" "), req.display());
    let _ = app.emit("ml-install:line", serde_json::json!({"line": cmdline.trim_end()}));

    // Reader threads — one each for stdout/stderr. Each line gets
    // emitted to the GUI immediately and accumulated into a buffer
    // we return at the end.
    let stdout_handle = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_handle = child.stderr.take().ok_or("no stderr pipe")?;

    let app_out = app.clone();
    let stdout_thread = std::thread::spawn(move || {
        let mut lines: Vec<String> = Vec::new();
        let reader = BufReader::new(stdout_handle);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_out.emit("ml-install:line", serde_json::json!({"line": &line}));
            lines.push(line);
        }
        lines.join("\n")
    });
    let app_err = app.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut lines: Vec<String> = Vec::new();
        let reader = BufReader::new(stderr_handle);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_err.emit("ml-install:line", serde_json::json!({"line": &line, "stream": "err"}));
            lines.push(line);
        }
        lines.join("\n")
    });

    let status = child.wait().map_err(|e| format!("wait pip: {e}"))?;
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let combined = format!(
        "{}\n---STDOUT---\n{}\n---STDERR---\n{}\n",
        cmdline.trim_end(), stdout, stderr,
    );

    // Final exit notification so the GUI knows we're done before the
    // tauri::command Promise resolves (gives a smoother UX than
    // waiting for the await to return).
    let _ = app.emit("ml-install:done", serde_json::json!({
        "ok": status.success(),
        "exit_code": status.code(),
    }));

    if let Ok(log_dir) = app_log_dir_from_runtime(runtime) {
        let _ = fs::create_dir_all(&log_dir);
        let _ = fs::write(log_dir.join("pip-ml.log"), &combined);
    }

    if !status.success() {
        return Err(combined);
    }
    Ok(combined)
}

/// Reinstall torch + torchvision + torchaudio against a specific CUDA
/// variant (cu118, cu121, cu124, cu126, cu128, or cpu). Used by the
/// "wrong wheel" Fix button when the loaded torch wheel doesn't match
/// the user's GPU architecture — most commonly an RTX 50-series
/// (Blackwell) where a cu121 wheel installed by setup_local.ps1 can't
/// see the GPU.
///
/// Pip's torch wheels live behind variant-specific index URLs:
///   https://download.pytorch.org/whl/cu118
///   https://download.pytorch.org/whl/cu121
///   https://download.pytorch.org/whl/cu124
///   https://download.pytorch.org/whl/cu126
///   https://download.pytorch.org/whl/cu128
///   https://download.pytorch.org/whl/cpu
///
/// Same kill-then-install-then-respawn dance as pip_install_ml — torch
/// .pyd files lock on Windows when imported, so the sidecar MUST be
/// down before pip runs. Caller (lib.rs install_torch_variant) handles
/// that.
pub fn pip_install_torch_variant(
    app: &AppHandle,
    python: &Path,
    runtime: &Path,
    variant: &str,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};

    let v = variant.trim().to_lowercase();
    let allowed = ["cu118", "cu121", "cu124", "cu126", "cu128", "cpu"];
    if !allowed.contains(&v.as_str()) {
        return Err(format!(
            "unknown cuda variant {v:?}; allowed: {}", allowed.join(", ")
        ));
    }
    let index_url = format!("https://download.pytorch.org/whl/{}", v);

    let py_str = python.to_string_lossy().to_lowercase();
    let in_venv = py_str.contains(".venv") || py_str.contains("/venv/") || py_str.contains("\\venv\\");

    // Stream uninstall + install lines to the GUI via ml-install:line
    // events, same channel as pip_install_ml. The user gets live
    // feedback instead of a 5-minute "frozen" wait.
    let _ = app.emit("ml-install:line", serde_json::json!({"line": format!("▸ Reinstalling torch with {} ...", v)}));

    // First: explicitly uninstall the existing torch trio so pip --upgrade
    // doesn't get confused about which wheel arch to resolve against.
    let _ = quiet_command(python)
        .args(["-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio"])
        .current_dir(runtime)
        .output();
    let _ = app.emit("ml-install:line", serde_json::json!({"line": "✓ uninstalled previous torch / torchvision / torchaudio"}));

    // Second: install with the variant-specific index URL, streamed.
    let mut args: Vec<&str> = vec![
        "-m", "pip", "install",
        "--upgrade", "--no-cache-dir", "--disable-pip-version-check",
        "torch", "torchvision", "torchaudio",
        "--index-url", &index_url,
    ];
    if !in_venv {
        args.insert(3, "--user");
    }

    let mut child = quiet_command(python)
        .args(&args)
        .current_dir(runtime)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("invoke pip: {e}"))?;

    let stdout_handle = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_handle = child.stderr.take().ok_or("no stderr pipe")?;

    let app_out = app.clone();
    let stdout_thread = std::thread::spawn(move || {
        let mut lines: Vec<String> = Vec::new();
        let reader = BufReader::new(stdout_handle);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_out.emit("ml-install:line", serde_json::json!({"line": &line}));
            lines.push(line);
        }
        lines.join("\n")
    });
    let app_err = app.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut lines: Vec<String> = Vec::new();
        let reader = BufReader::new(stderr_handle);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_err.emit("ml-install:line", serde_json::json!({"line": &line, "stream": "err"}));
            lines.push(line);
        }
        lines.join("\n")
    });

    let status = child.wait().map_err(|e| format!("wait pip: {e}"))?;
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let combined = format!(
        "$ {} {}\n\n---STDOUT---\n{}\n---STDERR---\n{}\n",
        python.display(), args.join(" "), stdout, stderr,
    );
    let _ = app.emit("ml-install:done", serde_json::json!({
        "ok": status.success(), "exit_code": status.code(),
    }));

    if let Ok(log_dir) = app_log_dir_from_runtime(runtime) {
        let _ = fs::create_dir_all(&log_dir);
        let _ = fs::write(log_dir.join("pip-torch.log"), &combined);
    }
    if !status.success() {
        return Err(combined);
    }
    Ok(combined)
}

/// Best-effort: derive a log dir relative to the runtime dir. Used by
/// pip_install which doesn't have the AppHandle in scope. Logs go UNDER
/// the runtime dir (matching app_log_dir) so the viewer can read them.
fn app_log_dir_from_runtime(runtime: &Path) -> Result<PathBuf, String> {
    Ok(runtime.join("logs"))
}

/// Status codes pushed to the loading page via the sidecar:status event.
/// One word, machine-parseable; the frontend translates to user-facing copy.
pub fn emit_status(app: &AppHandle, code: &str) {
    let _ = app.emit("sidecar:status", serde_json::json!({ "code": code }));
}

/// Best-effort kill of the held child. Called on window-close / app-exit /
/// tray Restart / install_python_deps wrap-up. Sets `intentional_kill` so
/// the crash-recovery watchdog knows not to respawn — only unexpected
/// exits trigger auto-respawn.
pub fn kill_child(state: &SidecarState) {
    if let Ok(mut g) = state.intentional_kill.lock() {
        *g = true;
    }
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Crash-recovery watchdog: polls the held child every 3 s. When it sees the
/// child has exited AND the exit wasn't `intentional_kill`d, it triggers a
/// fresh boot_sequence with exponential backoff (1 s → 2 s → 4 s → 8 s …
/// capped at 30 s) up to MAX_RESPAWN_ATTEMPTS consecutive crashes. After
/// MAX_RESPAWN_ATTEMPTS, gives up and emits `CRASH_GAVE_UP` so the loading
/// overlay surfaces the dead state.
///
/// The attempt counter is held in `respawn_attempts` and decremented to 0
/// every HEALTHY_RESET_SEC seconds the server stays alive — so a one-off
/// crash doesn't poison the budget for the rest of the session.
///
/// Started by `boot_sequence` after every successful spawn. Self-terminates
/// once it triggers a respawn (the new boot_sequence starts a fresh
/// watchdog). Also self-terminates when quit_requested flips.
const MAX_RESPAWN_ATTEMPTS: u32 = 5;
const POLL_INTERVAL_SEC: u64 = 3;
const HEALTHY_RESET_SEC: u64 = 120;

pub fn start_crash_watchdog(app: AppHandle) {
    // Snapshot the generation we're watching at start. If boot_sequence
    // bumps the generation later (a fresh child was spawned), this watchdog
    // is stale and exits next tick — the new spawn started its own watchdog.
    let my_generation = {
        let state = app.state::<SidecarState>();
        state.watchdog_generation.load(Ordering::SeqCst)
    };
    std::thread::spawn(move || {
        let mut alive_secs: u64 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SEC));

            let state = app.state::<SidecarState>();
            // App-shutdown gate
            let quit = state.quit_requested.lock().map(|g| *g).unwrap_or(false);
            if quit { return; }

            // Generation gate: a newer spawn → newer watchdog → we retire.
            if state.watchdog_generation.load(Ordering::SeqCst) != my_generation {
                return;
            }

            // Check child status. Three relevant cases:
            //   1. handle is None → kill_child took it (or never spawned)
            //   2. try_wait Ok(None) → still running
            //   3. try_wait Ok(Some(_)) or Err → exited / unreachable
            let exited = {
                let mut guard = match state.child.lock() {
                    Ok(g) => g,
                    Err(_) => return, // poisoned mutex; bail
                };
                match guard.as_mut() {
                    None => true,
                    Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
                }
            };

            if !exited {
                // Still alive. Bump the alive counter and reset attempts if
                // we've been healthy for HEALTHY_RESET_SEC.
                alive_secs += POLL_INTERVAL_SEC;
                if alive_secs >= HEALTHY_RESET_SEC {
                    if let Ok(mut g) = state.respawn_attempts.lock() { *g = 0; }
                    alive_secs = 0;
                }
                continue;
            }

            // Child exited. Was it intentional?
            let intentional = {
                let mut g = match state.intentional_kill.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let prev = *g;
                *g = false; // consume the flag
                prev
            };
            if intentional {
                // User-initiated kill. boot_sequence will start a new
                // watchdog if/when a fresh spawn happens. We're done.
                return;
            }

            // Unexpected exit. Bump the attempt counter; bail if over budget.
            let attempts = {
                let mut g = match state.respawn_attempts.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                *g += 1;
                *g
            };
            if attempts > MAX_RESPAWN_ATTEMPTS {
                emit_status(&app, "CRASH_GAVE_UP");
                return;
            }

            // Clear the dead child handle so boot_sequence's spawn populates
            // a fresh one.
            if let Ok(mut g) = state.child.lock() { *g = None; }

            // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
            let backoff_ms = (1u64 << (attempts - 1).min(5)).saturating_mul(1000).min(30_000);
            emit_status(&app, "CHILD_CRASH_RESPAWNING");
            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));

            // Re-enter boot_sequence; it will start its own watchdog on
            // success. We exit here so we don't double-watch.
            boot_sequence(app.clone());
            return;
        }
    });
}

/// The top-level boot sequence — called from setup() in lib.rs.
///
/// Runs in a background thread so the app window can render the loading.html
/// page while we do the slow stuff (find python, pip install, spawn server).
pub fn boot_sequence(app: AppHandle) {
    let state = app.state::<SidecarState>();

    // Concurrent-boot guard. Two real callers race here:
    //   1. user clicks Restart while a previous restart is mid-flight
    //   2. crash watchdog fires boot_sequence at the same time restart_sidecar
    //      runs from the tray menu
    // Without this, both spawn a child, both try to bind 7865, the loser
    // emits "Application shutdown complete" — looks like a crash, watchdog
    // counts an attempt, exponential-backoff restart, repeat. That's the
    // cascade the 11:43-11:53 boot log showed. CAS keeps it to one in-flight
    // spawn at a time; concurrent callers no-op.
    if state.boot_in_progress.swap(true, Ordering::SeqCst) {
        return;
    }
    // RAII guard so every exit path (early return on PYTHON_NOT_FOUND,
    // PORT_OCCUPIED_BY_UNKNOWN, EXTRACT_FAILED, etc.) clears the flag.
    struct BootGuard<'a>(&'a AtomicBool);
    impl<'a> Drop for BootGuard<'a> {
        fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
    }
    let _guard = BootGuard(&state.boot_in_progress);

    // Stale-server guard. Previously this was a raw TCP probe — "if :7865
    // accepts a connection, assume it's our server and reuse it". That
    // caused the painful "I installed v10.35.3 but the title bar still
    // shows v10.35.0" loop: a SeekDeep server from a prior install was
    // still running, we attached to it, never extracted the new code,
    // and the user saw the old GUI forever.
    //
    // New behavior:
    //   1. Ask whatever's on :7865 for /health and parse its version.
    //   2. If version matches CARGO_PKG_VERSION → reuse (this exact app
    //      is already running, e.g. user double-clicked the tray icon).
    //   3. If version doesn't match → it's a prior install. Kill it,
    //      fall through to extract + spawn the new one.
    //   4. If port is bound but /health doesn't speak SeekDeep → refuse
    //      to clobber. Some unrelated process owns the port.
    let our_version = env!("CARGO_PKG_VERSION");
    // If the bundle in resource_dir is NEWER than the extracted runtime,
    // a fresh MSI was just installed over a running same-version SeekDeep.
    // The old extraction is stale; we must kill the running server and
    // re-extract or the bundled fixes never reach the user. This bypass
    // is the fix for the 2026-05-27 deadlock where reinstalling the SFS-
    // fix nightly didn't help because the version string hadn't bumped.
    let bundle_is_fresh = bundle_is_newer_than_runtime(&app);
    // If a fresh MSI bundle is sitting in resource_dir but a stale server
    // is still on :7865, that server is running the OLD extracted code.
    // Kill it before extraction so the new server spawns against the
    // freshly-extracted files.
    if server_already_listening() && bundle_is_fresh {
        let _ = app.emit(
            "sidecar:status",
            serde_json::json!({
                "code": "STALE_SERVER_REPLACED",
                "detail": "newer bundle detected; killing existing :7865 server to load fresh code",
            }),
        );
        kill_listener_on_7865();
        std::thread::sleep(Duration::from_millis(800));
    }
    if server_already_listening() && !bundle_is_fresh {
        match server_identity() {
            Some(remote_version) if remote_version == our_version => {
                // ALWAYS-FRESH-ON-LAUNCH: previously we'd reuse the existing
                // sidecar when versions matched (emit EXTERNAL_SERVER_RUNNING
                // and return). That's a trap: if the user `pip install`s a
                // new ML dep (e.g. tiktoken) while the server is running,
                // then relaunches Tauri, the running interpreter still has
                // the old `sys.modules` snapshot — no tiktoken import — and
                // the next /chat 503s with tokenizer-load-failure. They had
                // to manually click Restart on the AI server card to fix.
                //
                // Now: every Tauri launch kills the existing sidecar and
                // respawns it. Fresh Python interpreter, fresh module
                // imports, picks up any newly-installed deps automatically.
                // The cost is ~2s of respawn time on every launch; the
                // benefit is "I installed X, restart the app, it just works."
                //
                // Opt out via SEEKDEEP_TAURI_REUSE_SIDECAR=1 in .env if you
                // have a long-running session with hot models you don't want
                // to lose on app relaunch.
                let reuse_env = std::env::var("SEEKDEEP_TAURI_REUSE_SIDECAR")
                    .ok()
                    .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                    .unwrap_or(false);
                if reuse_env {
                    emit_status(&app, "EXTERNAL_SERVER_RUNNING");
                    return;
                }
                let _ = app.emit(
                    "sidecar:status",
                    serde_json::json!({
                        "code": "FRESH_BOOT_RESPAWN",
                        "detail": format!(
                            "matched-version sidecar on :7865 (v{remote_version}); killing it for a clean-Python respawn so newly-installed pip deps load. Set SEEKDEEP_TAURI_REUSE_SIDECAR=1 in .env to skip this."
                        ),
                    }),
                );
                kill_listener_on_7865();
                std::thread::sleep(Duration::from_millis(800));
            }
            Some(remote_version) => {
                let detail = format!(
                    "stale SeekDeep server on :7865 reports v{remote_version}; this app is v{our_version}. Killing the stale process and respawning fresh."
                );
                let _ = app.emit(
                    "sidecar:status",
                    serde_json::json!({ "code": "STALE_SERVER_REPLACED", "detail": detail }),
                );
                kill_listener_on_7865();
                // Give Windows a moment to actually release the port
                // before uvicorn tries to bind it below.
                std::thread::sleep(Duration::from_millis(800));
            }
            None => {
                // Port is bound but whoever's there isn't speaking
                // SeekDeep /health. Refuse to clobber a stranger.
                emit_status(&app, "PORT_OCCUPIED_BY_UNKNOWN");
                let _ = app.emit(
                    "sidecar:status",
                    serde_json::json!({
                        "code": "PORT_OCCUPIED_BY_UNKNOWN",
                        "detail": "127.0.0.1:7865 is bound by a non-SeekDeep process; refusing to take the port. Quit whatever's listening and retry.",
                    }),
                );
                return;
            }
        }
    }

    if let Err(e) = maybe_extract_resources(&app) {
        emit_status(&app, "EXTRACT_FAILED");
        let _ = app.emit(
            "sidecar:status",
            serde_json::json!({ "code": "EXTRACT_FAILED", "detail": e }),
        );
        return;
    }

    let runtime = match app_runtime_dir(&app) {
        Ok(p) => p,
        Err(_) => {
            emit_status(&app, "RUNTIME_DIR_UNAVAILABLE");
            return;
        }
    };

    let python = match find_python(&runtime) {
        Some(p) => p,
        None => {
            emit_status(&app, "PYTHON_NOT_FOUND");
            return;
        }
    };

    if !deps_present(&python) {
        emit_status(&app, "DEPS_MISSING");
        return;
    }

    // Write logs to <runtime>/logs/ (not %APPDATA%/SeekDeep/logs/) so they
    // sit in the same directory gui_endpoints' /logs/tail scans. Previously
    // these diverged: stdout went to %APPDATA%/SeekDeep/logs/server.log while
    // the viewer read from %APPDATA%/SeekDeep/app/logs/, so the Control
    // Center said "no log file found" even though stdout was being captured.
    let log_dir = runtime.join("logs");

    match spawn_server(&python, &runtime, &log_dir) {
        Ok(child) => {
            if let Ok(mut guard) = state.child.lock() {
                *guard = Some(child);
            }
            // Bump the generation BEFORE starting the new watchdog so the
            // old watchdog (if still polling) reads the new value and
            // retires next tick. The new watchdog snapshots at start_crash
            // _watchdog and gets the post-bump value.
            state.watchdog_generation.fetch_add(1, Ordering::SeqCst);
            emit_status(&app, "SPAWNING");
            start_crash_watchdog(app.clone());
        }
        Err(_e) => {
            emit_status(&app, "SPAWN_FAILED");
        }
    }
}

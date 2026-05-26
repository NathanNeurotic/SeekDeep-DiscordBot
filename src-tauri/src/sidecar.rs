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
use std::time::Duration;

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
}

/// Probe 127.0.0.1:7865 with a short connect timeout. True = the AI server
/// (or some other listener on that port) is already up; we should NOT spawn.
pub fn server_already_listening() -> bool {
    let addr = "127.0.0.1:7865".parse().expect("hardcoded loopback addr");
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Resolve where extracted-on-first-run files live. We use Tauri's
/// app_data_dir + "/app" so the directory layout is:
///   %APPDATA%/SeekDeep/app/local_ai_server.py
///   %APPDATA%/SeekDeep/app/gui/...
///   %APPDATA%/SeekDeep/logs/server.log
pub fn app_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(data.join("app"))
}

pub fn app_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(data.join("logs"))
}

/// Copy bundled resources to app_data_dir/app on first run or version mismatch.
/// The version stamp file (`.bundled_version`) is what we use to decide
/// whether the extracted copy is stale; on every new release the bundled
/// version bumps and we re-extract over the top.
///
/// We deliberately copy file-by-file (not recursive blat) so the user's
/// gitignored data/ + logs/ + outputs/ subdirs aren't wiped on update.
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
    let installed = fs::read_to_string(&stamp).unwrap_or_default();
    if installed.trim() == bundled_version {
        // Already extracted at this version — nothing to do.
        return Ok(());
    }

    // Files to copy from resource_dir → runtime. Mirror tauri.conf.json's
    // bundle.resources list; if you bump that, bump this too.
    let files = [
        "local_ai_server.py",
        "gui_endpoints.py",
        "warmup_local_cache.py",
        "package.json",
        "requirements-local.txt",
        "requirements-ml.txt",
        ".env.default",
    ];
    for f in files {
        let src = resource_root.join(f);
        let dst = runtime.join(f);
        if src.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("cp {src:?} -> {dst:?}: {e}"))?;
        }
    }

    // gui/ directory — recursive copy.
    let gui_src = resource_root.join("gui");
    let gui_dst = runtime.join("gui");
    if gui_src.is_dir() {
        copy_dir(&gui_src, &gui_dst)?;
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

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|e| format!("cp {path:?} -> {target:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Find a Python interpreter we can spawn. Order:
///   1. <runtime>/.venv/Scripts/python.exe   (Windows venv)
///   2. <runtime>/.venv/bin/python           (Unix venv)
///   3. py.exe -3 (Windows Python launcher; preferred on Windows because
///      the Microsoft Store python.exe stub launches the Store installer
///      instead of starting Python)
///   4. python3 / python on PATH
///
/// Returns None if we can't find anything usable.
pub fn find_python(runtime: &Path) -> Option<PathBuf> {
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

    // Windows: prefer the `py` launcher with -3 over a bare `python.exe`.
    // The Microsoft Store ships a 0-byte `python.exe` STUB on every fresh
    // Windows 10/11 install that opens the Store when invoked. `py -3`
    // skips that stub and finds a real Python 3.x installation.
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("py").args(["-3", "--version"]).output() {
            if out.status.success() {
                // Resolve to the actual python.exe path so spawn_server can
                // pass it directly. `py -3 -c "import sys; print(sys.executable)"`
                // returns the real interpreter.
                if let Ok(exec) = Command::new("py")
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
        if let Ok(out) = Command::new(name).arg("--version").output() {
            if out.status.success() {
                // Resolve to actual path so we can stub-check.
                if let Ok(exec) = Command::new(name)
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

/// Quick smoke test: does this Python have our minimum boot deps installed?
/// If false, the user needs to run install_python_deps before we can spawn.
pub fn deps_present(python: &Path) -> bool {
    let out = Command::new(python)
        .arg("-c")
        .arg("import fastapi, uvicorn, httpx, pydantic")
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

    let child = Command::new(python)
        .arg("local_ai_server.py")
        .current_dir(runtime)
        .env("SEEKDEEP_EMIT_LOG_LINES", "on")
        .env("SEEKDEEP_TAURI_SHELL", "1")
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_clone))
        .spawn()
        .map_err(|e| format!("spawn python local_ai_server.py: {e}"))?;
    Ok(child)
}

/// Run `python -m pip install --user -r requirements-local.txt` synchronously
/// and capture combined output. Called from the install_python_deps command
/// when the user clicks "Install Python deps" on the loading screen.
///
/// We use --user so the install doesn't need admin / sudo. The deps go to the
/// user's site-packages which is shared across all SeekDeep invocations on
/// this machine (a feature, not a bug).
pub fn pip_install(python: &Path, runtime: &Path) -> Result<String, String> {
    let req = runtime.join("requirements-local.txt");
    let out = Command::new(python)
        .args([
            "-m",
            "pip",
            "install",
            "--user",
            "--upgrade",
            "-r",
        ])
        .arg(&req)
        .current_dir(runtime)
        .output()
        .map_err(|e| format!("invoke pip: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("---STDOUT---\n{stdout}\n---STDERR---\n{stderr}");
    if !out.status.success() {
        return Err(format!("pip install failed (exit {}): {combined}", out.status));
    }
    Ok(combined)
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
    std::thread::spawn(move || {
        let mut alive_secs: u64 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SEC));

            let state = app.state::<SidecarState>();
            // App-shutdown gate
            let quit = state.quit_requested.lock().map(|g| *g).unwrap_or(false);
            if quit { return; }

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
    if server_already_listening() {
        emit_status(&app, "EXTERNAL_SERVER_RUNNING");
        return;
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

    let log_dir = match app_log_dir(&app) {
        Ok(p) => p,
        Err(_) => runtime.join("logs"),
    };

    match spawn_server(&python, &runtime, &log_dir) {
        Ok(child) => {
            if let Ok(mut guard) = state.child.lock() {
                *guard = Some(child);
            }
            emit_status(&app, "SPAWNING");
            // Watch for unexpected exits and respawn with backoff.
            start_crash_watchdog(app.clone());
        }
        Err(_e) => {
            emit_status(&app, "SPAWN_FAILED");
        }
    }
}

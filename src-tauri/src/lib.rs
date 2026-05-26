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
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

use sidecar::SidecarState;

#[tauri::command]
fn install_python_deps(app: tauri::AppHandle) -> Result<String, String> {
    let runtime = sidecar::app_runtime_dir(&app)?;
    let python = sidecar::find_python(&runtime).ok_or("PYTHON_NOT_FOUND".to_string())?;
    sidecar::pip_install(&python, &runtime)
}

#[tauri::command]
fn retry_spawn(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    thread::spawn(move || {
        sidecar::boot_sequence(handle);
    });
    Ok(())
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("open_url: {e}"))
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
    let out = std::process::Command::new("curl")
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
    // Naive semver compare — current/latest are both "X.Y.Z" so str cmp
    // works in 99% of cases. The "nightly" tag (no version, no .) is
    // skipped explicitly.
    let update_available = !latest_tag.is_empty()
        && latest_tag != "nightly"
        && latest_tag != current
        && latest_tag > current.as_str();
    Ok(serde_json::json!({
        "current": current,
        "latest": latest_tag,
        "update_available": update_available,
        "release_url": release_url,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            install_python_deps,
            retry_spawn,
            open_external,
            restart_sidecar,
            check_for_update,
        ])
        .setup(|app| {
            // --- System tray ---------------------------------------------
            // Build the tray icon + menu. Close-to-tray means SeekDeep can
            // keep serving the Discord bot in the background while the main
            // window is hidden. The tray menu is the ONLY way to actually
            // exit (sets quit_requested → window close handler kills child).
            let show_item = MenuItem::with_id(app, "show", "Show SeekDeep", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide window", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart_server", "Restart AI server", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit SeekDeep", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &restart_item, &quit_item])?;

            TrayIconBuilder::with_id("seekdeep-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SeekDeep")
                .menu(&menu)
                .menu_on_left_click(false)
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
                    "quit" => {
                        // Set the quit-requested flag so the next CloseRequested
                        // event actually exits instead of hiding. Then trigger
                        // a close on the main window.
                        let state = app.state::<SidecarState>();
                        if let Ok(mut g) = state.quit_requested.lock() {
                            *g = true;
                        }
                        sidecar::kill_child(state.inner());
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
                // Close-to-tray vs actually-quit. If the tray "Quit" item set
                // quit_requested, fall through to the default close (which
                // then triggers RunEvent::Exit + kill_child below). Otherwise
                // intercept the close and hide the window so the AI server
                // keeps serving the Discord bot in the background.
                let state = app.state::<SidecarState>();
                let quitting = state.quit_requested.lock().map(|g| *g).unwrap_or(false);
                if !quitting {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                } else {
                    sidecar::kill_child(state.inner());
                }
            }
            RunEvent::Exit => {
                // Belt-and-suspenders kill on full app exit. kill_child is
                // idempotent; the inner Option clears on first call.
                let state = app.state::<SidecarState>();
                sidecar::kill_child(state.inner());
            }
            _ => {}
        });
}

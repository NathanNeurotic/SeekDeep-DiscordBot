// SeekDeep Tauri shell library entry point.
//
// Tauri's mobile-compat convention is to put the actual builder logic
// in a lib.rs (so iOS/Android can call into the same code path) and
// have main.rs just call lib::run().
//
// v2 — auto-spawn local_ai_server.py as a sidecar process. See sidecar.rs
// for the boot sequence (probe :7865, extract bundled resources, find python,
// spawn server, kill child on close). The loading.html page is the initial
// window URL; it polls /health and redirects to chat.html once the server is up.

mod sidecar;

use std::thread;
use tauri::{Manager, RunEvent, WindowEvent};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            install_python_deps,
            retry_spawn,
            open_external,
        ])
        .setup(|app| {
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
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                // User closed the main window — kill the spawned Python child
                // so it doesn't keep listening on 7865 in the background.
                let state = app.state::<SidecarState>();
                sidecar::kill_child(state.inner());
            }
            RunEvent::Exit => {
                // Belt-and-suspenders kill on full app exit too. kill_child
                // is idempotent; the inner Option clears on first call.
                let state = app.state::<SidecarState>();
                sidecar::kill_child(state.inner());
            }
            _ => {}
        });
}

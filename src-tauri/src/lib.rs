// SeekDeep Tauri shell library entry point.
//
// Tauri's mobile-compat convention is to put the actual builder logic
// in a lib.rs (so iOS/Android can call into the same code path) and
// have main.rs just call lib::run().

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            // Future: spawn local_ai_server.py sidecar here.
            // For v1, the WebView assumes the server is already running
            // at 127.0.0.1:7865.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SeekDeep");
}

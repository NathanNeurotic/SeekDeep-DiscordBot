// SeekDeep desktop shell — Tauri 2 wrapper around the existing browser GUI.
//
// v2: auto-spawn local_ai_server.py from the user's system Python (or an
// adjacent .venv) when the .exe launches; kill the child on window-close.
// Configuration via the in-app Tweaks panel — no external setup_local.ps1
// ritual required. See src/sidecar.rs for the boot sequence + src/lib.rs
// for the Tauri command surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    seekdeep_lib::run()
}

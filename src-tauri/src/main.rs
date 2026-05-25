// SeekDeep desktop shell — Tauri 2 wrapper around the existing browser GUI.
//
// v1 (this commit): opens a native window pointed at the local AI server's
// GUI mount (http://127.0.0.1:7865/gui/chat.html). The server itself is
// NOT yet launched as a sidecar — the user runs `seekdeep_standalone_launcher.bat`
// first. That keeps this commit small + verifiable.
//
// v2 (next commit): auto-spawn local_ai_server.py as a sidecar process
// on app start, kill it on app close. System tray. First-run env check.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    seekdeep_lib::run()
}

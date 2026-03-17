use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// The fixed WebSocket port the Python sidecar listens on.
const WS_PORT: u16 = 44321;

/// Expose the WS port to the frontend so api.ts knows where to connect.
#[tauri::command]
fn get_ws_port() -> u16 {
    WS_PORT
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Launch Python backend sidecar
            let sidecar = app
                .shell()
                .sidecar("agent-with-u-backend")
                .expect("sidecar not found — run `python -m src.ws_main` manually in dev mode");

            let (_rx, _child) = sidecar.spawn().expect("failed to spawn sidecar");

            // Keep child alive for the app lifetime (stored in app state if needed)
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_ws_port])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

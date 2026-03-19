use tauri_plugin_shell::ShellExt;

const WS_PORT: u16 = 44321;

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
            // Release builds only: spawn the compiled Python sidecar automatically.
            // In dev mode (cargo tauri dev), start Python manually:
            //   python -m src.ws_main
            #[cfg(not(debug_assertions))]
            {
                match app.shell().sidecar("agent-with-u-backend") {
                    Ok(sidecar) => {
                        let _ = sidecar.spawn();
                    }
                    Err(e) => {
                        eprintln!("[tauri] sidecar spawn failed: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_ws_port])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

const WS_PORT: u16 = 44321;

#[tauri::command]
fn get_ws_port() -> u16 {
    WS_PORT
}

#[tauri::command]
fn open_log_viewer(_app: tauri::AppHandle) -> Result<(), String> {
    // 获取日志文件路径
    let log_path = if cfg!(target_os = "windows") {
        let app_data = std::env::var("APPDATA").unwrap_or_else(|_| {
            dirs::data_local_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
                .to_string_lossy()
                .to_string()
        });
        format!("{}\\AgentWithU\\logs\\backend.log", app_data)
    } else {
        let home = dirs::home_dir().unwrap_or_default();
        format!("{}/.agent-with-u/logs/backend.log", home.to_string_lossy())
    };

    // 在外部窗口打开日志文件
    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 PowerShell 的 Get-Content -Wait 实现 tail -f 效果
        // 设置 OutputEncoding 为 UTF8 避免中文乱码
        let ps_command = format!(
            "$OutputEncoding = [System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content '{}' -Wait -Tail 50 -Encoding UTF8",
            log_path
        );
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "AgentWithU Logs", "powershell", "-NoExit", "-Command"])
            .arg(&ps_command)
            .spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(["-a", "Terminal", "tail", "-f", &log_path])
            .spawn();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("gnome-terminal")
            .args(["--", "bash", "-c", &format!("tail -f {}", log_path)])
            .spawn()
            .or_else(|_| {
                std::process::Command::new("xterm")
                    .args(["-e", "tail", "-f", &log_path])
                    .spawn()
            });
    }

    Ok(())
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
                use tauri_plugin_shell::ShellExt;
                match app.shell().sidecar("agent-with-u-backend") {
                    Ok(sidecar) => {
                        sidecar.spawn().ok();
                    }
                    Err(e) => {
                        eprintln!("[tauri] sidecar spawn failed: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_ws_port, open_log_viewer])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const WS_PORT: u16 = 44321;

#[tauri::command]
fn get_ws_port() -> u16 {
    WS_PORT
}

/// 桌面端本机角色配置。
///
/// C–C/S 架构里同一个 Tauri 应用可以扮演两种角色：
///   executor — 本机运行执行节点(spawn ws_main sidecar)，可选发布到中继；
///   client   — 只作 UI，不在本机运行执行节点，经中继连接其它执行节点。
///
/// 持久化在 ~/.agent-with-u/desktop.json，由前端「连接」面板读写，
/// Rust 在启动时读取以决定是否 spawn sidecar、以及透传哪些中继参数。
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct DesktopConfig {
    mode: String,
    relay_url: String,
    relay_token: String,
    device_name: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig {
            mode: "executor".to_string(),
            relay_url: String::new(),
            relay_token: String::new(),
            device_name: String::new(),
        }
    }
}

fn desktop_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-with-u").join("desktop.json"))
}

fn load_desktop_config() -> DesktopConfig {
    let mut cfg: DesktopConfig = desktop_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if cfg.mode.trim().is_empty() {
        cfg.mode = "executor".to_string();
    }
    cfg
}

#[tauri::command]
fn get_desktop_config() -> DesktopConfig {
    load_desktop_config()
}

#[tauri::command]
fn set_desktop_config(config: DesktopConfig) -> Result<(), String> {
    let path = desktop_config_path().ok_or("cannot resolve home dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
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
                let cfg = load_desktop_config();
                if cfg.mode == "client" {
                    // 纯客户端模式：不在本机运行执行节点，UI 经中继连接其它节点。
                    eprintln!("[tauri] client mode: backend sidecar not spawned");
                } else {
                    match app.shell().sidecar("agent-with-u-backend") {
                        Ok(mut sidecar) => {
                            // 执行节点模式：若配置了中继，透传中继参数给 sidecar，
                            // 让本机执行节点拨出注册到中继，供远程 UI 经中继访问。
                            let relay_url = cfg.relay_url.trim();
                            let relay_token = cfg.relay_token.trim();
                            if !relay_url.is_empty() && !relay_token.is_empty() {
                                sidecar = sidecar
                                    .env("AGENT_WITH_U_RELAY_URL", relay_url)
                                    .env("AGENT_WITH_U_RELAY_TOKEN", relay_token);
                                let device_name = cfg.device_name.trim();
                                if !device_name.is_empty() {
                                    sidecar =
                                        sidecar.env("AGENT_WITH_U_DEVICE_NAME", device_name);
                                }
                            }
                            sidecar.spawn().ok();
                        }
                        Err(e) => {
                            eprintln!("[tauri] sidecar spawn failed: {e}");
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_ws_port,
            open_log_viewer,
            get_desktop_config,
            set_desktop_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

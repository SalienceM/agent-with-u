use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
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

/// 调起系统截图工具,让用户选区域。
///
/// 各平台行为:
///   Windows : `explorer.exe ms-screenclip:` —— 触发 Win+Shift+S 的截图浮层。
///             进程**立即返回**,用户选完区域后,截图会被系统放进剪贴板。
///   macOS   : `screencapture -i -c` —— 阻塞到用户选完(或 Esc 取消),
///             截图放进剪贴板。
///   Linux   : 优先 `flameshot gui`,回退 `gnome-screenshot -a -c`。
///
/// 本函数只负责「调起」,不读剪贴板——读剪贴板由前端轮询完成。Tauri 桌面
/// 端走 `read_local_clipboard_image` 命令直接读**本机**剪贴板(executor /
/// client 模式都一样,因为截图永远落在本机);浏览器模式回落到 bridge 的
/// readClipboardImage。这样能复用既有的图片上传 / 素材池 / preview 逻辑。
#[tauri::command]
fn open_screenshot_tool() -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    {
        // 注意:用 cmd /C start 触发 URI 协议处理器,不要直接 Command::new("explorer"),
        // 后者在某些版本下会忽略 URI 参数。
        let r = Command::new("cmd")
            .args(["/C", "start", "", "ms-screenclip:"])
            .spawn();
        return r.map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let r = Command::new("screencapture").args(["-i", "-c"]).spawn();
        return r.map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let r = Command::new("flameshot")
            .arg("gui")
            .spawn()
            .or_else(|_| Command::new("gnome-screenshot").args(["-a", "-c"]).spawn())
            .or_else(|_| Command::new("spectacle").args(["-r", "-c", "-b"]).spawn());
        return r.map(|_| ()).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

/// 读本机剪贴板里的图片(Tauri 客户端模式下的关键能力)。
///
/// 既有的 `api.readClipboardImage()` 走 WebSocket bridge → Python 后端,
/// 在 client 模式下后端在远端机器,读到的是远端剪贴板,本地截图丢进本地
/// 剪贴板它根本看不到。本命令用 arboard 直接读**本机**剪贴板,把 RGBA
/// 像素 PNG 编码后 base64 返回,字段与 `ImageAttachment` 对齐。
///
/// 返回 `Ok(None)` 表示剪贴板里没有图像内容,不算错误。
#[tauri::command]
fn read_local_clipboard_image() -> Result<Option<ClipboardImage>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = match cb.get_image() {
        Ok(i) => i,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let width = img.width as u32;
    let height = img.height as u32;
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        // arboard::ImageData::bytes 是 Cow<'_, [u8]>,显式 deref 到 &[u8]
        writer
            .write_image_data(img.bytes.as_ref())
            .map_err(|e| e.to_string())?;
    }
    let size = png_bytes.len() as u64;
    Ok(Some(ClipboardImage {
        base64: BASE64.encode(&png_bytes),
        mime_type: "image/png".to_string(),
        width,
        height,
        size,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct ClipboardImage {
    base64: String,
    mime_type: String,
    width: u32,
    height: u32,
    size: u64,
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            open_screenshot_tool,
            read_local_clipboard_image,
            get_desktop_config,
            set_desktop_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

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

// ════════════════════════════════════════════════════════════════
//  目录同步：本机「副本目录」的文件系统原语
//
//  远程执行模式下，会话工作目录在远端执行节点上。客户端要 pull/push
//  就得在本机选一个「副本目录」。这组命令提供对该副本目录的扫描 / 读 /
//  写 / 删，与后端 syncManifest/syncReadFile/... 对称；三向增量比对在
//  前端 dirSync.ts 里完成。哈希用 sha2（纯 Rust，编译进二进制）。
// ════════════════════════════════════════════════════════════════

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize)]
struct SyncFileInfo {
    hash: String,
    size: u64,
}

#[derive(Serialize)]
struct SyncScanResult {
    files: HashMap<String, SyncFileInfo>,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 极简通配匹配：`*` 匹配任意长度（含空），`?` 匹配单字符，其余精确。
/// 语义须与后端 Python fnmatch 保持一致（默认忽略清单只用到 `*`）。
fn wildcard_match(pat: &str, text: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (np, nt) = (p.len(), t.len());
    let mut dp = vec![vec![false; nt + 1]; np + 1];
    dp[0][0] = true;
    for i in 1..=np {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=np {
        for j in 1..=nt {
            dp[i][j] = if p[i - 1] == '*' {
                dp[i - 1][j] || dp[i][j - 1]
            } else if p[i - 1] == '?' || p[i - 1] == t[j - 1] {
                dp[i - 1][j - 1]
            } else {
                false
            };
        }
    }
    dp[np][nt]
}

fn sync_is_ignored(rel: &str, patterns: &[String]) -> bool {
    let rel = rel.replace('\\', "/");
    let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    for pat in patterns {
        let p = pat.trim().trim_end_matches('/');
        if p.is_empty() {
            continue;
        }
        if wildcard_match(p, &rel) {
            return true;
        }
        for seg in &segs {
            if wildcard_match(p, seg) {
                return true;
            }
        }
    }
    false
}

/// 把相对路径解析到副本目录内；越权（.. / 绝对路径）一律报错。
/// 写入场景下目标文件可能尚不存在，因此不能 canonicalize 目标本身，
/// 改为「从规范化的 root 逐段 push」+ 拒绝 `..` 段来保证不越界。
fn sync_resolve(dir: &str, rel: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let root = std::fs::canonicalize(dir).map_err(|e| format!("副本目录无效: {e}"))?;
    let parts: Vec<String> = rel
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(|s| s.to_string())
        .collect();
    if parts.is_empty() || parts.iter().any(|s| s == "..") {
        return Err("非法路径".into());
    }
    let mut target = root.clone();
    for p in &parts {
        target.push(p);
    }
    Ok((root, target))
}

fn scan_dir(root: &Path, cur: &Path, ignore: &[String], out: &mut HashMap<String, SyncFileInfo>) {
    let entries = match std::fs::read_dir(cur) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if sync_is_ignored(&rel, ignore) {
            continue;
        }
        if ft.is_dir() {
            scan_dir(root, &path, ignore, out);
        } else if ft.is_file() {
            if let Ok(data) = std::fs::read(&path) {
                let mut hasher = Sha256::new();
                hasher.update(&data);
                out.insert(
                    rel,
                    SyncFileInfo {
                        hash: hex_encode(&hasher.finalize()),
                        size: data.len() as u64,
                    },
                );
            }
        }
    }
}

#[tauri::command]
fn dir_sync_scan(dir: String, ignore: Vec<String>) -> Result<SyncScanResult, String> {
    let root = std::fs::canonicalize(&dir).map_err(|e| format!("副本目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("副本目录不存在".into());
    }
    let mut files = HashMap::new();
    scan_dir(&root, &root, &ignore, &mut files);
    Ok(SyncScanResult { files })
}

#[tauri::command]
fn dir_sync_read_file(dir: String, rel: String) -> Result<String, String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let data = std::fs::read(&target).map_err(|e| e.to_string())?;
    Ok(BASE64.encode(&data))
}

#[tauri::command]
fn dir_sync_write_file(dir: String, rel: String, data: String) -> Result<(), String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn dir_sync_delete_file(dir: String, rel: String) -> Result<(), String> {
    let (root, target) = sync_resolve(&dir, &rel)?;
    if target.is_file() || target.is_symlink() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
        // 向上清理因此变空的目录，但不越过 root
        let mut parent = target.parent().map(|p| p.to_path_buf());
        while let Some(p) = parent {
            if p == root {
                break;
            }
            match std::fs::read_dir(&p) {
                Ok(mut it) => {
                    if it.next().is_some() {
                        break;
                    }
                    if std::fs::remove_dir(&p).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
            parent = p.parent().map(|x| x.to_path_buf());
        }
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
                            match sidecar.spawn() {
                                Ok(_child) => {
                                    eprintln!("[tauri] sidecar spawned successfully");
                                }
                                Err(e) => {
                                    eprintln!("[tauri] sidecar spawn FAILED: {e}");
                                    // 写一份到 backend.log，方便用户排查
                                    if let Some(log_dir) = dirs::home_dir().map(|h| h.join(".agent-with-u")) {
                                        let _ = std::fs::create_dir_all(&log_dir);
                                        let log_path = log_dir.join("backend.log");
                                        let msg = format!(
                                            "[tauri] sidecar spawn failed: {e}\n\
                                             This usually means the backend binary is missing or corrupted.\n\
                                             Expected location: next to AgentWithU.exe\n\
                                             Try reinstalling or check antivirus quarantine.\n"
                                        );
                                        use std::io::Write;
                                        if let Ok(mut f) = std::fs::OpenOptions::new()
                                            .create(true).append(true).open(&log_path)
                                        {
                                            let _ = f.write_all(msg.as_bytes());
                                        }
                                    }
                                }
                            }
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
            set_desktop_config,
            dir_sync_scan,
            dir_sync_read_file,
            dir_sync_write_file,
            dir_sync_delete_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

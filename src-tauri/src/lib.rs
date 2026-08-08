use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

mod hacker_mode;

const WS_PORT: u16 = 44321;
static APP_EXITING: AtomicBool = AtomicBool::new(false);
static DESKTOP_LOG_LOCK: Mutex<()> = Mutex::new(());

fn desktop_log_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(dirs::data_local_dir)
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("AgentWithU")
            .join("logs")
            .join("desktop.log")
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".agent-with-u")
            .join("logs")
            .join("desktop.log")
    }
}

pub(crate) fn desktop_log(message: impl AsRef<str>) {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    let Ok(_guard) = DESKTOP_LOG_LOCK.lock() else {
        return;
    };
    let path = desktop_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Keep diagnostics bounded because Smooth gestures can run for days.
    if path
        .metadata()
        .map(|meta| meta.len() > 4 * 1024 * 1024)
        .unwrap_or(false)
    {
        let rotated = path.with_extension("log.old");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, rotated);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let clean = message.as_ref().replace(['\r', '\n'], " ");
        let _ = writeln!(file, "[{timestamp}] {clean}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLogResponse {
    ok: bool,
    lines: Vec<String>,
    path: String,
    error: Option<String>,
}

#[tauri::command]
fn get_desktop_logs(max_lines: Option<usize>) -> DesktopLogResponse {
    let path = desktop_log_path();
    let limit = max_lines.unwrap_or(800).clamp(1, 5000);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let mut lines = content
                .lines()
                .rev()
                .take(limit)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            lines.reverse();
            DesktopLogResponse {
                ok: true,
                lines,
                path: path.to_string_lossy().into_owned(),
                error: None,
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DesktopLogResponse {
            ok: true,
            lines: Vec::new(),
            path: path.to_string_lossy().into_owned(),
            error: None,
        },
        Err(error) => DesktopLogResponse {
            ok: false,
            lines: Vec::new(),
            path: path.to_string_lossy().into_owned(),
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
fn report_desktop_log(source: String, message: String) {
    let source = source.replace(['\r', '\n'], " ");
    let message = message.replace(['\r', '\n'], " ");
    desktop_log(format!(
        "[{}] {}",
        source.chars().take(40).collect::<String>(),
        message.chars().take(2000).collect::<String>()
    ));
}

#[derive(Default)]
struct BackendProcess(Mutex<Option<CommandChild>>);

#[cfg(target_os = "windows")]
fn kill_windows_process_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn backend_pid_file() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|base| {
            base.join("AgentWithU")
                .join(format!("backend_{WS_PORT}.pid"))
        })
}

fn stop_backend_child(app: &tauri::AppHandle) {
    let child = app
        .state::<BackendProcess>()
        .0
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    #[cfg(target_os = "windows")]
    {
        // PyInstaller onefile starts a parent bootstrapper plus the actual
        // Python child. Kill both the shell-plugin parent and the runtime PID
        // recorded by ws_main. The latter is essential when the in-memory
        // handle was lost or the onefile bootstrapper already changed shape.
        let child_pid = child.as_ref().map(CommandChild::pid);
        if let Some(pid) = child_pid {
            if !kill_windows_process_tree(pid) {
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        }
        if let Some(pid_file) = backend_pid_file() {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    if Some(pid) != child_pid {
                        let _ = kill_windows_process_tree(pid);
                    }
                }
            }
            let _ = std::fs::remove_file(pid_file);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

fn quit_app_completely(app: &tauri::AppHandle) {
    if APP_EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    stop_backend_child(app);
    app.exit(0);

    // The tray action explicitly means force quit.  If a plugin or native
    // hook keeps Tauri's event loop alive, do not leave an invisible process
    // behind indefinitely.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(800));
        std::process::exit(0);
    });
}

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
            .args([
                "/C",
                "start",
                "AgentWithU Logs",
                "powershell",
                "-NoExit",
                "-Command",
            ])
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
    // Session 文件传输需要完整保留 Git 元数据，不能让旧忽略配置继续
    // 静默过滤 `.git`。
    if segs.contains(&".git") {
        return false;
    }
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
fn dir_sync_file_size(dir: String, rel: String) -> Result<u64, String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    Ok(meta.len())
}

#[tauri::command]
fn dir_sync_read_chunk(
    dir: String,
    rel: String,
    offset: u64,
    size: usize,
) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    if size == 0 || size > 1024 * 1024 {
        return Err("分块大小无效".into());
    }
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let mut file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut data = vec![0u8; size];
    let read = file.read(&mut data).map_err(|e| e.to_string())?;
    data.truncate(read);
    Ok(BASE64.encode(&data))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KitClientFileInfo {
    size: u64,
    sha256: String,
}

#[tauri::command]
fn kit_client_file_info(path: String) -> Result<KitClientFileInfo, String> {
    use std::io::Read;
    let target = std::fs::canonicalize(&path).map_err(|e| format!("客户端源文件无效: {e}"))?;
    if !target.is_file() {
        return Err("客户端源路径不是文件".into());
    }
    let mut file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(KitClientFileInfo {
        size: target.metadata().map_err(|e| e.to_string())?.len(),
        sha256: hex_encode(&hasher.finalize()),
    })
}

#[tauri::command]
fn kit_client_read_chunk(path: String, offset: u64, size: usize) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    if size == 0 || size > 1024 * 1024 {
        return Err("分块大小无效".into());
    }
    let target = std::fs::canonicalize(&path).map_err(|e| format!("客户端源文件无效: {e}"))?;
    if !target.is_file() {
        return Err("客户端源路径不是文件".into());
    }
    let mut file = std::fs::File::open(target).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut data = vec![0u8; size];
    let read = file.read(&mut data).map_err(|e| e.to_string())?;
    data.truncate(read);
    Ok(BASE64.encode(data))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KitClientCommandSpec {
    shell: String,
    command: String,
    cwd: String,
    timeout_seconds: u64,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KitClientCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[tauri::command]
async fn kit_client_command(spec: KitClientCommandSpec) -> Result<KitClientCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        if spec.command.trim().is_empty() {
            return Err("客户端命令为空".into());
        }
        let timeout = spec.timeout_seconds.clamp(1, 86_400);
        let mut command = match spec.shell.as_str() {
            "cmd" => {
                let mut cmd =
                    Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
                cmd.args(["/d", "/s", "/c", &spec.command]);
                cmd
            }
            "bash" => {
                let mut cmd = Command::new("bash");
                cmd.args(["-lc", &spec.command]);
                cmd
            }
            "powershell" => {
                let executable = if cfg!(target_os = "windows") {
                    "powershell"
                } else {
                    "pwsh"
                };
                let mut cmd = Command::new(executable);
                cmd.args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &spec.command,
                ]);
                cmd
            }
            _ => return Err("不支持的客户端 Shell".into()),
        };
        if !spec.cwd.trim().is_empty() {
            let cwd =
                std::fs::canonicalize(&spec.cwd).map_err(|e| format!("客户端工作目录无效: {e}"))?;
            if !cwd.is_dir() {
                return Err("客户端工作目录不存在".into());
            }
            command.current_dir(cwd);
        }
        command
            .envs(&spec.env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("客户端命令启动失败: {e}"))?;
        let mut stdout = child.stdout.take().ok_or("无法接管客户端 stdout")?;
        let mut stderr = child.stderr.take().ok_or("无法接管客户端 stderr")?;
        let out_thread = std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            out
        });
        let err_thread = std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stderr.read_to_end(&mut out);
            out
        });
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("客户端命令超过 {timeout} 秒，已终止"));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut out = out_thread.join().unwrap_or_default();
        let mut err = err_thread.join().unwrap_or_default();
        out.truncate(200_000);
        err.truncate(200_000);
        Ok(KitClientCommandResult {
            exit_code: status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sync_transfer_token(value: &str) -> Result<&str, String> {
    if value.len() < 8
        || value.len() > 80
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("传输标识无效".into());
    }
    Ok(value)
}

fn sync_temp_path(target: &Path, transfer_id: &str) -> Result<PathBuf, String> {
    let token = sync_transfer_token(transfer_id)?;
    let name = target
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("文件名无效")?;
    Ok(target.with_file_name(format!(".{name}.awu-{token}.part")))
}

#[cfg(target_os = "windows")]
fn sync_atomic_replace(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_atomic_replace(temp: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(temp, target).map_err(|e| e.to_string())
}

#[tauri::command]
fn dir_sync_write_start(dir: String, rel: String, transfer_id: String) -> Result<(), String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let temp = sync_temp_path(&target, &transfer_id)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(temp).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn dir_sync_write_chunk(
    dir: String,
    rel: String,
    transfer_id: String,
    offset: u64,
    data: String,
) -> Result<u64, String> {
    use std::io::Write;
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let temp = sync_temp_path(&target, &transfer_id)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("上传分块超过 1 MiB".into());
    }
    let actual = std::fs::metadata(&temp)
        .map_err(|_| "上传会话不存在或已过期".to_string())?
        .len();
    if actual != offset {
        return Err("上传分块顺序不一致，请重试".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

#[tauri::command]
fn dir_sync_write_finish(
    dir: String,
    rel: String,
    transfer_id: String,
    expected_size: u64,
) -> Result<(), String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let temp = sync_temp_path(&target, &transfer_id)?;
    let actual = std::fs::metadata(&temp)
        .map_err(|_| "上传会话不存在或已过期".to_string())?
        .len();
    if actual != expected_size {
        return Err(format!(
            "上传大小校验失败：期望 {expected_size}，实际 {actual}"
        ));
    }
    // 仅在临时文件完整校验后原子替换，失败时原文件仍然保留。
    sync_atomic_replace(&temp, &target)
}

#[tauri::command]
fn dir_sync_write_abort(dir: String, rel: String, transfer_id: String) -> Result<(), String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    let temp = sync_temp_path(&target, &transfer_id)?;
    if temp.exists() {
        std::fs::remove_file(temp).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn dir_sync_reveal(dir: String, rel: String) -> Result<(), String> {
    let (_root, target) = sync_resolve(&dir, &rel)?;
    if !target.exists() {
        return Err("文件或目录不存在".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = std::process::Command::new("explorer.exe");
        if target.is_dir() {
            command.arg(&target);
        } else {
            command.arg(format!("/select,{}", target.display()));
        }
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command.arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let folder = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or(&target).to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
        // Register this first: launching the desktop shortcut while the main
        // window is hidden in the tray must reveal the existing process, not
        // start a second frontend/backend pair.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(BackendProcess::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            desktop_log(format!(
                "[startup] app setup started; version={}",
                app.package_info().version
            ));
            // Close-to-tray keeps Smooth and background answers alive.  The
            // explicit tray Quit action is the only full application exit.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::Manager;

            let show_item = MenuItem::with_id(app, "show-main", "显示 AgentWithU", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::with_id("agent-with-u-tray")
                .tooltip("AgentWithU")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show-main" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        quit_app_completely(app);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

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
                                Ok((mut events, child)) => {
                                    // The shell plugin captures stdout/stderr in a
                                    // bounded channel. Keep draining it or a chatty
                                    // backend can eventually block on a full pipe.
                                    tauri::async_runtime::spawn(async move {
                                        while events.recv().await.is_some() {}
                                    });
                                    if let Ok(mut guard) = app.state::<BackendProcess>().0.lock() {
                                        *guard = Some(child);
                                    }
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
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !APP_EXITING.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_ws_port,
            get_desktop_logs,
            report_desktop_log,
            open_log_viewer,
            open_screenshot_tool,
            read_local_clipboard_image,
            hacker_mode::configure_hacker_monitor,
            hacker_mode::capture_hacker_screenshot,
            hacker_mode::update_smooth_ghost_state,
            hacker_mode::open_smooth_region_selector,
            hacker_mode::finish_smooth_region,
            get_desktop_config,
            set_desktop_config,
            dir_sync_scan,
            dir_sync_read_file,
            dir_sync_file_size,
            dir_sync_read_chunk,
            kit_client_file_info,
            kit_client_read_chunk,
            kit_client_command,
            dir_sync_write_file,
            dir_sync_write_start,
            dir_sync_write_chunk,
            dir_sync_write_finish,
            dir_sync_write_abort,
            dir_sync_reveal,
            dir_sync_delete_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentWithU");
}

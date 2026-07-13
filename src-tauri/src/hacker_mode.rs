//! Windows-only low-interruption screenshot trigger.
//!
//! The hook observes only Ctrl + the configured mouse button. It does not
//! record keys, pointer positions, or ordinary clicks. Matching clicks are
//! swallowed so the foreground application's focus remains unchanged.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HackerMonitorConfig {
    pub enabled: bool,
    pub mouse_button: String,
    pub double_click_ms: u64,
}

impl Default for HackerMonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mouse_button: "left".into(),
            double_click_ms: 450,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HackerCaptureConfig {
    pub mode: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Default for HackerCaptureConfig {
    fn default() -> Self {
        Self {
            mode: "full".into(),
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HackerImage {
    pub base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, GetSystemMetrics, SetWindowsHookExW,
        TranslateMessage, MSG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    struct MonitorState {
        app: Option<AppHandle>,
        config: HackerMonitorConfig,
        last_down: Option<Instant>,
        last_panel_down: Option<Instant>,
        hook_started: bool,
    }

    impl Default for MonitorState {
        fn default() -> Self {
            Self {
                app: None,
                config: HackerMonitorConfig::default(),
                last_down: None,
                last_panel_down: None,
                hook_started: false,
            }
        }
    }

    static STATE: OnceLock<Mutex<MonitorState>> = OnceLock::new();

    fn state() -> &'static Mutex<MonitorState> {
        STATE.get_or_init(|| Mutex::new(MonitorState::default()))
    }

    fn button_messages(button: &str) -> (u32, u32) {
        match button {
            "left" => (WM_LBUTTONDOWN, WM_LBUTTONUP),
            "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP),
            _ => (WM_MBUTTONDOWN, WM_MBUTTONUP),
        }
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            if let Ok(mut guard) = state().lock() {
                if (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0 {
                    let message = wparam as u32;
                    // Ctrl + 双击中键固定用于隐藏/恢复主窗口，独立于 Smooth 开关。
                    if message == WM_MBUTTONDOWN || message == WM_MBUTTONUP {
                        if message == WM_MBUTTONDOWN {
                            let now = Instant::now();
                            let triggered = guard
                                .last_panel_down
                                .map(|last| now.duration_since(last) <= Duration::from_millis(450))
                                .unwrap_or(false);
                            guard.last_panel_down = if triggered { None } else { Some(now) };
                            if triggered {
                                if let Some(app) = guard.app.clone() {
                                    std::thread::spawn(move || toggle_main_window(app));
                                }
                            }
                        }
                        return 1;
                    }

                    if !guard.config.enabled {
                        return CallNextHookEx(null_mut(), code, wparam, lparam);
                    }
                    let (down, up) = button_messages(&guard.config.mouse_button);
                    if message == down || message == up {
                        if message == down {
                            let now = Instant::now();
                            let threshold = Duration::from_millis(
                                guard.config.double_click_ms.clamp(180, 1000),
                            );
                            let triggered = guard
                                .last_down
                                .map(|last| now.duration_since(last) <= threshold)
                                .unwrap_or(false);
                            guard.last_down = if triggered { None } else { Some(now) };
                            if triggered {
                                if let Some(app) = guard.app.clone() {
                                    let _ = app.emit("hacker-trigger", ());
                                }
                            }
                        }
                        // Suppress the trigger clicks so the foreground window never changes.
                        return 1;
                    }
                }
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    fn toggle_main_window(app: AppHandle) {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        match window.is_minimized() {
            Ok(true) => {
                let _ = window.unminimize();
                let _ = window.maximize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(false) => {
                let _ = window.minimize();
            }
            Err(error) => eprintln!("[smooth] cannot read main window state: {error}"),
        }
    }

    fn spawn_hook_thread() {
        std::thread::spawn(|| unsafe {
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), null_mut(), 0);
            if hook.is_null() {
                eprintln!("[smooth] failed to install mouse hook");
                return;
            }
            let mut msg: MSG = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    pub fn configure(app: AppHandle, config: HackerMonitorConfig) -> Result<(), String> {
        let mut guard = state().lock().map_err(|_| "smooth monitor lock poisoned")?;
        guard.app = Some(app);
        guard.config = config;
        guard.last_down = None;
        guard.last_panel_down = None;
        if !guard.hook_started {
            guard.hook_started = true;
            spawn_hook_thread();
        }
        Ok(())
    }

    fn capture_rect(config: &HackerCaptureConfig) -> Result<(i32, i32, i32, i32), String> {
        if config.mode == "region" {
            if config.width <= 0 || config.height <= 0 {
                return Err("截图区域宽高必须大于 0".into());
            }
            return Ok((config.x, config.y, config.width, config.height));
        }
        unsafe {
            Ok((
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            ))
        }
    }

    pub fn capture(config: HackerCaptureConfig) -> Result<HackerImage, String> {
        let (x, y, width, height) = capture_rect(&config)?;
        unsafe {
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("无法读取屏幕".into());
            }
            let memory = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            if memory.is_null() || bitmap.is_null() {
                if !bitmap.is_null() {
                    DeleteObject(bitmap);
                }
                if !memory.is_null() {
                    DeleteDC(memory);
                }
                ReleaseDC(null_mut(), screen);
                return Err("无法创建截图缓冲区".into());
            }
            let old = SelectObject(memory, bitmap);
            let copied = BitBlt(
                memory,
                0,
                0,
                width,
                height,
                screen,
                x,
                y,
                SRCCOPY | CAPTUREBLT,
            );
            if copied == 0 {
                SelectObject(memory, old);
                DeleteObject(bitmap);
                DeleteDC(memory);
                ReleaseDC(null_mut(), screen);
                return Err("屏幕复制失败".into());
            }

            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                bgra.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(memory, old);
            DeleteObject(bitmap);
            DeleteDC(memory);
            ReleaseDC(null_mut(), screen);
            if lines == 0 {
                return Err("读取截图像素失败".into());
            }

            for pixel in bgra.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
                writer.write_image_data(&bgra).map_err(|e| e.to_string())?;
            }
            Ok(HackerImage {
                base64: BASE64.encode(&png_bytes),
                mime_type: "image/png".into(),
                width: width as u32,
                height: height as u32,
                size: png_bytes.len() as u64,
            })
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn configure(_app: AppHandle, config: HackerMonitorConfig) -> Result<(), String> {
        if config.enabled {
            Err("Smooth 模式的鼠标触发器目前仅支持 Windows".into())
        } else {
            Ok(())
        }
    }
    pub fn capture(_config: HackerCaptureConfig) -> Result<HackerImage, String> {
        Err("后台截图目前仅支持 Windows".into())
    }
}

#[tauri::command]
pub fn configure_hacker_monitor(app: AppHandle, config: HackerMonitorConfig) -> Result<(), String> {
    platform::configure(app, config)
}

#[tauri::command]
pub fn capture_hacker_screenshot(config: HackerCaptureConfig) -> Result<HackerImage, String> {
    platform::capture(config)
}

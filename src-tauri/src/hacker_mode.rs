//! Windows-only low-interruption screenshot trigger.
//!
//! The hook observes only Ctrl + the configured mouse button. It does not
//! record keys, pointer positions, or ordinary clicks. Matching clicks are
//! swallowed so the foreground application's focus remains unchanged.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HackerMonitorConfig {
    pub enabled: bool,
    pub mouse_button: String,
    pub double_click_ms: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Default for HackerMonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mouse_button: "left".into(),
            double_click_ms: 450,
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmoothRegionSelection {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
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
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU};
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
                let message = wparam as u32;
                // Alt + 双击左键切换鼠标穿透的幽灵窗口，仅在 Smooth 开启时生效。
                if guard.config.enabled && (GetAsyncKeyState(VK_MENU as i32) as u16 & 0x8000) != 0 {
                    if message == WM_LBUTTONDOWN || message == WM_LBUTTONUP {
                        if message == WM_LBUTTONDOWN {
                            let now = Instant::now();
                            let triggered = guard
                                .last_panel_down
                                .map(|last| now.duration_since(last) <= Duration::from_millis(450))
                                .unwrap_or(false);
                            guard.last_panel_down = if triggered { None } else { Some(now) };
                            if triggered {
                                if let Some(app) = guard.app.clone() {
                                    let config = guard.config.clone();
                                    std::thread::spawn(move || toggle_ghost_window(app, config));
                                }
                            }
                        }
                        return 1;
                    }
                }

                if (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0 {
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

    fn apply_no_activate_style(window: &tauri::WebviewWindow) {
        let _ = window.set_ignore_cursor_events(true);
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
                    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
                    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
                };
                let raw = hwnd.0 as *mut core::ffi::c_void;
                let style = GetWindowLongW(raw, GWL_EXSTYLE);
                SetWindowLongW(
                    raw,
                    GWL_EXSTYLE,
                    style
                        | WS_EX_LAYERED as i32
                        | WS_EX_TRANSPARENT as i32
                        | WS_EX_NOACTIVATE as i32
                        | WS_EX_TOOLWINDOW as i32,
                );
                SetWindowPos(
                    raw,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }

    /// Show the overlay through Win32's explicit no-activate path.  Tauri's
    /// cross-platform `show()` may activate a WebView on some Windows builds,
    /// even when `focused(false)` was used at construction time.
    fn show_without_activation(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        unsafe {
            use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
                GetFocus, SetActiveWindow, SetFocus,
            };
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow, SetWindowPos,
                PeekMessageW, ShowWindow, HWND_TOPMOST, PM_NOREMOVE, SWP_NOACTIVATE, SWP_NOMOVE,
                SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
            };

            let raw = hwnd.0 as *mut core::ffi::c_void;
            // AttachThreadInput requires both threads to own a message queue.
            // A fresh worker thread does not have one until its first USER32
            // queue call, so create it explicitly before attaching.
            let mut queue_probe: MSG = zeroed();
            PeekMessageW(&mut queue_probe, core::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            let foreground = GetForegroundWindow();
            let foreground_thread = if foreground.is_null() {
                0
            } else {
                GetWindowThreadProcessId(foreground, core::ptr::null_mut())
            };
            let current_thread = GetCurrentThreadId();
            let attached = foreground_thread != 0
                && foreground_thread != current_thread
                && AttachThreadInput(current_thread, foreground_thread, 1) != 0;
            let focused_control = if foreground.is_null() {
                core::ptr::null_mut()
            } else {
                GetFocus()
            };

            apply_no_activate_style(window);
            ShowWindow(raw, SW_SHOWNOACTIVATE);
            SetWindowPos(
                raw,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );

            // Defensive restoration: normally SW_SHOWNOACTIVATE keeps the
            // foreground unchanged.  WebView2 startup and a few shell builds
            // can still race us, so restore the exact foreground/focused child.
            if !foreground.is_null() && GetForegroundWindow() != foreground {
                SetForegroundWindow(foreground);
                SetActiveWindow(foreground);
            }
            if !focused_control.is_null() && GetFocus() != focused_control {
                SetFocus(focused_control);
            }
            if attached {
                AttachThreadInput(current_thread, foreground_thread, 0);
            }
        }
    }

    fn place_ghost(window: &tauri::WebviewWindow, config: &HackerMonitorConfig) {
        let width = config.width.max(320) as u32;
        let height = config.height.max(180) as u32;
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            config.x, config.y,
        )));
        let _ = window.set_size(Size::Physical(PhysicalSize::new(width, height)));
        let _ = window.set_always_on_top(true);
        let _ = window.set_skip_taskbar(true);
        apply_no_activate_style(window);
    }

    fn ensure_ghost_window(
        app: &AppHandle,
        config: &HackerMonitorConfig,
    ) -> Result<tauri::WebviewWindow, String> {
        if let Some(window) = app.get_webview_window("smooth-ghost") {
            place_ghost(&window, config);
            return Ok(window);
        }

        let window = WebviewWindowBuilder::new(
            app,
            "smooth-ghost",
            WebviewUrl::App("index.html?smooth-ghost=1".into()),
        )
        .title("AgentWithU · Smooth Ghost")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .resizable(false)
        .build()
        .map_err(|error| error.to_string())?;
        place_ghost(&window, config);
        Ok(window)
    }

    fn toggle_ghost_window(app: AppHandle, config: HackerMonitorConfig) {
        if let Some(window) = app.get_webview_window("smooth-ghost") {
            match window.is_visible() {
                Ok(true) => {
                    let _ = window.hide();
                }
                Ok(false) => {
                    place_ghost(&window, &config);
                    show_without_activation(&window);
                }
                Err(error) => eprintln!("[smooth] cannot read ghost window state: {error}"),
            }
            return;
        }

        match ensure_ghost_window(&app, &config) {
            Ok(window) => show_without_activation(&window),
            Err(error) => eprintln!("[smooth] failed to create ghost window: {error}"),
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
        let prepare_config = config.clone();
        let mut guard = state().lock().map_err(|_| "smooth monitor lock poisoned")?;
        guard.app = Some(app.clone());
        guard.config = config;
        guard.last_down = None;
        guard.last_panel_down = None;
        if !guard.hook_started {
            guard.hook_started = true;
            spawn_hook_thread();
        }
        drop(guard);

        if prepare_config.enabled {
            // Pre-create while the AgentWithU settings/main window is already
            // foreground.  The later global gesture only reveals an existing
            // HWND, eliminating WebView creation as a source of focus theft.
            ensure_ghost_window(&app, &prepare_config)?;
        } else if let Some(window) = app.get_webview_window("smooth-ghost") {
            let _ = window.hide();
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

/// Finish the temporary selector from the native side.
///
/// Destroying the window here is deliberate: a transparent fullscreen webview
/// that only hides its HTML can keep intercepting mouse input.  Native destroy
/// guarantees the hit-test window is gone after both confirm and cancel.
#[tauri::command]
pub fn finish_smooth_region(
    app: AppHandle,
    selection: Option<SmoothRegionSelection>,
) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    if let Some(selected) = selection {
        if let Err(error) = app.emit_to("main", "smooth-region-selected", selected) {
            errors.push(format!("emit selection failed: {error}"));
        }
    }
    if let Some(window) = app.get_webview_window("smooth-region") {
        if let Err(error) = window.destroy() {
            errors.push(format!("destroy selector failed: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

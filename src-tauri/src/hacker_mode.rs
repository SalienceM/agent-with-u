//! Windows-only low-interruption screenshot trigger.
//!
//! The hook observes only configured Smooth gestures plus wheel events inside
//! the visible ghost rectangle. It does not record ordinary input. Matching
//! gestures are swallowed so the foreground application's focus stays intact.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SmoothGhostContent {
    pub session_id: String,
    pub session_title: String,
    pub backend_label: String,
    pub question: String,
    pub answer: String,
    pub history_text: String,
    pub is_streaming: bool,
    pub updated_at: u64,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, RECT, WPARAM,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC,
        DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect, GetDC, GetDIBits, GetStockObject,
        IntersectClipRect, InvalidateRect, ReleaseDC, RestoreDC, SaveDC, SelectObject, SetBkMode,
        SetTextColor, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DEFAULT_GUI_FONT, DIB_RGB_COLORS, DT_CALCRECT, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX,
        DT_SINGLELINE, DT_TOP, DT_VCENTER, DT_WORDBREAK, HBRUSH, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_LSHIFT, VK_RETURN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        GetClientRect, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, IsWindow,
        IsWindowVisible, LoadCursorW, PostQuitMessage, RegisterClassW, SetForegroundWindow,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, SetWindowTextW,
        SetWindowsHookExW, ShowWindow, TranslateMessage, CREATESTRUCTW, GWLP_USERDATA,
        HTTRANSPARENT, HWND_TOPMOST, IDC_ARROW, IDC_SIZEALL, LWA_ALPHA, MA_NOACTIVATE, MSG,
        MSLLHOOKSTRUCT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
        SW_SHOWNORMAL, WH_MOUSE_LL, WM_CLOSE, WM_DESTROY, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEWHEEL, WM_MOVE, WM_NCCREATE,
        WM_NCHITTEST, WM_PAINT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SIZE, WNDCLASSW, WS_CAPTION,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };

    struct MonitorState {
        app: Option<AppHandle>,
        config: HackerMonitorConfig,
        last_down: Option<Instant>,
        last_panel_down: Option<Instant>,
        last_capture_action: Option<Instant>,
        last_panel_action: Option<Instant>,
        hook_started: bool,
    }

    impl Default for MonitorState {
        fn default() -> Self {
            Self {
                app: None,
                config: HackerMonitorConfig::default(),
                last_down: None,
                last_panel_down: None,
                last_capture_action: None,
                last_panel_action: None,
                hook_started: false,
            }
        }
    }

    static STATE: OnceLock<Mutex<MonitorState>> = OnceLock::new();

    #[derive(Clone, Copy)]
    enum SmoothTrigger {
        CtrlClickSeen,
        LeftShiftClickSeen,
        Capture,
        ToggleGhost,
    }

    static TRIGGER_TX: OnceLock<std::sync::mpsc::SyncSender<SmoothTrigger>> = OnceLock::new();
    static NATIVE_SELECTOR_RUNNING: AtomicBool = AtomicBool::new(false);
    static NATIVE_SELECTOR_BRUSH: OnceLock<usize> = OnceLock::new();

    struct NativeGhostRuntime {
        // HWND is a raw pointer in windows-sys and therefore cannot live
        // directly in a process-wide Mutex. Store its address instead.
        hwnd: isize,
        content: SmoothGhostContent,
        rect: (i32, i32, i32, i32),
        visible: bool,
        scroll_y: i32,
        max_scroll: i32,
        follow_latest: bool,
    }

    impl Default for NativeGhostRuntime {
        fn default() -> Self {
            Self {
                hwnd: 0,
                content: SmoothGhostContent::default(),
                rect: (0, 0, 0, 0),
                visible: false,
                scroll_y: 0,
                max_scroll: 0,
                follow_latest: true,
            }
        }
    }

    static NATIVE_GHOST: OnceLock<Mutex<NativeGhostRuntime>> = OnceLock::new();
    static NATIVE_GHOST_CREATING: AtomicBool = AtomicBool::new(false);
    static NATIVE_GHOST_DESIRED_VISIBLE: AtomicBool = AtomicBool::new(false);
    static NATIVE_GHOST_BG_BRUSH: OnceLock<usize> = OnceLock::new();
    static NATIVE_GHOST_CARD_BRUSH: OnceLock<usize> = OnceLock::new();
    static NATIVE_GHOST_BORDER_BRUSH: OnceLock<usize> = OnceLock::new();

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

    fn next_native_ghost_scroll(current: i32, max_scroll: i32, wheel_delta: i32) -> (i32, bool) {
        let notches = ((wheel_delta.abs() + 119) / 120).max(1);
        let amount = 72_i32.saturating_mul(notches);
        let next = if wheel_delta > 0 {
            current.saturating_sub(amount)
        } else {
            current.saturating_add(amount).min(max_scroll)
        }
        .clamp(0, max_scroll.max(0));
        (next, next >= max_scroll)
    }

    fn scroll_native_ghost_at(screen_x: i32, screen_y: i32, wheel_delta: i32) -> Option<HWND> {
        if wheel_delta == 0 || !NATIVE_GHOST_DESIRED_VISIBLE.load(Ordering::SeqCst) {
            return None;
        }
        let mut guard = native_ghost().try_lock().ok()?;
        let (x, y, width, height) = guard.rect;
        if !guard.visible
            || guard.hwnd == 0
            || width <= 0
            || height <= 0
            || screen_x < x
            || screen_x >= x + width
            || screen_y < y
            || screen_y >= y + height
            || guard.max_scroll <= 0
        {
            return None;
        }

        let (next, follow_latest) =
            next_native_ghost_scroll(guard.scroll_y, guard.max_scroll, wheel_delta);
        guard.scroll_y = next;
        guard.follow_latest = follow_latest;
        Some(guard.hwnd as HWND)
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code < 0 {
            return CallNextHookEx(null_mut(), code, wparam, lparam);
        }

        // A WH_MOUSE_LL callback runs on Windows' input path.  It must never
        // wait for Tauri/WebView work or a contended mutex; otherwise Windows
        // silently removes the hook after LowLevelHooksTimeout.  `try_lock`
        // and `try_send` make this callback strictly non-blocking.
        let message = wparam as u32;
        if message == WM_MOUSEWHEEL && lparam != 0 {
            let mouse = &*(lparam as *const MSLLHOOKSTRUCT);
            let wheel_delta = ((mouse.mouseData >> 16) as u16) as i16 as i32;
            if let Some(hwnd) = scroll_native_ghost_at(mouse.pt.x, mouse.pt.y, wheel_delta) {
                InvalidateRect(hwnd, core::ptr::null(), 0);
                // Swallow only wheel events inside the visible ghost. The
                // foreground window and keyboard focus remain untouched.
                return 1;
            }
        }
        let mut suppress = false;
        let mut diagnostic = None;
        let mut trigger = None;
        if let Ok(mut guard) = state().try_lock() {
            if guard.config.enabled {
                let now = Instant::now();
                let left_shift_down = (GetAsyncKeyState(VK_LSHIFT as i32) as u16 & 0x8000) != 0;
                let ctrl_down = (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0;

                if left_shift_down && (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) {
                    suppress = true;
                    if message == WM_LBUTTONDOWN {
                        diagnostic = Some(SmoothTrigger::LeftShiftClickSeen);
                        let is_double = guard
                            .last_panel_down
                            .map(|last| now.duration_since(last) <= Duration::from_millis(450))
                            .unwrap_or(false);
                        guard.last_panel_down = if is_double { None } else { Some(now) };
                        let cooled = guard
                            .last_panel_action
                            .map(|last| now.duration_since(last) >= Duration::from_millis(650))
                            .unwrap_or(true);
                        if is_double && cooled {
                            guard.last_panel_action = Some(now);
                            trigger = Some(SmoothTrigger::ToggleGhost);
                        }
                    }
                } else if ctrl_down {
                    let (down, up) = button_messages(&guard.config.mouse_button);
                    if message == down || message == up {
                        suppress = true;
                        if message == down {
                            diagnostic = Some(SmoothTrigger::CtrlClickSeen);
                            let threshold = Duration::from_millis(
                                guard.config.double_click_ms.clamp(180, 1000),
                            );
                            let is_double = guard
                                .last_down
                                .map(|last| now.duration_since(last) <= threshold)
                                .unwrap_or(false);
                            guard.last_down = if is_double { None } else { Some(now) };
                            let cooled = guard
                                .last_capture_action
                                .map(|last| now.duration_since(last) >= Duration::from_millis(800))
                                .unwrap_or(true);
                            if is_double && cooled {
                                guard.last_capture_action = Some(now);
                                trigger = Some(SmoothTrigger::Capture);
                            }
                        }
                    }
                }
            }
        }

        if let Some(tx) = TRIGGER_TX.get() {
            // Functional triggers take priority over diagnostics when the user
            // clicks very quickly and the bounded worker queue is briefly busy.
            if let Some(trigger) = trigger {
                let _ = tx.try_send(trigger);
            }
            if let Some(diagnostic) = diagnostic {
                let _ = tx.try_send(diagnostic);
            }
        }
        if suppress {
            // Keep the foreground application's focus unchanged.
            return 1;
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    fn ensure_trigger_worker() -> Result<(), String> {
        if TRIGGER_TX.get().is_some() {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<SmoothTrigger>(16);
        TRIGGER_TX
            .set(tx)
            .map_err(|_| "smooth trigger worker already initialized".to_string())?;
        std::thread::spawn(move || {
            while let Ok(trigger) = rx.recv() {
                let snapshot = state().lock().ok().and_then(|guard| {
                    guard
                        .app
                        .clone()
                        .map(|app| (app, guard.config.clone(), guard.config.enabled))
                });
                let Some((app, config, enabled)) = snapshot else {
                    continue;
                };
                if !enabled {
                    continue;
                }
                match trigger {
                    SmoothTrigger::CtrlClickSeen => {
                        crate::desktop_log("[smooth-hook] Ctrl + configured mouse down observed");
                    }
                    SmoothTrigger::LeftShiftClickSeen => {
                        crate::desktop_log("[smooth-hook] Left Shift + left mouse down observed");
                    }
                    SmoothTrigger::Capture => {
                        crate::desktop_log(
                            "[smooth-hook] Ctrl double-click recognized; emitting capture",
                        );
                        if let Err(error) = app.emit("hacker-trigger", ()) {
                            crate::desktop_log(format!(
                                "[smooth-hook] ERROR emitting capture: {error}"
                            ));
                        }
                    }
                    SmoothTrigger::ToggleGhost => {
                        crate::desktop_log(
                            "[smooth-hook] Left Shift double-click recognized; toggling ghost",
                        );
                        // The ghost is a pure Win32 overlay. Its first creation
                        // owns a separate message-loop thread and this call never
                        // blocks the Ctrl screenshot dispatch path.
                        toggle_native_ghost(app, config);
                    }
                }
            }
        });
        Ok(())
    }

    struct NativeSelectorState {
        result: Option<SmoothRegionSelection>,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn native_ghost() -> &'static Mutex<NativeGhostRuntime> {
        NATIVE_GHOST.get_or_init(|| Mutex::new(NativeGhostRuntime::default()))
    }

    fn truncate_chars(value: String, max_chars: usize) -> String {
        if value.chars().count() <= max_chars {
            return value;
        }
        let mut truncated: String = value.chars().take(max_chars).collect();
        truncated.push('…');
        truncated
    }

    fn truncate_tail_chars(value: String, max_chars: usize) -> String {
        if value.chars().count() <= max_chars {
            return value;
        }
        let keep = max_chars.saturating_sub(1);
        let mut tail: Vec<char> = value.chars().rev().take(keep).collect();
        tail.reverse();
        format!("…{}", tail.into_iter().collect::<String>())
    }

    fn native_ghost_hwnd() -> HWND {
        let Ok(mut guard) = native_ghost().lock() else {
            return null_mut();
        };
        if guard.hwnd == 0 {
            return null_mut();
        }
        let hwnd = guard.hwnd as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            guard.hwnd = 0;
            return null_mut();
        }
        hwnd
    }

    fn native_ghost_rect(config: &HackerMonitorConfig) -> (i32, i32, i32, i32) {
        unsafe {
            let virtual_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let virtual_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let virtual_width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(320);
            let virtual_height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(180);
            let region_width = config.width.clamp(320, virtual_width);
            let region_height = config.height.clamp(180, virtual_height);
            let region_x = config
                .x
                .clamp(virtual_x, virtual_x + virtual_width - region_width);
            let region_y = config
                .y
                .clamp(virtual_y, virtual_y + virtual_height - region_height);

            // The preset rectangle defines the placement area, not the ghost
            // window's outer edge. Keep a comfortable inset and cap the card
            // size so large/full-screen capture regions never stretch the
            // question/answer panel from edge to edge.
            let width = region_width
                .saturating_sub(64)
                .max(320)
                .min(960)
                .min(region_width);
            let height = region_height
                .saturating_sub(64)
                .max(180)
                .min(620)
                .min(region_height);
            let x = region_x + (region_width - width) / 2;
            let y = region_y + (region_height - height) / 2;
            (x, y, width, height)
        }
    }

    unsafe fn draw_native_ghost_text(
        hdc: windows_sys::Win32::Graphics::Gdi::HDC,
        value: &str,
        rect: &mut RECT,
        format: u32,
        color: u32,
    ) {
        if value.is_empty() {
            return;
        }
        let encoded: Vec<u16> = value.encode_utf16().collect();
        SetTextColor(hdc, color);
        DrawTextW(
            hdc,
            encoded.as_ptr(),
            encoded.len().min(i32::MAX as usize) as i32,
            rect,
            format,
        );
    }

    unsafe fn paint_native_ghost(hwnd: HWND) {
        let mut paint: PAINTSTRUCT = zeroed();
        let hdc = BeginPaint(hwnd, &mut paint);
        if hdc.is_null() {
            return;
        }

        let mut client: RECT = zeroed();
        if GetClientRect(hwnd, &mut client) == 0 {
            EndPaint(hwnd, &paint);
            return;
        }

        let background = *NATIVE_GHOST_BG_BRUSH.get_or_init(|| {
            // COLORREF is 0x00BBGGRR. Keep the panel dark enough for text
            // while the layered-window alpha reveals the application below.
            CreateSolidBrush(0x0028_1a_10) as usize
        }) as HBRUSH;
        let card = *NATIVE_GHOST_CARD_BRUSH.get_or_init(|| CreateSolidBrush(0x0040_2c_18) as usize)
            as HBRUSH;
        let border = *NATIVE_GHOST_BORDER_BRUSH
            .get_or_init(|| CreateSolidBrush(0x00e8_d327) as usize) as HBRUSH;
        FillRect(hdc, &client, background);
        FrameRect(hdc, &client, border);
        SetBkMode(hdc, TRANSPARENT as i32);
        let stock_font = GetStockObject(DEFAULT_GUI_FONT);
        if !stock_font.is_null() {
            SelectObject(hdc, stock_font);
        }

        let content = native_ghost()
            .lock()
            .map(|guard| guard.content.clone())
            .unwrap_or_default();
        let width = (client.right - client.left).max(1);
        let padding = if width >= 900 { 24 } else { 16 };
        let inner_left = client.left + padding;
        let inner_right = client.right - padding;

        let title = if content.session_title.trim().is_empty() {
            "AgentWithU · Smooth".to_string()
        } else {
            format!("AgentWithU · {}", content.session_title.trim())
        };
        let mut title_rect = RECT {
            left: inner_left,
            top: client.top + 12,
            right: inner_right,
            bottom: client.top + 38,
        };
        draw_native_ghost_text(
            hdc,
            &title,
            &mut title_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            0x00ff_ffff,
        );

        let activity = if content.is_streaming {
            "正在回答…"
        } else {
            "回答已更新"
        };
        let backend = if content.backend_label.trim().is_empty() {
            activity.to_string()
        } else {
            format!("{}  ·  {}", content.backend_label.trim(), activity)
        };
        let mut backend_rect = RECT {
            left: inner_left,
            top: client.top + 38,
            right: inner_right,
            bottom: client.top + 62,
        };
        draw_native_ghost_text(
            hdc,
            &backend,
            &mut backend_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            0x00e8_d327,
        );

        let footer_height = 30;
        let content_top = client.top + 72;
        let content_bottom = (client.bottom - footer_height).max(content_top + 48);
        let conversation_card = RECT {
            left: inner_left,
            top: content_top,
            right: inner_right,
            bottom: content_bottom,
        };
        FillRect(hdc, &conversation_card, card);
        FrameRect(hdc, &conversation_card, border);
        let viewport = RECT {
            left: conversation_card.left + 12,
            top: conversation_card.top + 10,
            right: conversation_card.right - 12,
            bottom: conversation_card.bottom - 10,
        };
        let transcript = if !content.history_text.trim().is_empty() {
            content.history_text.trim().to_string()
        } else {
            let question = if content.question.trim().is_empty() {
                "你：等待当前会话的问题…".to_string()
            } else {
                format!("你：\n{}", content.question.trim())
            };
            let answer = if content.answer.trim().is_empty() {
                if content.is_streaming {
                    "AgentWithU：\n正在生成回答…".to_string()
                } else {
                    "AgentWithU：\n当前会话还没有回答。".to_string()
                }
            } else {
                format!("AgentWithU：\n{}", content.answer.trim())
            };
            format!("{question}\n\n{answer}")
        };
        let encoded: Vec<u16> = transcript.encode_utf16().collect();
        let mut measure = RECT {
            left: 0,
            top: 0,
            right: (viewport.right - viewport.left).max(1),
            bottom: 0,
        };
        DrawTextW(
            hdc,
            encoded.as_ptr(),
            encoded.len().min(i32::MAX as usize) as i32,
            &mut measure,
            DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX | DT_CALCRECT,
        );
        let viewport_height = (viewport.bottom - viewport.top).max(1);
        let text_height = (measure.bottom - measure.top).max(1) + 8;
        let max_scroll = text_height.saturating_sub(viewport_height).max(0);
        let scroll_y = if let Ok(mut guard) = native_ghost().lock() {
            if guard.hwnd == hwnd as isize {
                guard.max_scroll = max_scroll;
                guard.scroll_y = if guard.follow_latest {
                    max_scroll
                } else {
                    guard.scroll_y.clamp(0, max_scroll)
                };
                if guard.scroll_y >= max_scroll {
                    guard.follow_latest = true;
                }
                guard.scroll_y
            } else {
                max_scroll
            }
        } else {
            max_scroll
        };
        let saved_dc = SaveDC(hdc);
        IntersectClipRect(
            hdc,
            viewport.left,
            viewport.top,
            viewport.right,
            viewport.bottom,
        );
        let mut transcript_rect = RECT {
            left: viewport.left,
            top: viewport.top - scroll_y,
            right: viewport.right,
            bottom: viewport.top - scroll_y + text_height,
        };
        draw_native_ghost_text(
            hdc,
            &transcript,
            &mut transcript_rect,
            DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX,
            0x00f7_eee6,
        );
        if saved_dc != 0 {
            RestoreDC(hdc, saved_dc);
        }

        let mut footer_rect = RECT {
            left: inner_left,
            top: client.bottom - footer_height,
            right: inner_right,
            bottom: client.bottom - 4,
        };
        let footer = if max_scroll > 0 {
            let percent = ((scroll_y as i64 * 100) / max_scroll.max(1) as i64).clamp(0, 100);
            format!("滚轮浏览会话历史 · {percent}% · 左 Shift + 左键双击隐藏 · 不抢焦点")
        } else {
            "左 Shift + 左键双击隐藏 · 浮层不接收鼠标和键盘焦点".to_string()
        };
        draw_native_ghost_text(
            hdc,
            &footer,
            &mut footer_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            0x00b8_a08d,
        );

        EndPaint(hwnd, &paint);
    }

    unsafe extern "system" fn native_ghost_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_PAINT => {
                paint_native_ghost(hwnd);
                return 0;
            }
            WM_NCHITTEST => return HTTRANSPARENT as LRESULT,
            WM_MOUSEACTIVATE => return MA_NOACTIVATE as LRESULT,
            WM_CLOSE => {
                NATIVE_GHOST_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
                if let Ok(mut guard) = native_ghost().lock() {
                    guard.visible = false;
                }
                ShowWindow(hwnd, SW_HIDE);
                crate::desktop_log("[smooth-ghost] native ghost hidden by close request");
                return 0;
            }
            WM_DESTROY => {
                if let Ok(mut guard) = native_ghost().lock() {
                    if guard.hwnd == hwnd as isize {
                        guard.hwnd = 0;
                        guard.visible = false;
                    }
                }
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    unsafe fn apply_native_ghost_visibility(
        hwnd: HWND,
        config: &HackerMonitorConfig,
        visible: bool,
    ) {
        if !visible {
            if let Ok(mut guard) = native_ghost().lock() {
                guard.visible = false;
            }
            ShowWindow(hwnd, SW_HIDE);
            return;
        }
        let (x, y, width, height) = native_ghost_rect(config);
        if let Ok(mut guard) = native_ghost().lock() {
            if !guard.visible {
                guard.follow_latest = true;
            }
            guard.rect = (x, y, width, height);
            guard.visible = true;
        }
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        InvalidateRect(hwnd, core::ptr::null(), 1);
    }

    unsafe fn run_native_ghost(config: HackerMonitorConfig) -> Result<(), String> {
        let module = GetModuleHandleW(core::ptr::null());
        if module.is_null() {
            return Err(format!(
                "GetModuleHandleW failed (Windows error {})",
                GetLastError()
            ));
        }

        let class_name = wide("AgentWithUSmoothNativeGhost");
        let background = *NATIVE_GHOST_BG_BRUSH
            .get_or_init(|| CreateSolidBrush(0x0028_1a_10) as usize)
            as HBRUSH;
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(native_ghost_proc),
            hInstance: module,
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: background,
            lpszClassName: class_name.as_ptr(),
            ..zeroed()
        };
        if RegisterClassW(&window_class) == 0 {
            let code = GetLastError();
            if code != ERROR_CLASS_ALREADY_EXISTS {
                return Err(format!("RegisterClassW failed (Windows error {code})"));
            }
        }

        let (x, y, width, height) = native_ghost_rect(&config);
        let title = wide("AgentWithU · Smooth Ghost");
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            x,
            y,
            width,
            height,
            null_mut(),
            null_mut(),
            module,
            core::ptr::null(),
        );
        if hwnd.is_null() {
            return Err(format!(
                "CreateWindowExW failed (Windows error {})",
                GetLastError()
            ));
        }
        if SetLayeredWindowAttributes(hwnd, 0, 222, LWA_ALPHA) == 0 {
            crate::desktop_log(format!(
                "[smooth-ghost] native alpha unavailable (Windows error {}); using opaque fallback",
                GetLastError()
            ));
        }
        if let Ok(mut guard) = native_ghost().lock() {
            guard.hwnd = hwnd as isize;
        }
        NATIVE_GHOST_CREATING.store(false, Ordering::SeqCst);
        let visible = NATIVE_GHOST_DESIRED_VISIBLE.load(Ordering::SeqCst);
        apply_native_ghost_visibility(hwnd, &config, visible);
        UpdateWindow(hwnd);
        crate::desktop_log(format!(
            "[smooth-ghost] native ghost created; visible={} rect=({}, {}, {}x{})",
            visible, x, y, width, height
        ));

        let mut message: MSG = zeroed();
        loop {
            let status = GetMessageW(&mut message, null_mut(), 0, 0);
            if status == -1 {
                DestroyWindow(hwnd);
                return Err(format!(
                    "native ghost message loop failed (Windows error {})",
                    GetLastError()
                ));
            }
            if status == 0 {
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        Ok(())
    }

    fn toggle_native_ghost(app: AppHandle, config: HackerMonitorConfig) {
        let show = !NATIVE_GHOST_DESIRED_VISIBLE.fetch_xor(true, Ordering::SeqCst);
        let hwnd = native_ghost_hwnd();
        if !hwnd.is_null() {
            unsafe { apply_native_ghost_visibility(hwnd, &config, show) };
            crate::desktop_log(if show {
                "[smooth-ghost] native ghost shown"
            } else {
                "[smooth-ghost] native ghost hidden"
            });
            return;
        }
        if !show {
            crate::desktop_log("[smooth-ghost] hide requested before native ghost was ready");
            return;
        }
        if NATIVE_GHOST_CREATING.swap(true, Ordering::SeqCst) {
            crate::desktop_log("[smooth-ghost] native ghost creation already in progress");
            return;
        }

        crate::desktop_log("[smooth-ghost] starting native ghost thread");
        let spawn_result = std::thread::Builder::new()
            .name("smooth-native-ghost".into())
            .spawn(move || {
                if let Err(error) = unsafe { run_native_ghost(config) } {
                    NATIVE_GHOST_CREATING.store(false, Ordering::SeqCst);
                    NATIVE_GHOST_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
                    crate::desktop_log(format!("[smooth-ghost] ERROR {error}"));
                    let _ = app.emit_to(
                        "main",
                        "smooth-error",
                        format!("原生幽灵窗口启动失败：{error}"),
                    );
                }
            });
        if let Err(error) = spawn_result {
            NATIVE_GHOST_CREATING.store(false, Ordering::SeqCst);
            NATIVE_GHOST_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
            crate::desktop_log(format!(
                "[smooth-ghost] ERROR cannot start native ghost thread: {error}"
            ));
        }
    }

    fn hide_native_ghost() {
        NATIVE_GHOST_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
        let hwnd = native_ghost_hwnd();
        if let Ok(mut guard) = native_ghost().lock() {
            guard.visible = false;
        }
        if !hwnd.is_null() && unsafe { IsWindowVisible(hwnd) } != 0 {
            unsafe { ShowWindow(hwnd, SW_HIDE) };
            crate::desktop_log("[smooth-ghost] native ghost hidden because Smooth is disabled");
        }
    }

    pub fn update_ghost_content(mut content: SmoothGhostContent) {
        content.session_id = truncate_chars(content.session_id, 160);
        content.session_title = truncate_chars(content.session_title, 240);
        content.backend_label = truncate_chars(content.backend_label, 240);
        content.question = truncate_chars(content.question, 1_500);
        content.answer = truncate_chars(content.answer, 12_000);
        content.history_text = truncate_tail_chars(content.history_text, 60_000);
        let hwnd = if let Ok(mut guard) = native_ghost().lock() {
            if guard.content.session_id != content.session_id {
                guard.scroll_y = 0;
                guard.max_scroll = 0;
                guard.follow_latest = true;
            }
            guard.content = content;
            guard.hwnd as HWND
        } else {
            null_mut()
        };
        if !hwnd.is_null() && unsafe { IsWindow(hwnd) } != 0 {
            unsafe { InvalidateRect(hwnd, core::ptr::null(), 1) };
        }
    }

    unsafe fn update_native_selector_title(hwnd: windows_sys::Win32::Foundation::HWND) {
        let mut rect: RECT = zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let title = wide(&format!(
            "Smooth 选区  X:{}  Y:{}  {}×{}  |  拖动标题栏移动 · 拖动边框缩放 · Enter 保存 · Esc 取消",
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top
        ));
        SetWindowTextW(hwnd, title.as_ptr());
    }

    unsafe extern "system" fn native_selector_proc(
        hwnd: windows_sys::Win32::Foundation::HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
            return 1;
        }

        match message {
            WM_KEYDOWN if wparam as u16 == VK_RETURN => {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut NativeSelectorState;
                let mut rect: RECT = zeroed();
                if !state.is_null() && GetWindowRect(hwnd, &mut rect) != 0 {
                    (*state).result = Some(SmoothRegionSelection {
                        x: rect.left,
                        y: rect.top,
                        width: (rect.right - rect.left).max(80),
                        height: (rect.bottom - rect.top).max(80),
                    });
                }
                DestroyWindow(hwnd);
                return 0;
            }
            WM_KEYDOWN if wparam as u16 == VK_ESCAPE => {
                DestroyWindow(hwnd);
                return 0;
            }
            WM_MOVE | WM_SIZE => {
                update_native_selector_title(hwnd);
            }
            WM_CLOSE => {
                // The title-bar close button has the same meaning as Esc.
                DestroyWindow(hwnd);
                return 0;
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    unsafe fn run_native_selector(
        selection: SmoothRegionSelection,
    ) -> Result<Option<SmoothRegionSelection>, String> {
        let module = GetModuleHandleW(core::ptr::null());
        if module.is_null() {
            return Err(format!(
                "GetModuleHandleW failed (Windows error {})",
                GetLastError()
            ));
        }

        let class_name = wide("AgentWithUSmoothNativeSelector");
        let brush = *NATIVE_SELECTOR_BRUSH.get_or_init(|| {
            // COLORREF is 0x00BBGGRR: a dark cyan surface that remains visible
            // even when a machine disables layered-window alpha.
            CreateSolidBrush(0x004b_2a_0a) as usize
        }) as HBRUSH;
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(native_selector_proc),
            hInstance: module,
            hCursor: LoadCursorW(null_mut(), IDC_SIZEALL),
            hbrBackground: brush,
            lpszClassName: class_name.as_ptr(),
            ..zeroed()
        };
        if RegisterClassW(&window_class) == 0 {
            let code = GetLastError();
            if code != ERROR_CLASS_ALREADY_EXISTS {
                return Err(format!("RegisterClassW failed (Windows error {code})"));
            }
        }

        let virtual_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let virtual_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let virtual_width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(320);
        let virtual_height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(180);
        let width = selection.width.clamp(320, virtual_width);
        let height = selection.height.clamp(180, virtual_height);
        let x = selection
            .x
            .clamp(virtual_x, virtual_x + virtual_width - width);
        let y = selection
            .y
            .clamp(virtual_y, virtual_y + virtual_height - height);

        let mut state = Box::new(NativeSelectorState { result: None });
        let title = wide("Smooth 选区 | Enter 保存 · Esc 取消");
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_CAPTION | WS_SYSMENU | WS_THICKFRAME,
            x,
            y,
            width,
            height,
            null_mut(),
            null_mut(),
            module,
            (&mut *state as *mut NativeSelectorState).cast(),
        );
        if hwnd.is_null() {
            return Err(format!(
                "CreateWindowExW failed (Windows error {})",
                GetLastError()
            ));
        }

        if SetLayeredWindowAttributes(hwnd, 0, 190, LWA_ALPHA) == 0 {
            crate::desktop_log(format!(
                "[smooth-region] native alpha unavailable (Windows error {}); using opaque fallback",
                GetLastError()
            ));
        }
        ShowWindow(hwnd, SW_SHOWNORMAL);
        UpdateWindow(hwnd);
        SetForegroundWindow(hwnd);
        update_native_selector_title(hwnd);
        crate::desktop_log(format!(
            "[smooth-region] Win32 selector shown; rect=({}, {}, {}x{})",
            x, y, width, height
        ));

        let mut message: MSG = zeroed();
        loop {
            let status = GetMessageW(&mut message, null_mut(), 0, 0);
            if status == -1 {
                DestroyWindow(hwnd);
                return Err(format!(
                    "native selector message loop failed (Windows error {})",
                    GetLastError()
                ));
            }
            if status == 0 {
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        Ok(state.result.clone())
    }

    pub fn open_region_selector(
        app: AppHandle,
        selection: SmoothRegionSelection,
    ) -> Result<(), String> {
        crate::desktop_log(format!(
            "[smooth-region] native request received; saved_rect=({}, {}, {}x{})",
            selection.x, selection.y, selection.width, selection.height
        ));
        if NATIVE_SELECTOR_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("选区浮框已经打开，请先确认或取消当前选区".into());
        }

        std::thread::Builder::new()
            .name("smooth-native-selector".into())
            .spawn(move || {
                let result = unsafe { run_native_selector(selection) };
                match result {
                    Ok(Some(selected)) => {
                        crate::desktop_log(format!(
                            "[smooth-region] native selector confirmed; rect=({}, {}, {}x{})",
                            selected.x, selected.y, selected.width, selected.height
                        ));
                        if let Err(error) = app.emit_to("main", "smooth-region-selected", selected)
                        {
                            crate::desktop_log(format!(
                                "[smooth-region] ERROR emit selection: {error}"
                            ));
                        }
                    }
                    Ok(None) => {
                        crate::desktop_log("[smooth-region] native selector cancelled");
                    }
                    Err(error) => {
                        crate::desktop_log(format!("[smooth-region] ERROR {error}"));
                        let _ = app.emit_to(
                            "main",
                            "smooth-error",
                            format!("原生选区浮框启动失败：{error}"),
                        );
                    }
                }
                NATIVE_SELECTOR_RUNNING.store(false, Ordering::SeqCst);
            })
            .map_err(|error| {
                NATIVE_SELECTOR_RUNNING.store(false, Ordering::SeqCst);
                format!("cannot start native selector thread: {error}")
            })?;
        crate::desktop_log("[smooth-region] native selector thread started");
        Ok(())
    }

    fn spawn_hook_thread() -> Result<(), String> {
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || unsafe {
            // A null module handle happens to work on some Windows builds for
            // low-level hooks, but is rejected on others.  Use the executable
            // module explicitly so packaged clients behave consistently.
            let module = GetModuleHandleW(core::ptr::null());
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0);
            if hook.is_null() {
                let code = GetLastError();
                let _ = ready_tx.send(Err(format!(
                    "failed to install global mouse hook (Windows error {code})"
                )));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            let mut msg: MSG = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "timed out while installing global mouse hook".to_string())?
    }

    pub fn configure(app: AppHandle, config: HackerMonitorConfig) -> Result<(), String> {
        crate::desktop_log(format!(
            "[smooth] configure enabled={} button={} double_click_ms={}",
            config.enabled, config.mouse_button, config.double_click_ms
        ));
        let enabled = config.enabled;
        let ghost_config = config.clone();
        let should_start_hook = {
            let mut guard = state().lock().map_err(|_| "smooth monitor lock poisoned")?;
            guard.app = Some(app.clone());
            guard.config = config;
            guard.last_down = None;
            guard.last_panel_down = None;
            guard.last_capture_action = None;
            guard.last_panel_action = None;
            let should_start = guard.config.enabled && !guard.hook_started;
            if should_start {
                // Reserve startup so overlapping configuration updates do not
                // create two global hook threads.
                guard.hook_started = true;
            }
            should_start
        };

        if should_start_hook {
            if let Err(error) = ensure_trigger_worker() {
                if let Ok(mut guard) = state().lock() {
                    guard.hook_started = false;
                }
                crate::desktop_log(format!("[smooth] ERROR trigger worker: {error}"));
                return Err(error);
            }
            if let Err(error) = spawn_hook_thread() {
                if let Ok(mut guard) = state().lock() {
                    guard.hook_started = false;
                }
                crate::desktop_log(format!("[smooth] ERROR global mouse hook: {error}"));
                return Err(error);
            }
            crate::desktop_log("[smooth] global mouse hook installed");
        }

        // Managed Windows machines in the field can block every second
        // WebView2. The ghost is now pure Win32 and is created only on the
        // first Left-Shift gesture, so configuration itself always returns quickly.
        if !enabled {
            hide_native_ghost();
        } else if NATIVE_GHOST_DESIRED_VISIBLE.load(Ordering::SeqCst) {
            let hwnd = native_ghost_hwnd();
            if !hwnd.is_null() {
                unsafe { apply_native_ghost_visibility(hwnd, &ghost_config, true) };
            }
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowW, GetWindowLongW, PostMessageW, GWL_EXSTYLE,
        };

        #[test]
        fn ghost_wheel_scrolls_history_and_refollows_at_bottom() {
            assert_eq!(next_native_ghost_scroll(500, 1_000, 120), (428, false));
            assert_eq!(next_native_ghost_scroll(980, 1_000, -120), (1_000, true));
            assert_eq!(next_native_ghost_scroll(0, 1_000, 240), (0, false));
        }

        #[test]
        #[ignore = "opens a real Windows selector window"]
        fn native_selector_window_opens_and_closes() {
            let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let result = unsafe {
                    run_native_selector(SmoothRegionSelection {
                        x: 120,
                        y: 120,
                        width: 720,
                        height: 420,
                    })
                };
                let _ = done_tx.send(result);
            });

            let class_name = wide("AgentWithUSmoothNativeSelector");
            let deadline = Instant::now() + Duration::from_secs(5);
            let hwnd = loop {
                let hwnd = unsafe { FindWindowW(class_name.as_ptr(), core::ptr::null()) };
                if !hwnd.is_null() {
                    break hwnd;
                }
                assert!(
                    Instant::now() < deadline,
                    "native selector window did not appear"
                );
                std::thread::sleep(Duration::from_millis(50));
            };
            unsafe {
                PostMessageW(hwnd, WM_KEYDOWN, VK_ESCAPE as usize, 0);
            }
            let result = done_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("native selector did not close")
                .expect("native selector returned an error");
            assert!(result.is_none(), "Esc must cancel without saving a region");
        }

        #[test]
        #[ignore = "opens a real Windows ghost overlay"]
        fn native_ghost_opens_click_through_without_activation() {
            NATIVE_GHOST_DESIRED_VISIBLE.store(true, Ordering::SeqCst);
            let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
            let config = HackerMonitorConfig {
                enabled: true,
                x: 140,
                y: 140,
                width: 1_200,
                height: 800,
                ..HackerMonitorConfig::default()
            };
            let expected_rect = native_ghost_rect(&config);
            std::thread::spawn(move || {
                let result = unsafe { run_native_ghost(config) };
                let _ = done_tx.send(result);
            });

            let class_name = wide("AgentWithUSmoothNativeGhost");
            let deadline = Instant::now() + Duration::from_secs(5);
            let hwnd = loop {
                let hwnd = unsafe { FindWindowW(class_name.as_ptr(), core::ptr::null()) };
                if !hwnd.is_null() {
                    break hwnd;
                }
                assert!(
                    Instant::now() < deadline,
                    "native ghost window did not appear"
                );
                std::thread::sleep(Duration::from_millis(50));
            };
            assert_ne!(unsafe { IsWindowVisible(hwnd) }, 0);
            let style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
            assert_ne!(style & WS_EX_NOACTIVATE, 0);
            assert_ne!(style & WS_EX_TRANSPARENT, 0);
            assert_ne!(style & WS_EX_TOOLWINDOW, 0);
            let mut rect: RECT = unsafe { zeroed() };
            assert_ne!(unsafe { GetWindowRect(hwnd, &mut rect) }, 0);
            assert_eq!(
                (
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top
                ),
                expected_rect
            );
            assert!((rect.right - rect.left) <= 960);
            assert!((rect.bottom - rect.top) <= 620);

            // The test-only posted destroy message lets the owning thread exit.
            unsafe { PostMessageW(hwnd, WM_DESTROY, 0, 0) };
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("native ghost thread did not close")
                .expect("native ghost returned an error");
            NATIVE_GHOST_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
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
    pub fn open_region_selector(
        _app: AppHandle,
        _selection: SmoothRegionSelection,
    ) -> Result<(), String> {
        Err("Smooth 区域选择器目前仅支持 Windows".into())
    }
    pub fn update_ghost_content(_content: SmoothGhostContent) {}
}

#[tauri::command]
pub fn configure_hacker_monitor(app: AppHandle, config: HackerMonitorConfig) -> Result<(), String> {
    platform::configure(app, config)
}

#[tauri::command]
pub fn capture_hacker_screenshot(config: HackerCaptureConfig) -> Result<HackerImage, String> {
    crate::desktop_log(format!(
        "[smooth-capture] request received; mode={} rect=({}, {}, {}x{})",
        config.mode, config.x, config.y, config.width, config.height
    ));
    match platform::capture(config) {
        Ok(image) => {
            crate::desktop_log(format!(
                "[smooth-capture] completed; {}x{} {} bytes",
                image.width, image.height, image.size
            ));
            Ok(image)
        }
        Err(error) => {
            crate::desktop_log(format!("[smooth-capture] ERROR {error}"));
            Err(error)
        }
    }
}

#[tauri::command]
pub fn update_smooth_ghost_state(state: SmoothGhostContent) {
    platform::update_ghost_content(state)
}

#[tauri::command]
pub fn open_smooth_region_selector(
    app: AppHandle,
    selection: SmoothRegionSelection,
) -> Result<(), String> {
    platform::open_region_selector(app, selection)
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
    crate::desktop_log(format!(
        "[smooth-region] finish requested; confirmed={}",
        selection.is_some()
    ));
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

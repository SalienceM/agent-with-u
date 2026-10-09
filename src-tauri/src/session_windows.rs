//! 会话窗口仅拥有视图权限；关闭当前子窗口不能退出应用或结束 sidecar。
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

pub fn is_session_window(label: &str) -> bool {
    label.strip_prefix("session-").is_some_and(|id| {
        !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}
pub fn allows_documents(label: &str) -> bool { label == "main" || is_session_window(label) }

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitState { dirty_documents: usize, pending_saves: usize, terminals: usize, #[serde(default)] language_services: usize }
#[derive(Default)]
pub struct WindowExitStates(Mutex<HashMap<String, ExitState>>);

#[tauri::command]
pub fn report_workbench_exit_state(window: tauri::Window, state: ExitState, states: tauri::State<WindowExitStates>) -> Result<(), String> {
    if !allows_documents(window.label()) || state.dirty_documents > 128 || state.pending_saves > 128 || state.terminals > 64 || state.language_services > 64 {
        return Err("window_state_unavailable".into());
    }
    states.0.lock().map_err(|_| "window_state_unavailable")?.insert(window.label().into(), state);
    Ok(())
}
pub fn exit_message(app: &tauri::AppHandle) -> String {
    let live = app.webview_windows();
    let states = app.state::<WindowExitStates>();
    let totals = states.0.lock().map(|rows| rows.iter().filter(|(label, _)| live.contains_key(*label))
        .fold((0, 0, 0, 0), |(d, p, t, l), (_, row)| (d + row.dirty_documents, p + row.pending_saves, t + row.terminals, l + row.language_services))).unwrap_or_default();
    format!("将关闭全部窗口和本机执行端，正在运行的模型、终端与语言服务会受到影响。\n窗口已报告：{} 个未保存文件，{} 个待核对保存，{} 个终端，{} 个语言服务（跨窗口计数可能重复）。\n未报告或断开的窗口/资源状态未知；不会自动保存、丢弃或重放命令。\n仅关闭主窗口到托盘可保持后台运行。仍要彻底退出？", totals.0, totals.1, totals.2, totals.3)
}

#[tauri::command]
pub fn close_session_window(window: tauri::Window) -> Result<(), String> {
    if !is_session_window(window.label()) { return Err("not_session_window".into()); }
    window.destroy().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_windows_cannot_use_session_documents_or_close_main() {
        assert!(allows_documents("main")); assert!(!is_session_window("main"));
        assert!(allows_documents("session-abc_123"));
        for label in ["thoughts-assistant", "scratchpad", "session-", "session-../main", "session-/main", "smooth-ghost"] {
            assert!(!allows_documents(label)); assert!(!is_session_window(label));
        }
    }
}

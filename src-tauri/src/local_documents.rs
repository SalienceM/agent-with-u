//! Tauri 入口只核验窗口并托管 worker；原生文件协议也由无 UI 验收入口直接测试。
#[path = "local_documents_core.rs"]
mod core;
use core::{BoundRoot, ByteDocument, Version};
use core::{ReviewRead, ReviewReceipt};

#[tauri::command]
pub async fn local_sync_review_read(window: tauri::Window, dir: String, binding_id: String, rel: String) -> Result<ReviewRead, String> {
    allow_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || core::review_read(&dir, &binding_id, &rel)).await.map_err(|_| "document_worker_failed")?
}
#[tauri::command]
pub async fn local_sync_review_apply(window: tauri::Window, dir: String, binding_id: String, rel: String,
    baseline: Option<Version>, data: String, scope_key: String, request_id: String) -> Result<ReviewReceipt, String> {
    allow_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || core::review_apply(&dir, &binding_id, &rel, baseline.as_ref(), &data, &scope_key, &request_id))
        .await.map_err(|_| "save_result_unverified")?
}
#[tauri::command]
pub async fn local_sync_review_get(window: tauri::Window, binding_id: String, scope_key: String, request_id: String) -> Result<ReviewReceipt, String> {
    allow_window(&window)?;
    core::review_get(&binding_id, &scope_key, &request_id)
}

fn allow_window(window: &tauri::Window) -> Result<(), String> {
    if !crate::session_windows::allows_documents(window.label()) {
        return Err("document_window_unavailable".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn local_document_bind(window: tauri::Window, dir: String) -> Result<BoundRoot, String> {
    allow_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || core::bind(&dir))
        .await
        .map_err(|_| "document_worker_failed")?
}

#[tauri::command]
pub async fn local_document_read(
    window: tauri::Window,
    dir: String,
    binding_id: String,
    rel: String,
) -> Result<ByteDocument, String> {
    allow_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || core::read(&dir, &binding_id, &rel))
        .await
        .map_err(|_| "document_worker_failed")?
}

#[tauri::command]
pub async fn local_document_replace(
    window: tauri::Window,
    dir: String,
    binding_id: String,
    rel: String,
    baseline: Version,
    data: String,
) -> Result<ByteDocument, String> {
    allow_window(&window)?;
    // worker 持有核心 I/O 锁到实际完成；等待者取消不会释放写保护。
    tauri::async_runtime::spawn_blocking(move || {
        core::replace(&dir, &binding_id, &rel, &baseline, &data)
    })
    .await
    .map_err(|_| "save_result_unverified")?
}

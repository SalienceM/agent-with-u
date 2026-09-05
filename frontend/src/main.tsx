import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ScratchPadWindow, isScratchPadWindow } from './components/ScratchPad';
import { ThoughtsAssistantWindow, isThoughtsWindow } from './components/ThoughtsAssistant';
import { SmoothRegionSelector, isSmoothRegionSelector } from './components/SmoothRegionSelector';
import { SmoothGhostWindow, isSmoothGhostWindow } from './components/SmoothGhostWindow';
import { api } from './api';
import { installGlobalStreamRouter } from './hooks/useStreamState';
import { ErrorBoundary } from './components/ErrorBoundary';

// Web/平板缓存应用外壳；文件正文另存于 IndexedDB。Tauri 不注册，避免与
// sidecar 的版本更新产生双重缓存。
if (!isScratchPadWindow && !isThoughtsWindow && !isSmoothGhostWindow && !isSmoothRegionSelector
  && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  && typeof (window as any).__TAURI_INTERNALS__ === 'undefined') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('[offline] service worker registration failed', error);
    });
  });
}

// ── 最后防线：全局错误处理，捕获 React 挂载前 / 模块加载时的 JS 崩溃 ──
// 如果 React 因模块级错误无法渲染，此处理器直接往 DOM 写诊断信息，避免白屏。
let _reactMounted = false;
window.addEventListener('error', (ev) => {
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('report_desktop_log', {
    source: 'frontend-error',
    message: String(ev.error?.stack || ev.error || ev.message || 'Unknown error'),
  })).catch(() => {});
  if (_reactMounted) return; // React 已接管，交给 ErrorBoundary
  const root = document.getElementById('root');
  if (!root || root.hasChildNodes()) return;
  const err = ev.error || ev.message || 'Unknown error';
  root.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100vh;background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;gap:12px;padding:24px">
      <div style="font-size:48px">⚠️</div>
      <h2 style="font-size:18px;color:#ef4444;margin:0">AgentWithU 启动失败</h2>
      <p style="font-size:13px;color:#999;text-align:center;max-width:480px">
        应用初始化时发生错误，请重新加载或检查日志。<br/>
        日志路径: %APPDATA%\\AgentWithU\\logs\\backend.log
      </p>
      <details style="max-width:600px;width:100%;margin-top:8px">
        <summary style="cursor:pointer;font-size:13px;color:#818cf8">错误详情</summary>
        <pre style="background:rgba(0,0,0,0.3);border-radius:8px;padding:12px;font-size:12px;
          color:#ccc;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all"
        >${String(err).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
      </details>
      <button onclick="location.reload()" style="padding:8px 20px;border-radius:6px;border:none;
        cursor:pointer;background:#818cf8;color:#fff;font-size:13px;margin-top:8px">
        🔄 重新加载
      </button>
    </div>`;
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[main] Unhandled promise rejection:', ev.reason);
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('report_desktop_log', {
    source: 'frontend-rejection',
    message: String(ev.reason?.stack || ev.reason || 'Unknown rejection'),
  })).catch(() => {});
});

// 全局流路由：所有 session 的 streamDelta 都进 streamStates Map,不论 UI 当前
// 看的是哪个 session。必须在 React 挂载之前装,确保它的订阅者排在 useChat
// 的订阅者之前(forEach 按 push 顺序触发)。
if (!isSmoothGhostWindow && !isSmoothRegionSelector && !isScratchPadWindow) {
  installGlobalStreamRouter(api);
}

// ── Zoom manager (Ctrl+wheel / Ctrl++/-/0) ──────────────────────────────────
// Uses Tauri v2 webview.setZoom() in Tauri mode; no-op in browser dev mode.

const ZOOM_STORAGE_KEY = 'agentwithu-zoom';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1.0;

function clampZoom(v: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) * 100) / 100;
}

async function applyZoom(level: number) {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().setZoom(level);
  } catch {
    // Not in Tauri — ignore
  }
}

let currentZoom: number = clampZoom(parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY) || '1') || ZOOM_DEFAULT);

// Apply saved zoom immediately on startup
applyZoom(currentZoom);

function changeZoom(delta: number) {
  currentZoom = clampZoom(currentZoom + delta);
  localStorage.setItem(ZOOM_STORAGE_KEY, String(currentZoom));
  applyZoom(currentZoom);
}

function resetZoom() {
  currentZoom = ZOOM_DEFAULT;
  localStorage.setItem(ZOOM_STORAGE_KEY, String(currentZoom));
  applyZoom(currentZoom);
}

// Ctrl + scroll wheel
window.addEventListener('wheel', (e: WheelEvent) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  changeZoom(delta);
}, { passive: false });

// Ctrl + +/-/0 keyboard shortcuts
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); changeZoom(ZOOM_STEP); }
  else if (e.key === '-') { e.preventDefault(); changeZoom(-ZOOM_STEP); }
  else if (e.key === '0') { e.preventDefault(); resetZoom(); }
});

const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { overflow: hidden; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
  @keyframes blink { 50% { opacity: 0; } }
  .code-block {
    background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px 14px;
    margin: 8px 0; overflow-x: auto;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px; line-height: 1.5; color: #d4d4d4;
  }
  .inline-code {
    background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.9em;
  }
  a { color: #818cf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isSmoothGhostWindow
      ? <SmoothGhostWindow />
      : isSmoothRegionSelector
        ? <SmoothRegionSelector />
        : isScratchPadWindow
          ? <ScratchPadWindow />
          : isThoughtsWindow
            ? <ThoughtsAssistantWindow />
            : <App />}
  </ErrorBoundary>,
);
_reactMounted = true; // React 已接管，后续错误由 ErrorBoundary 处理

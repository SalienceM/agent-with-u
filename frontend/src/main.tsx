import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ScratchPadWindow, isScratchPadWindow } from './components/ScratchPad';

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
  isScratchPadWindow ? <ScratchPadWindow /> : <App />,
);

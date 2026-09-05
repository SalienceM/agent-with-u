import type { AttentionContext } from './attentionContext';

export const THOUGHTS_WINDOW_CHANNEL = 'awu:thoughts-window:v1';
export const THOUGHTS_WINDOW_LABEL = 'thoughts-assistant';
const PIN_STORAGE_KEY = 'awu.thoughts.window-pinned';

export type ThoughtsWindowMessage =
  | { type: 'request-snapshot' }
  | { type: 'snapshot'; attention: AttentionContext; sessionId: string }
  | { type: 'detached-open' }
  | { type: 'detached-closed' };

let browserWindow: Window | null = null;

export function createThoughtsChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(THOUGHTS_WINDOW_CHANNEL);
  } catch {
    return null;
  }
}

export function loadThoughtsWindowPinned(): boolean {
  try { return localStorage.getItem(PIN_STORAGE_KEY) === '1'; }
  catch { return false; }
}

export function persistThoughtsWindowPinned(pinned: boolean): void {
  try { localStorage.setItem(PIN_STORAGE_KEY, pinned ? '1' : '0'); } catch { /* ignore */ }
}

function thoughtsUrl(sessionId = ''): string {
  const url = new URL(location.href);
  url.searchParams.delete('scratchpad');
  url.searchParams.set('thoughts', '1');
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  else url.searchParams.delete('sessionId');
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function openThoughtsWindow(sessionId = ''): Promise<boolean> {
  const url = thoughtsUrl(sessionId);
  if (typeof (window as any).__TAURI_INTERNALS__ !== 'undefined') {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const existing = await WebviewWindow.getByLabel(THOUGHTS_WINDOW_LABEL).catch(() => null);
      if (existing) {
        await existing.setFocus().catch(() => {});
        return true;
      }
      const child = new WebviewWindow(THOUGHTS_WINDOW_LABEL, {
        url,
        title: '俺寻思 — AgentWithU',
        width: 980,
        height: 820,
        minWidth: 620,
        minHeight: 520,
        resizable: true,
        alwaysOnTop: loadThoughtsWindowPinned(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once('tauri://created', () => resolve());
        child.once('tauri://error', (event) => reject(new Error(String(event.payload || '窗口创建失败'))));
      });
      return true;
    } catch (error) {
      console.warn('[thoughts] native window failed, falling back to browser popup', error);
    }
  }

  browserWindow = window.open(url, 'agent-thoughts-assistant', 'width=980,height=820,resizable=yes,scrollbars=yes');
  if (!browserWindow) return false;
  browserWindow.focus();
  return true;
}

export async function focusThoughtsWindow(): Promise<boolean> {
  if (typeof (window as any).__TAURI_INTERNALS__ !== 'undefined') {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const existing = await WebviewWindow.getByLabel(THOUGHTS_WINDOW_LABEL).catch(() => null);
      if (!existing) return false;
      await existing.setFocus();
      return true;
    } catch { return false; }
  }
  if (!browserWindow || browserWindow.closed) return false;
  browserWindow.focus();
  return true;
}

export async function closeCurrentThoughtsWindow(): Promise<void> {
  if (typeof (window as any).__TAURI_INTERNALS__ !== 'undefined') {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
      return;
    } catch { /* browser fallback */ }
  }
  window.close();
}

export const isThoughtsWindow = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('thoughts');


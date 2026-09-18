import type { AttentionContext } from './attentionContext';
import { detachedUrl, openDetachedWindow, focusDetachedWindow } from './detachedWindow';

export const THOUGHTS_WINDOW_CHANNEL = 'awu:thoughts-window:v1';
export const THOUGHTS_WINDOW_LABEL = 'thoughts-assistant';
const PIN_STORAGE_KEY = 'awu.thoughts.window-pinned';

export type ThoughtsWindowMessage =
  | { type: 'request-snapshot' }
  | { type: 'snapshot'; attention: AttentionContext; sessionId: string }
  | { type: 'detached-open' }
  | { type: 'detached-closed' };


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
  return detachedUrl('thoughts', { sessionId });
}

export async function openThoughtsWindow(sessionId = ''): Promise<boolean> {
  await openDetachedWindow({ label: THOUGHTS_WINDOW_LABEL, url: thoughtsUrl(sessionId),
    title: '俺寻思 — AgentWithU', width: 980, height: 820, minWidth: 620, minHeight: 520,
    alwaysOnTop: loadThoughtsWindowPinned() });
  return true;
}

export async function focusThoughtsWindow(): Promise<boolean> {
  return focusDetachedWindow(THOUGHTS_WINDOW_LABEL);
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

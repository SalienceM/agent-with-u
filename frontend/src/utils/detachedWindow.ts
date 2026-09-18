/** 同源工具窗口：浏览器在点击栈内打开；桌面必须等创建回执，失败不关闭原面板。 */
export interface DetachedWindowOptions {
  label: string; title: string; url: string; width: number; height: number;
  minWidth?: number; minHeight?: number; alwaysOnTop?: boolean;
}
const browserWindows = new Map<string, Window>();
const opening = new Map<string, Promise<void>>();
export const isDesktopWindow = () => typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';

export function detachedUrl(kind: 'scratchpad' | 'thoughts' | 'skillManual', params: Record<string, string> = {}): string {
  const url = new URL(location.href);
  for (const key of ['scratchpad', 'thoughts', 'skillManual', 'sessionId', 'skillName', 'skillExecKey']) url.searchParams.delete(key);
  url.searchParams.set(kind, '1');
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function revealWindow(win: { show(): Promise<void>; unminimize(): Promise<void>; setFocus(): Promise<void> }): Promise<void> {
  await win.show();
  await win.unminimize();
  await win.setFocus();
}

export function openDetachedWindow(options: DetachedWindowOptions): Promise<void> {
  if (!isDesktopWindow()) {
    // 不能先 await import：浏览器用户激活可能在异步边界后丢失。
    try {
      const existing = browserWindows.get(options.label);
      if (existing && !existing.closed) { existing.focus(); return Promise.resolve(); }
      const child = window.open(options.url, `awu-${options.label}`,
        `width=${options.width},height=${options.height},resizable=yes,scrollbars=yes`);
      if (!child) throw new Error('浏览器阻止了独立窗口，请允许本站弹窗后重试。原面板已保留。');
      browserWindows.set(options.label, child);
      child.focus();
      return Promise.resolve();
    } catch (error) { return Promise.reject(error); }
  }
  const pending = opening.get(options.label);
  if (pending) return pending;
  const request = (async () => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(options.label);
    if (existing) { await revealWindow(existing); return; }
    const { label, ...config } = options;
    const child = new WebviewWindow(label, { ...config, resizable: true });
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('桌面窗口创建超时，请检查桌面日志后重试。')), 10_000);
      const done = (error?: unknown) => { window.clearTimeout(timer); error ? reject(error) : resolve(); };
      void child.once('tauri://created', () => done()).catch(done);
      void child.once('tauri://error', event => done(new Error(`桌面窗口创建失败：${String(event.payload)}`))).catch(done);
    });
    await revealWindow(child);
  })().finally(() => opening.delete(options.label));
  opening.set(options.label, request);
  return request;
}

export async function focusDetachedWindow(label: string): Promise<boolean> {
  if (isDesktopWindow()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const win = await WebviewWindow.getByLabel(label);
    if (!win) return false;
    await revealWindow(win);
    return true;
  }
  const win = browserWindows.get(label);
  if (!win || win.closed) return false;
  win.focus();
  return true;
}

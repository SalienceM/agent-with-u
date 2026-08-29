import { isTauri } from '../api';

const clip = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
    : normalized;
};

/**
 * Show a native desktop notification only when the main window is not being
 * watched. The document checks are a safe fallback if the native window query
 * becomes unavailable during shutdown or a WebView lifecycle transition.
 */
export async function notifyTaskCompletion(sessionTitle: string): Promise<void> {
  if (!isTauri()) return;

  let shouldNotify = document.visibilityState !== 'visible' || !document.hasFocus();
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const mainWindow = getCurrentWindow();
    const [minimized, visible, focused] = await Promise.all([
      mainWindow.isMinimized(),
      mainWindow.isVisible(),
      mainWindow.isFocused(),
    ]);
    shouldNotify = minimized || !visible || !focused;
  } catch (error) {
    console.warn('[notification] unable to read window state; using document state', error);
  }

  if (!shouldNotify) return;

  const label = clip(sessionTitle || '未命名 Session', 56);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 游戏、视频或演示处于全屏时进入免打扰：完成状态仍正常记录，等用户
    // 回到 AgentWithU 后查看，不在其它应用上方弹 Windows 通知。
    if (await invoke<boolean>('is_foreground_fullscreen_app')) return;
    await invoke('show_task_completion_notification', {
      title: `任务已完成 · ${label}`,
      body: 'Agent 已完成本轮任务，返回 AgentWithU 查看结果。',
    });
  } catch (error) {
    // Notification failures must never affect completion-state cleanup.
    console.warn('[notification] unable to show task completion notification', error);
  }
}

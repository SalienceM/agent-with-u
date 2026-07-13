export type HackerCaptureMode = 'full' | 'region';

export interface HackerModeConfig {
  enabled: boolean;
  mouseButton: 'left' | 'right';
  doubleClickMs: number;
  captureMode: HackerCaptureMode;
  x: number;
  y: number;
  width: number;
  height: number;
  prompt: string;
}

export const HACKER_MODE_KEY = 'awu.hackerMode';
export const HACKER_MODE_CHANGED_EVENT = 'awu:hacker-mode-changed';
export const HACKER_CAPTURE_EVENT = 'awu:hacker-capture';

export const DEFAULT_HACKER_MODE: HackerModeConfig = {
  enabled: false,
  mouseButton: 'left',
  doubleClickMs: 450,
  captureMode: 'full',
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
  prompt: '请结合截图内容，简洁、直接地回答当前问题。',
};

export function readHackerMode(): HackerModeConfig {
  try {
    const raw = localStorage.getItem(HACKER_MODE_KEY);
    if (!raw) return { ...DEFAULT_HACKER_MODE };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_HACKER_MODE, ...parsed };
    // 旧版允许中键截图；中键值迁移为左键，避免保留已废弃的选择。
    if (merged.mouseButton === 'middle') merged.mouseButton = 'left';
    return merged;
  } catch {
    return { ...DEFAULT_HACKER_MODE };
  }
}

export function writeHackerMode(patch: Partial<HackerModeConfig>): HackerModeConfig {
  const next = { ...readHackerMode(), ...patch };
  try { localStorage.setItem(HACKER_MODE_KEY, JSON.stringify(next)); } catch { /* */ }
  window.dispatchEvent(new CustomEvent(HACKER_MODE_CHANGED_EVENT, { detail: next }));
  return next;
}

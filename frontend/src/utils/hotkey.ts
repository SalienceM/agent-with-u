// 截图全局快捷键配置:在 localStorage 里持久化,Tauri 端通过
// `tauri-plugin-global-shortcut` 注册。Settings UI 写入后通过 window 自定义
// 事件通知 App.tsx 重新注册——这样不重启就能改键位。

export const SCREENSHOT_HOTKEY_KEY = 'awu.screenshotHotkey';
export const SCREENSHOT_HOTKEY_DEFAULT = 'CommandOrControl+Shift+A';
export const HOTKEY_CHANGED_EVENT = 'awu:hotkey-config-changed';

export function readScreenshotHotkey(): string {
  try {
    const v = localStorage.getItem(SCREENSHOT_HOTKEY_KEY);
    if (v === null) return SCREENSHOT_HOTKEY_DEFAULT;
    return v; // 允许空串 = 禁用
  } catch {
    return SCREENSHOT_HOTKEY_DEFAULT;
  }
}

export function writeScreenshotHotkey(v: string): void {
  try { localStorage.setItem(SCREENSHOT_HOTKEY_KEY, v); } catch { /* */ }
  window.dispatchEvent(new CustomEvent(HOTKEY_CHANGED_EVENT, {
    detail: { key: 'screenshot', value: v },
  }));
}

// 把人类按键 → Tauri accelerator 字符串。返回 null 表示这次按键还不构成一个
// 合法快捷键(只按了修饰键、或单独按了字母没修饰)。
export function buildAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  const key = normalizeKey(e.key);
  if (!key) return null;
  // 单独 F1-F24 可作快捷键;其它单键(字母/数字/方向键)必须带修饰键,
  // 否则太容易和正常打字冲突。
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (mods.length === 0 && !isFunctionKey) return null;
  return [...mods, key].join('+');
}

// 仅判断这次 keydown 是不是「只按了修饰键」——此时不要 commit,继续等。
export function isModifierOnly(e: KeyboardEvent): boolean {
  return ['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Command', 'Hyper', 'Super'].includes(e.key);
}

function normalizeKey(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  switch (key) {
    case 'ArrowUp': return 'Up';
    case 'ArrowDown': return 'Down';
    case 'ArrowLeft': return 'Left';
    case 'ArrowRight': return 'Right';
    case ' ': return 'Space';
    case 'Tab': return 'Tab';
    case 'Enter': return 'Enter';
    case 'Backspace': return 'Backspace';
    case 'Delete': return 'Delete';
    case 'Home': return 'Home';
    case 'End': return 'End';
    case 'PageUp': return 'PageUp';
    case 'PageDown': return 'PageDown';
    case '`': return '`';
    case '-': return '-';
    case '=': return '=';
    case '[': return '[';
    case ']': return ']';
    case '\\': return '\\';
    case ';': return ';';
    case "'": return "'";
    case ',': return ',';
    case '.': return '.';
    case '/': return '/';
    default: return null;
  }
}

// 人类友好显示。CommandOrControl 在不同平台显示成本地化名字。
export function displayAccelerator(accel: string): string {
  if (!accel) return '(disabled)';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
  return accel
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl' || p === 'CmdOrCtrl') return isMac ? '⌘' : 'Ctrl';
      if (p === 'Command' || p === 'Cmd' || p === 'Meta' || p === 'Super') return isMac ? '⌘' : 'Meta';
      if (p === 'Control' || p === 'Ctrl') return 'Ctrl';
      if (p === 'Alt' || p === 'Option') return isMac ? '⌥' : 'Alt';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      return p;
    })
    .join(isMac ? '' : '+');
}

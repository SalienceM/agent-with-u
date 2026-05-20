import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';

export type ThemeType = 'dark' | 'midnight' | 'light' | 'classic' | 'cyber';

export interface AppConfig {
  fontSize: number;
  renderMarkdown: boolean;
  exportFormat: 'markdown' | 'json';
  theme: ThemeType;
  bgImage: string;
  bgOpacity: number;
  uiOpacity: number;
}

const DEFAULT_CONFIG: AppConfig = {
  fontSize: 14,
  renderMarkdown: true,
  exportFormat: 'markdown',
  theme: 'dark',
  bgImage: '',
  bgOpacity: 0.3,
  uiOpacity: 1.0,
};

// Theme color schemes
// Based on scientific color theory: WCAG AA/AAA contrast ratios, HSL harmony
// References: Dracula, Nord, GitHub Dark Dimmed, Tailwind CSS palette
export const themes: Record<ThemeType, {
  name: string;
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentBg: string;
  messageBg: string;
  userMessageBg: string;
  userBubbleBg: string;       // ★ 用户气泡背景
  userBubbleBorder: string;   // ★ 用户气泡边框
  codeBg: string;
  inputBg: string;
  sidebarBg: string;
  success: string;
  successBg: string;
  successBorder: string;
  error: string;
}> = {
  // ════════════════════════════════════
  //  暗色主题
  // ════════════════════════════════════
  dark: {
    // Tokyo Night 风格暗色
    name: 'Dark',
    bg: '#1a1b26',
    bgSecondary: '#1f202e',
    bgTertiary: '#242536',
    border: 'rgba(255,255,255,0.08)',
    text: '#e2e3ea',
    textMuted: 'rgba(226,227,234,0.5)',
    accent: '#7aa2f7',
    accentHover: '#5d87e5',
    accentBg: '#7aa2f726',
    messageBg: '#1f202e',
    userMessageBg: '#242536',
    userBubbleBg: '#2d3560',
    userBubbleBorder: '#7aa2f788',
    codeBg: '#16161e',
    inputBg: '#16161e',
    sidebarBg: '#1f202e',
    success: '#3fb950',
    successBg: '#3fb9501a',
    successBorder: '#3fb95033',
    error: '#f85149',
  },
  midnight: {
    // GitHub Dark 深黑，适合 OLED
    name: 'Midnight',
    bg: '#0d1117',
    bgSecondary: '#161b22',
    bgTertiary: '#21262d',
    border: 'rgba(255,255,255,0.1)',
    text: '#c9d1d9',
    textMuted: 'rgba(201,209,217,0.5)',
    accent: '#58a6ff',
    accentHover: '#4695e0',
    accentBg: '#58a6ff26',
    messageBg: '#161b22',
    userMessageBg: '#21262d',
    userBubbleBg: '#1a3050',
    userBubbleBorder: '#58a6ff88',
    codeBg: '#0d1117',
    inputBg: '#010409',
    sidebarBg: '#0d1117',
    success: '#3fb950',
    successBg: '#3fb9501a',
    successBorder: '#3fb95033',
    error: '#f85149',
  },
  // ════════════════════════════════════
  //  亮色主题
  // ════════════════════════════════════
  light: {
    // AgentWithU 品牌暖红主题
    // 三层对比：页面(暖米色) / AI 气泡(浅黄白) / 用户气泡(玫瑰红) — 层次清晰
    name: 'AgentWithU',
    bg: '#f5ede0',              // 暖米色页面底色（比原 #f7f1e8 稍深，衬托 AI 气泡）
    bgSecondary: '#ecdfd0',
    bgTertiary: '#e1d0bc',
    border: 'rgba(155,35,53,0.22)',
    text: '#1f1a17',
    textMuted: '#6b5a4e',
    accent: '#8B1C1C',
    accentHover: '#6e1515',
    accentBg: '#8B1C1C1a',
    messageBg: '#fdfaf5',       // AI 气泡近白暖色，在暖米色上清晰突出
    userMessageBg: '#fad4cc',
    userBubbleBg: '#fad4cc',    // 用户气泡玫瑰红，与 AI 气泡、页面均明显不同
    userBubbleBorder: '#9B233566',
    codeBg: '#ecdfd0',
    inputBg: '#fdfaf5',
    sidebarBg: '#ecdfd0',
    success: '#2a7a3b',
    successBg: '#2a7a3b1a',
    successBorder: '#2a7a3b33',
    error: '#cf222e',
  },
  cyber: {
    // 赛博朋克 — 霓虹青 + 深空蓝黑
    name: 'Cyber',
    bg: '#070b14',
    bgSecondary: '#0d1220',
    bgTertiary: '#111827',
    border: 'rgba(0,255,247,0.12)',
    text: '#cff4fc',
    textMuted: 'rgba(207,244,252,0.42)',
    accent: '#00fff7',
    accentHover: '#00d4cc',
    accentBg: 'rgba(0,255,247,0.08)',
    messageBg: '#0d1220',
    userMessageBg: '#111827',
    userBubbleBg: 'rgba(0,255,247,0.05)',
    userBubbleBorder: 'rgba(0,255,247,0.3)',
    codeBg: '#050a10',
    inputBg: '#050a10',
    sidebarBg: '#070b14',
    success: '#00ff88',
    successBg: 'rgba(0,255,136,0.1)',
    successBorder: 'rgba(0,255,136,0.22)',
    error: '#ff3366',
  },
  classic: {
    // 经典亮色 — 浅蓝灰底色，白色 AI 气泡清晰浮起，蓝色用户气泡明确区分
    // 三层对比：页面(灰蓝) / AI 气泡(白) / 用户气泡(蓝) — 互不混淆
    name: 'Classic',
    bg: '#f0f2f5',              // 浅灰蓝，不刺眼且衬托白色气泡
    bgSecondary: '#e6e9ee',     // 侧栏、卡片背景
    bgTertiary: '#d8dde5',      // hover、菜单
    border: 'rgba(0,0,0,0.13)',
    text: '#1c2128',
    textMuted: '#57606a',
    accent: '#0969da',
    accentHover: '#0550ae',
    accentBg: '#0969da18',
    messageBg: '#ffffff',       // AI 气泡纯白，在灰蓝页面上清晰突出
    userMessageBg: '#dbeafe',
    userBubbleBg: '#dbeafe',    // 用户气泡中蓝，与 AI 白、页面灰蓝均不同
    userBubbleBorder: '#0969da55',
    codeBg: '#eef0f3',
    inputBg: '#ffffff',
    sidebarBg: '#e6e9ee',
    success: '#1a7f37',
    successBg: '#1a7f371a',
    successBorder: '#1a7f3733',
    error: '#cf222e',
  },
};

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load config from backend on mount
  useEffect(() => {
    api.getAppConfig().then((savedConfig) => {
      if (savedConfig && Object.keys(savedConfig).length > 0) {
        // ★ 迁移已删除的主题名
        if (savedConfig.theme === 'ocean') savedConfig.theme = 'midnight';
        setConfig((prev) => ({ ...prev, ...savedConfig }));
      }
      setLoaded(true);
    }).catch(() => {
      // If loading fails, use defaults
      setLoaded(true);
    });
    // ★ 卸载时清理 debounce timer，防止对已卸载组件 setState
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Debounced save: sliders may fire many events; wait 400ms after last change.
  // Non-bgImage saves strip bgImage from the payload (backend retains it on disk).
  const scheduleSave = useCallback((cfg: AppConfig) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const { bgImage: _omit, ...rest } = cfg;
      api.setAppConfig(rest).catch(console.error);
    }, 400);
  }, []);

  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfig((prev) => {
      const newConfig = { ...prev, ...patch };
      if ('bgImage' in patch) {
        // bgImage changes: send full config immediately so image is saved
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        api.setAppConfig(newConfig).catch(console.error);
      } else {
        // Other changes: debounced, and omit bgImage from payload
        scheduleSave(newConfig);
      }
      return newConfig;
    });
  }, [scheduleSave]);

  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_CONFIG);
    api.setAppConfig(DEFAULT_CONFIG).catch(console.error);
  }, []);

  const reloadConfig = useCallback(() => {
    api.getAppConfig().then((savedConfig) => {
      if (savedConfig && Object.keys(savedConfig).length > 0) {
        if (savedConfig.theme === 'ocean') savedConfig.theme = 'midnight';
        setConfig((prev) => ({ ...prev, ...savedConfig }));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  return { config, updateConfig, resetConfig, reloadConfig, loaded };
}

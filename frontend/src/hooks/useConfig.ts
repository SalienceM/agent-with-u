import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';

export type ThemeType = 'dark' | 'midnight' | 'light' | 'classic' | 'cyber';
export type RealtimeVoiceTtsEngine = 'system' | 'edge' | 'dashscope';

export interface AppConfig {
  fontSize: number;
  renderMarkdown: boolean;
  exportFormat: 'markdown' | 'json';
  theme: ThemeType;
  bgImage: string;
  bgOpacity: number;
  uiOpacity: number;
  ttsVoice: string;
  ttsRate: number;
  /** @deprecated Kept only so older persisted config can still be read. */
  realtimeVoiceSilenceMs: number;
  realtimeVoiceTurnEndSilenceMs: number;
  realtimeVoiceContinuousWindowMs: number;
  realtimeVoiceWakeWord: string;
  realtimeVoiceTtsEngine: RealtimeVoiceTtsEngine;
  realtimeVoiceSystemVoice: string;
  realtimeVoiceDashScopeModel: string;
  realtimeVoiceDashScopeVoice: string;
  realtimeVoiceVadThreshold: number;
  realtimeVoiceBargeIn: boolean;
  workspaceKitsEnabled: boolean;
  sidebarSessionLimit: number;
  desktopTaskNotifications: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  fontSize: 14,
  renderMarkdown: true,
  exportFormat: 'markdown',
  theme: 'dark',
  bgImage: '',
  bgOpacity: 0.3,
  uiOpacity: 1.0,
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 0,
  realtimeVoiceSilenceMs: 700,
  realtimeVoiceTurnEndSilenceMs: 1500,
  realtimeVoiceContinuousWindowMs: 30000,
  realtimeVoiceWakeWord: 'Yuki',
  realtimeVoiceTtsEngine: 'system',
  realtimeVoiceSystemVoice: '',
  realtimeVoiceDashScopeModel: 'cosyvoice-v1',
  realtimeVoiceDashScopeVoice: 'longxiaochun',
  realtimeVoiceVadThreshold: 0.018,
  realtimeVoiceBargeIn: true,
  workspaceKitsEnabled: true,
  sidebarSessionLimit: 25,
  desktopTaskNotifications: true,
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
    // 冷静的深石墨底 + 阿里蓝强调色：低饱和、轻层级、长时间使用不刺眼。
    name: 'Graphite',
    bg: '#0b1017',
    bgSecondary: '#101720',
    bgTertiary: '#18212c',
    border: 'rgba(148,163,184,0.14)',
    text: '#edf3fb',
    textMuted: '#8b98a8',
    accent: '#4f8cff',
    accentHover: '#6ba0ff',
    accentBg: 'rgba(79,140,255,0.13)',
    messageBg: '#111923',
    userMessageBg: '#17283f',
    userBubbleBg: '#17345c',
    userBubbleBorder: 'rgba(79,140,255,0.42)',
    codeBg: '#080d13',
    inputBg: '#0d141c',
    sidebarBg: '#0d141c',
    success: '#32b67a',
    successBg: 'rgba(50,182,122,0.11)',
    successBorder: 'rgba(50,182,122,0.24)',
    error: '#ff6469',
  },
  midnight: {
    // OLED 深色版，保持与 Graphite 相同的冷色语言。
    name: 'Midnight',
    bg: '#05080d',
    bgSecondary: '#090e15',
    bgTertiary: '#111923',
    border: 'rgba(148,163,184,0.15)',
    text: '#e4edf7',
    textMuted: '#7f8c9d',
    accent: '#4096ff',
    accentHover: '#69adff',
    accentBg: 'rgba(64,150,255,0.13)',
    messageBg: '#0b1119',
    userMessageBg: '#10243d',
    userBubbleBg: '#123058',
    userBubbleBorder: 'rgba(64,150,255,0.42)',
    codeBg: '#03060a',
    inputBg: '#070b11',
    sidebarBg: '#070b11',
    success: '#32b67a',
    successBg: 'rgba(50,182,122,0.11)',
    successBorder: 'rgba(50,182,122,0.24)',
    error: '#ff6469',
  },
  // ════════════════════════════════════
  //  亮色主题
  // ════════════════════════════════════
  light: {
    // Apple 式冷白留白 + 阿里系高效蓝色交互。
    name: 'Cloud',
    bg: '#f3f6fa',
    bgSecondary: '#eaf0f6',
    bgTertiary: '#dfe7f0',
    border: 'rgba(40,58,78,0.14)',
    text: '#15202b',
    textMuted: '#657486',
    accent: '#1677ff',
    accentHover: '#0958d9',
    accentBg: 'rgba(22,119,255,0.09)',
    messageBg: '#ffffff',
    userMessageBg: '#e8f2ff',
    userBubbleBg: '#e8f2ff',
    userBubbleBorder: 'rgba(22,119,255,0.25)',
    codeBg: '#edf2f7',
    inputBg: '#ffffff',
    sidebarBg: '#edf2f7',
    success: '#16865a',
    successBg: 'rgba(22,134,90,0.09)',
    successBorder: 'rgba(22,134,90,0.20)',
    error: '#d9363e',
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
  const loadVersionRef = useRef(0);

  const loadFromBackend = useCallback(async () => {
    const version = ++loadVersionRef.current;
    try {
      const savedConfig = await api.getAppConfig();
      if (version !== loadVersionRef.current) return;
      if (savedConfig && Object.keys(savedConfig).length > 0) {
        // ★ 迁移已删除的主题名
        if (savedConfig.theme === 'ocean') savedConfig.theme = 'midnight';
        const sidebarLimit = Number(savedConfig.sidebarSessionLimit);
        savedConfig.sidebarSessionLimit = Number.isFinite(sidebarLimit) && sidebarLimit >= 5
          ? Math.min(500, Math.trunc(sidebarLimit))
          : 25;
        // Older config files do not contain this field. Keep completion
        // notifications enabled by default while preserving an explicit opt-out.
        savedConfig.desktopTaskNotifications = savedConfig.desktopTaskNotifications !== false;
        const voiceSilenceMs = Number(savedConfig.realtimeVoiceSilenceMs);
        savedConfig.realtimeVoiceSilenceMs = Number.isFinite(voiceSilenceMs)
          ? Math.max(350, Math.min(2000, Math.trunc(voiceSilenceMs)))
          : 700;
        // 使用新字段，避免旧版本保存的 700ms 继续造成过早断句。
        const turnEndSilenceMs = Number(savedConfig.realtimeVoiceTurnEndSilenceMs);
        savedConfig.realtimeVoiceTurnEndSilenceMs = Number.isFinite(turnEndSilenceMs)
          ? Math.max(900, Math.min(3000, Math.trunc(turnEndSilenceMs)))
          : 1500;
        const continuousWindowMs = Number(savedConfig.realtimeVoiceContinuousWindowMs);
        savedConfig.realtimeVoiceContinuousWindowMs = Number.isFinite(continuousWindowMs)
          ? Math.max(10_000, Math.min(120_000, Math.trunc(continuousWindowMs)))
          : 30_000;
        const savedWakeWord = typeof savedConfig.realtimeVoiceWakeWord === 'string'
          ? savedConfig.realtimeVoiceWakeWord.slice(0, 24)
          : 'Yuki';
        // “小U”是旧版本的内置默认值，不是用户显式选择的版本标记；升级时
        // 将这一默认值迁移到新的 Yuki，其他自定义唤醒词保持不变。
        savedConfig.realtimeVoiceWakeWord = /^小\s*[uUＵ]$/.test(savedWakeWord.trim())
          ? 'Yuki'
          : savedWakeWord;
        savedConfig.realtimeVoiceTtsEngine = (
          savedConfig.realtimeVoiceTtsEngine === 'edge'
          || savedConfig.realtimeVoiceTtsEngine === 'dashscope'
        ) ? savedConfig.realtimeVoiceTtsEngine : 'system';
        savedConfig.realtimeVoiceSystemVoice = typeof savedConfig.realtimeVoiceSystemVoice === 'string'
          ? savedConfig.realtimeVoiceSystemVoice.slice(0, 180)
          : '';
        const savedDashScopeModel = typeof savedConfig.realtimeVoiceDashScopeModel === 'string'
          ? savedConfig.realtimeVoiceDashScopeModel.slice(0, 128)
          : 'cosyvoice-v1';
        const savedDashScopeVoice = typeof savedConfig.realtimeVoiceDashScopeVoice === 'string'
          ? savedConfig.realtimeVoiceDashScopeVoice.slice(0, 128)
          : 'longxiaochun';
        // 早期实验版错误地把 v3-flash + longxiaochun 作为内置默认值；该组合
        // 在旧域名/默认业务空间会返回 CosyVoice engine 418。只迁移这一个
        // 曾经发布过的默认组合，用户填写的其他模型/音色保持原样。
        savedConfig.realtimeVoiceDashScopeModel = (
          savedDashScopeModel === 'cosyvoice-v3-flash'
          && savedDashScopeVoice === 'longxiaochun'
        ) ? 'cosyvoice-v1' : savedDashScopeModel;
        savedConfig.realtimeVoiceDashScopeVoice = savedDashScopeVoice;
        const voiceVadThreshold = Number(savedConfig.realtimeVoiceVadThreshold);
        savedConfig.realtimeVoiceVadThreshold = Number.isFinite(voiceVadThreshold)
          ? Math.max(0.004, Math.min(0.12, voiceVadThreshold))
          : 0.018;
        setConfig((prev) => ({ ...prev, ...savedConfig }));
      }
      setLoaded(true);
    } catch {
      if (version !== loadVersionRef.current) return;
      setLoaded(true);
    }
  }, []);

  // 配置必须在真实后端连接成功后读取。旧逻辑在连接尚未就绪时先读一次，
  // 失败后首连又跳过重载，导致背景图要手动刷新才出现。
  useEffect(() => {
    const unsubscribe = api.onConnectionStatus((connected) => {
      if (connected) void loadFromBackend();
    });
    return () => {
      loadVersionRef.current += 1;
      unsubscribe();
    };
  }, [loadFromBackend]);

  // ★ 卸载时清理 debounce timer
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
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
    void loadFromBackend();
  }, [loadFromBackend]);

  return { config, updateConfig, resetConfig, reloadConfig, loaded };
}

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { api, getCurrentUserProfile, type CurrentUserProfile } from '../api';
import {
  DEFAULT_CLIENT_APPEARANCE,
  clientAppearanceStorageKey,
  hasClientAppearancePatch,
  hasExecutorConfigPatch,
  loadClientAppearance,
  normalizeClientAppearance,
  readClientAppearancePreview,
  resolveClientAppearance,
  saveClientAppearance,
  stripClientAppearance,
  type ClientAppearance,
  type ClientAppearanceIdentity,
  type ThemeType,
} from '../utils/clientAppearance';

export type { ThemeType } from '../utils/clientAppearance';
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
  ...DEFAULT_CLIENT_APPEARANCE,
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

function normalizeExecutorConfig(value: unknown): Partial<AppConfig> {
  if (!value || typeof value !== 'object') return {};
  const savedConfig: any = stripClientAppearance({ ...(value as Record<string, unknown>) });
  const sidebarLimit = Number(savedConfig.sidebarSessionLimit);
  savedConfig.sidebarSessionLimit = Number.isFinite(sidebarLimit) && sidebarLimit >= 5
    ? Math.min(500, Math.trunc(sidebarLimit))
    : 25;
  // Older config files do not contain this field. Preserve only an explicit opt-out.
  savedConfig.desktopTaskNotifications = savedConfig.desktopTaskNotifications !== false;
  const voiceSilenceMs = Number(savedConfig.realtimeVoiceSilenceMs);
  savedConfig.realtimeVoiceSilenceMs = Number.isFinite(voiceSilenceMs)
    ? Math.max(350, Math.min(2000, Math.trunc(voiceSilenceMs)))
    : 700;
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
  // “小U” was an old built-in default, not an explicit user choice.
  savedConfig.realtimeVoiceWakeWord = /^小\s*[uUｕＵ]$/.test(savedWakeWord.trim())
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
  savedConfig.realtimeVoiceDashScopeModel = (
    savedDashScopeModel === 'cosyvoice-v3-flash'
    && savedDashScopeVoice === 'longxiaochun'
  ) ? 'cosyvoice-v1' : savedDashScopeModel;
  savedConfig.realtimeVoiceDashScopeVoice = savedDashScopeVoice;
  const voiceVadThreshold = Number(savedConfig.realtimeVoiceVadThreshold);
  savedConfig.realtimeVoiceVadThreshold = Number.isFinite(voiceVadThreshold)
    ? Math.max(0.004, Math.min(0.12, voiceVadThreshold))
    : 0.018;
  return savedConfig as Partial<AppConfig>;
}

function toAppearanceIdentity(profile: CurrentUserProfile): ClientAppearanceIdentity {
  return {
    mode: profile.mode === 'relay' ? 'relay' : 'local',
    userId: String(profile.userId || (profile.mode === 'relay' ? 'legacy' : 'local')),
  };
}

interface PendingAppearanceSave {
  identity: ClientAppearanceIdentity;
  identityKey: string;
  appearance: ClientAppearance;
  backgroundChanged: boolean;
}

export function useConfig(currentUser: CurrentUserProfile = getCurrentUserProfile()) {
  const identity = useMemo(
    () => toAppearanceIdentity(currentUser),
    [currentUser.mode, currentUser.userId],
  );
  const identityKey = useMemo(() => clientAppearanceStorageKey(identity), [identity]);
  const [config, setConfig] = useState<AppConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...(readClientAppearancePreview(identity) || DEFAULT_CLIENT_APPEARANCE),
  }));
  const configRef = useRef(config);
  configRef.current = config;
  const [loaded, setLoaded] = useState(false);
  const executorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appearanceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAppearanceRef = useRef<PendingAppearanceSave | null>(null);
  const loadVersionRef = useRef(0);
  const appearanceRevisionRef = useRef(0);

  const mergeConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfig((previous) => {
      const next = { ...previous, ...patch };
      configRef.current = next;
      return next;
    });
  }, []);

  const flushAppearanceSave = useCallback(() => {
    if (appearanceSaveTimerRef.current) {
      clearTimeout(appearanceSaveTimerRef.current);
      appearanceSaveTimerRef.current = null;
    }
    const pending = pendingAppearanceRef.current;
    pendingAppearanceRef.current = null;
    if (!pending) return;
    void saveClientAppearance(pending.identity, pending.appearance, {
      backgroundChanged: pending.backgroundChanged,
    }).catch((error) => console.warn('[appearance] failed to save client preference', error));
  }, []);

  const scheduleAppearanceSave = useCallback((
    targetIdentity: ClientAppearanceIdentity,
    nextConfig: AppConfig,
    backgroundChanged: boolean,
    immediate: boolean,
  ) => {
    const targetKey = clientAppearanceStorageKey(targetIdentity);
    const previous = pendingAppearanceRef.current;
    if (previous && previous.identityKey !== targetKey) flushAppearanceSave();
    const sameUserPending = pendingAppearanceRef.current;
    pendingAppearanceRef.current = {
      identity: targetIdentity,
      identityKey: targetKey,
      appearance: normalizeClientAppearance(nextConfig),
      backgroundChanged: backgroundChanged || !!sameUserPending?.backgroundChanged,
    };
    if (appearanceSaveTimerRef.current) clearTimeout(appearanceSaveTimerRef.current);
    if (immediate) {
      flushAppearanceSave();
    } else {
      appearanceSaveTimerRef.current = setTimeout(flushAppearanceSave, 400);
    }
  }, [flushAppearanceSave]);

  const scheduleExecutorSave = useCallback((nextConfig: AppConfig) => {
    if (executorSaveTimerRef.current) clearTimeout(executorSaveTimerRef.current);
    // This payload is the hard boundary: no user's skin reaches the shared executor.
    const payload = stripClientAppearance({ ...nextConfig });
    executorSaveTimerRef.current = setTimeout(() => {
      executorSaveTimerRef.current = null;
      void api.setAppConfig(payload).catch(console.error);
    }, 400);
  }, []);

  const loadFromBackend = useCallback(async () => {
    const version = ++loadVersionRef.current;
    const appearanceRevision = appearanceRevisionRef.current;
    try {
      const [savedConfig, storedAppearance] = await Promise.all([
        api.getAppConfig(),
        loadClientAppearance(identity),
      ]);
      if (version !== loadVersionRef.current) return;

      const resolvedAppearance = resolveClientAppearance(storedAppearance, savedConfig);
      const executorConfig = normalizeExecutorConfig(savedConfig);
      const appearanceUnchanged = appearanceRevision === appearanceRevisionRef.current;
      mergeConfig({
        ...executorConfig,
        ...(appearanceUnchanged ? resolvedAppearance.appearance : {}),
      });
      setLoaded(true);

      // One-time upgrade path. The old node-level value is copied to this user's
      // controller namespace, but is never sent back to the executor.
      if (resolvedAppearance.migrated && appearanceUnchanged) {
        void saveClientAppearance(identity, resolvedAppearance.appearance, {
          backgroundChanged: true,
        }).catch((error) => console.warn('[appearance] legacy migration failed', error));
      }
    } catch {
      if (version !== loadVersionRef.current) return;
      setLoaded(true);
    }
  }, [identity, mergeConfig]);

  // Switching accounts must remove user A's appearance before user B is painted.
  // The small metadata is synchronous; a potentially large background hydrates from IDB.
  useLayoutEffect(() => {
    const version = ++loadVersionRef.current;
    const appearanceRevision = ++appearanceRevisionRef.current;
    if (executorSaveTimerRef.current) {
      clearTimeout(executorSaveTimerRef.current);
      executorSaveTimerRef.current = null;
    }
    flushAppearanceSave();
    const preview = readClientAppearancePreview(identity);
    mergeConfig({
      ...DEFAULT_CLIENT_APPEARANCE,
      ...(preview || {}),
      bgImage: preview?.bgImage || '',
    });
    setLoaded(false);
    void loadClientAppearance(identity).then((storedAppearance) => {
      if (version !== loadVersionRef.current
          || appearanceRevision !== appearanceRevisionRef.current) return;
      if (storedAppearance) mergeConfig(storedAppearance);
      setLoaded(true);
    }).catch(() => {
      if (version === loadVersionRef.current) setLoaded(true);
    });
  }, [identity, identityKey, flushAppearanceSave, mergeConfig]);

  // Executor preferences load only after a real connection exists. Appearance is
  // already available locally and is merely migrated from the executor once if needed.
  useEffect(() => {
    const unsubscribe = api.onConnectionStatus((connected) => {
      if (connected) void loadFromBackend();
    });
    return unsubscribe;
  }, [loadFromBackend]);

  useEffect(() => () => {
    loadVersionRef.current += 1;
    if (executorSaveTimerRef.current) clearTimeout(executorSaveTimerRef.current);
    flushAppearanceSave();
  }, [flushAppearanceSave]);

  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    const nextConfig = { ...configRef.current, ...patch };
    configRef.current = nextConfig;
    setConfig(nextConfig);
    const patchRecord = patch as Record<string, unknown>;
    if (hasClientAppearancePatch(patchRecord)) {
      appearanceRevisionRef.current += 1;
      const backgroundChanged = Object.prototype.hasOwnProperty.call(patch, 'bgImage');
      scheduleAppearanceSave(identity, nextConfig, backgroundChanged, backgroundChanged);
    }
    if (hasExecutorConfigPatch(patchRecord)) scheduleExecutorSave(nextConfig);
  }, [identity, scheduleAppearanceSave, scheduleExecutorSave]);

  const resetConfig = useCallback(() => {
    if (executorSaveTimerRef.current) {
      clearTimeout(executorSaveTimerRef.current);
      executorSaveTimerRef.current = null;
    }
    appearanceRevisionRef.current += 1;
    configRef.current = DEFAULT_CONFIG;
    setConfig(DEFAULT_CONFIG);
    // Persist defaults as a real per-user record. Clearing it would cause the next
    // reload to re-import the shared executor's legacy skin.
    scheduleAppearanceSave(identity, DEFAULT_CONFIG, true, true);
    void api.setAppConfig(stripClientAppearance({ ...DEFAULT_CONFIG })).catch(console.error);
  }, [identity, scheduleAppearanceSave]);

  const reloadConfig = useCallback(() => {
    void loadFromBackend();
  }, [loadFromBackend]);

  return { config, updateConfig, resetConfig, reloadConfig, loaded };
}

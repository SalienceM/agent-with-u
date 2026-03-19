import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';

export type ThemeType = 'dark' | 'light' | 'midnight' | 'ocean';

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
  codeBg: string;
  inputBg: string;
  sidebarBg: string;
  success: string;
  successBg: string;
  successBorder: string;
  error: string;
}> = {
  dark: {
    // Improved Dark theme - balanced blue-purple tones
    // Based on GitHub Dark + custom purple accent
    name: 'Dark',
    bg: '#1a1b26',        // Warm dark blue-gray, easier on eyes than pure blue-black
    bgSecondary: '#1f202e',
    bgTertiary: '#242536',
    border: 'rgba(255,255,255,0.08)',
    text: '#e2e3ea',      // Slightly warm white, reduces eye strain
    textMuted: 'rgba(226,227,234,0.5)',  // Consistent hue with text
    accent: '#7aa2f7',    // Soft blue accent (from Tokyo Night palette)
    accentHover: '#5d87e5',
    accentBg: '#7aa2f726',  // Accent with 15% opacity for selection backgrounds
    messageBg: '#1f202e',
    userMessageBg: '#242536',
    codeBg: '#16161e',    // Slightly lighter than bg for subtle contrast
    inputBg: '#16161e',
    sidebarBg: '#1f202e',
    success: '#3fb950',
    successBg: '#3fb9501a',
    successBorder: '#3fb95033',
    error: '#f85149',
  },
  light: {
    // Warm Crimson theme - inspired by AgentWithU app icon
    // Cream background + dark red accents
    name: 'Light',
    bg: '#f7f1e8',           // Warm cream background (icon background tone)
    bgSecondary: '#ede5d6',  // Slightly deeper cream for secondary surfaces
    bgTertiary: '#e3d9c8',   // Tertiary warm cream
    border: '#9B2335',       // Dark crimson border/lines
    text: '#1f1a17',         // Warm near-black text
    textMuted: '#6b5a4e',    // Warm muted brown-gray
    accent: '#8B1C1C',       // Deep crimson accent (icon primary color)
    accentHover: '#6e1515',  // Darker crimson on hover
    accentBg: '#8B1C1C1a',   // Crimson tint background (10% opacity)
    messageBg: '#ede5d6',    // Message background
    userMessageBg: '#e3d9c8',// User message background
    codeBg: '#ede5d6',       // Code block background
    inputBg: '#f7f1e8',      // Input field background
    sidebarBg: '#ede5d6',    // Sidebar background
    success: '#2a7a3b',      // Muted green (harmonizes with warm palette)
    successBg: '#2a7a3b1a',  // Light green background
    successBorder: '#2a7a3b33', // Green border
    error: '#cf222e',        // Error red
  },
  midnight: {
    // True Midnight - deep neutral dark, GitHub-inspired
    // Perfect for OLED screens, minimal blue light
    name: 'Midnight',
    bg: '#0d1117',        // GitHub dark mode base
    bgSecondary: '#161b22',
    bgTertiary: '#21262d',
    border: 'rgba(255,255,255,0.1)',
    text: '#c9d1d9',      // GitHub dark mode text
    textMuted: 'rgba(201,209,217,0.5)',
    accent: '#58a6ff',    // GitHub blue accent
    accentHover: '#4695e0',
    accentBg: '#58a6ff26',
    messageBg: '#161b22',
    userMessageBg: '#21262d',
    codeBg: '#0d1117',
    inputBg: '#010409',
    sidebarBg: '#0d1117',
    success: '#3fb950',
    successBg: '#3fb9501a',
    successBorder: '#3fb95033',
    error: '#f85149',
  },
  ocean: {
    // Deep Ocean - rich teal-cyan palette, distinct from Midnight
    // Inspired by Nord + Material Design Ocean
    name: 'Ocean',
    bg: '#0f1724',        // Deep navy with subtle teal undertone
    bgSecondary: '#1a2738',
    bgTertiary: '#243347',
    border: 'rgba(72,163,216,0.15)',  // Cyan-tinted border
    text: '#c4d5e6',      // Cool white with blue undertone
    textMuted: 'rgba(196,213,230,0.5)',
    accent: '#48a3d8',    // Ocean cyan-blue (distinct from midnight blue)
    accentHover: '#3a8bc2',
    accentBg: '#48a3d826',
    messageBg: '#1a2738',
    userMessageBg: '#243347',
    codeBg: '#0a111a',
    inputBg: '#0a111a',
    sidebarBg: '#0f1724',
    success: '#4ade80',
    successBg: '#4ade801a',
    successBorder: '#4ade8033',
    error: '#f87171',
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
        setConfig((prev) => ({ ...prev, ...savedConfig }));
      }
      setLoaded(true);
    }).catch(() => {
      // If loading fails, use defaults
      setLoaded(true);
    });
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

  return { config, updateConfig, resetConfig, loaded };
}

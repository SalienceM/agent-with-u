import React from 'react';
import type { AppConfig, ThemeType } from '../hooks/useConfig';
import { themes } from '../hooks/useConfig';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onConfigChange: (patch: Partial<AppConfig>) => void;
  onExportChat: () => void;
  onResetConfig: () => void;
  onOpenBackendManager: () => void;
  onExportData: () => void;
  onImportData: () => void;
}

export const Settings: React.FC<SettingsProps> = ({
  isOpen,
  onClose,
  config,
  onConfigChange,
  onExportChat,
  onResetConfig,
  onOpenBackendManager,
  onExportData,
  onImportData,
}) => {
  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--theme-text)' }}>⚙ Settings</h2>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* 字号 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Font Size</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={12}
              max={20}
              value={config.fontSize}
              onChange={(e) => onConfigChange({ fontSize: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
              {config.fontSize}px
            </span>
          </div>
        </div>

        {/* 主题切换 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Theme</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(Object.keys(themes) as ThemeType[]).map((themeKey) => {
              const theme = themes[themeKey];
              return (
                <button
                  key={themeKey}
                  onClick={() => onConfigChange({ theme: themeKey })}
                  style={{
                    ...themeBtnStyle,
                    background: theme.bg,
                    borderColor: config.theme === themeKey ? theme.accent : theme.border,
                    color: theme.text,
                  }}
                  title={theme.name}
                >
                  {theme.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Markdown 渲染开关 */}
        <div style={sectionStyle}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.renderMarkdown}
              onChange={(e) => onConfigChange({ renderMarkdown: e.target.checked })}
              style={{ accentColor: 'var(--theme-accent)' }}
            />
            Render Markdown in assistant messages
          </label>
        </div>

        {/* 导出格式 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Export Format</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['markdown', 'json'] as const).map((fmt) => (
              <button
                key={fmt}
                onClick={() => onConfigChange({ exportFormat: fmt })}
                style={{
                  ...formatBtnStyle,
                  background: config.exportFormat === fmt ? 'var(--theme-accent-bg)' : 'rgba(255,255,255,0.05)',
                  borderColor: config.exportFormat === fmt ? 'var(--theme-accent)' : 'var(--theme-border)',
                }}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* 数据导入导出 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Data Management</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onExportData}
              style={{
                ...actionBtnStyle,
                background: 'rgba(34,197,94,0.15)',
                borderColor: 'rgba(34,197,94,0.3)',
              }}
              title="Export all sessions and backend configs"
            >
              📤 Export Data
            </button>
            <button
              onClick={onImportData}
              style={{
                ...actionBtnStyle,
                background: 'rgba(239,68,68,0.15)',
                borderColor: 'rgba(239,68,68,0.3)',
              }}
              title="Import sessions and backend configs (will overwrite existing)"
            >
              📥 Import Data
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
            ⚠️ Import will overwrite all existing sessions and backend configs
          </p>
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
          <button onClick={onOpenBackendManager} style={{ ...actionBtnStyle, background: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.3)' }}>
            🔌 Backends
          </button>
          <button onClick={onExportChat} style={actionBtnStyle}>
            📥 Export Chat
          </button>
          <button
            onClick={onResetConfig}
            style={{ ...actionBtnStyle, background: 'rgba(255,80,80,0.12)', borderColor: 'rgba(255,80,80,0.3)' }}
          >
            ↩ Reset Defaults
          </button>
        </div>
      </div>
    </div>
  );
};

/* ---- styles ---- */
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary, #1e1e36)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 12,
  padding: 24, width: '90%', maxWidth: 440, maxHeight: '80vh', overflowY: 'auto',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none',
  color: 'var(--theme-text-muted, rgba(255,255,255,0.4))',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px',
};
const sectionStyle: React.CSSProperties = { marginBottom: 16 };
const labelStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500,
  color: 'var(--theme-text, rgba(255,255,255,0.7))',
  marginBottom: 6, display: 'block',
};
const formatBtnStyle: React.CSSProperties = {
  padding: '6px 16px', borderRadius: 6, border: '1px solid', fontSize: 12,
  fontWeight: 600, cursor: 'pointer',
  color: 'var(--theme-text, #e0e0e0)',
  transition: 'all 0.15s',
};
const actionBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--theme-text, #e0e0e0)',
  fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
};
const themeBtnStyle: React.CSSProperties = {
  flex: 1, padding: '10px 12px', borderRadius: 8, border: '2px solid', fontSize: 12,
  fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
};
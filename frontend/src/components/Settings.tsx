import React, { useRef, useCallback, useEffect, useState } from 'react';
import type { AppConfig, ThemeType } from '../hooks/useConfig';
import { themes } from '../hooks/useConfig';
import { api, isTauri } from '../api';
import {
  SCREENSHOT_HOTKEY_DEFAULT,
  buildAccelerator,
  displayAccelerator,
  isModifierOnly,
  readScreenshotHotkey,
  writeScreenshotHotkey,
} from '../utils/hotkey';
import { readHackerMode, writeHackerMode, type HackerModeConfig } from '../utils/hackerMode';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [sttCfg, setSttCfg] = useState<any>(null);
  const [sttSaving, setSttSaving] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [localInstalled, setLocalInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.getAppVersion().then((v) => { if (!cancelled) setAppVersion(v); }).catch(() => {});
    api.getSttConfig().then((c) => {
      if (cancelled) return;
      setSttCfg(c);
      if (c?.mode === 'local') {
        api.sttCheckLocal().then((r) => { if (!cancelled) setLocalInstalled(r.installed); }).catch(() => {});
      }
    }).catch(() => {});
    // navigator.mediaDevices 仅在安全上下文（https / localhost）下存在；
    // 通过明文 http + 局域网 IP 访问时为 undefined，直接取用会抛 TypeError。
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach(t => t.stop());
          return navigator.mediaDevices.enumerateDevices();
        })
        .then((devices) => {
          if (!cancelled) setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [isOpen]);

  const handleSttChange = useCallback((field: string, value: string) => {
    setSttCfg((prev: any) => prev ? { ...prev, [field]: value } : prev);
    if (field === 'mode' && value === 'local') {
      api.sttCheckLocal().then((r) => setLocalInstalled(r.installed)).catch(() => {});
    }
  }, []);

  const handleSttSave = useCallback(async () => {
    if (!sttCfg) return;
    setSttSaving(true);
    await api.saveSttConfig(sttCfg);
    setSttSaving(false);
  }, [sttCfg]);

  const handleSttInstall = useCallback(async () => {
    setInstalling(true);
    setInstallLog('正在安装 faster-whisper...\n');
    try {
      const res = await api.sttInstallLocal();
      setInstallLog(prev => prev + (res.output || '') + '\n');
      if (res.ok) {
        setLocalInstalled(true);
        setInstallLog(prev => prev + '✅ 安装成功！');
      } else {
        setInstallLog(prev => prev + '❌ 安装失败');
      }
    } catch (e: any) {
      setInstallLog(prev => prev + '❌ ' + (e.message || '安装异常'));
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onConfigChange({ bgImage: reader.result as string });
    };
    reader.readAsDataURL(file);
    // Reset so selecting the same file again triggers onChange
    e.target.value = '';
  }, [onConfigChange]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
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
              min={11}
              max={28}
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

        {/* 语音转文字 (STT) 设置 */}
        {sttCfg && (
          <div style={sectionStyle}>
            <label style={labelStyle}>🎙️ Voice-to-Text (STT)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select
                value={sttCfg.mode || 'api'}
                onChange={(e) => handleSttChange('mode', e.target.value)}
                style={{ ...inputStyle, flex: '0 0 auto', width: 120 }}
              >
                <option value="api">API (OpenAI)</option>
                <option value="dashscope">DashScope</option>
                <option value="local">Local</option>
              </select>
              <select
                value={sttCfg.language || 'zh'}
                onChange={(e) => handleSttChange('language', e.target.value)}
                style={{ ...inputStyle, flex: '0 0 auto', width: 80 }}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="">Auto</option>
              </select>
            </div>
            {audioDevices.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>Mic:</span>
                <select
                  value={sttCfg.deviceId || ''}
                  onChange={(e) => handleSttChange('deviceId', e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                >
                  <option value="">默认麦克风</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Mic (${d.deviceId.slice(0, 8)})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {sttCfg.mode === 'local' && localInstalled === false && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text)', marginBottom: 6 }}>⚠️ faster-whisper 未安装</div>
                <button
                  onClick={handleSttInstall}
                  disabled={installing}
                  style={{ ...actionBtnStyle, flex: 'none', opacity: installing ? 0.6 : 1 }}
                >
                  {installing ? '⏳ 安装中...' : '📦 一键安装'}
                </button>
                {installLog && (
                  <pre style={{ margin: '6px 0 0', padding: 6, borderRadius: 4, background: 'rgba(0,0,0,0.05)', color: 'var(--theme-text)', fontSize: 10, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const }}>{installLog}</pre>
                )}
              </div>
            )}
            {sttCfg.mode === 'local' && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>Model:</span>
                <select
                  value={sttCfg.localModel || 'base'}
                  onChange={(e) => handleSttChange('localModel', e.target.value)}
                  style={{ ...inputStyle, flex: '0 0 auto', width: 110 }}
                >
                  <option value="tiny">tiny (最快)</option>
                  <option value="base">base (推荐)</option>
                  <option value="small">small</option>
                  <option value="medium">medium</option>
                  <option value="large-v3">large-v3 (最佳)</option>
                </select>
              </div>
            )}
            {sttCfg.mode === 'api' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  placeholder="API Base URL (e.g. https://api.openai.com/v1)"
                  value={sttCfg.apiBaseUrl || ''}
                  onChange={(e) => handleSttChange('apiBaseUrl', e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="API Key"
                  type="password"
                  value={sttCfg.apiKey || ''}
                  onChange={(e) => handleSttChange('apiKey', e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="Model (default: whisper-1)"
                  value={sttCfg.apiModel || ''}
                  onChange={(e) => handleSttChange('apiModel', e.target.value)}
                  style={inputStyle}
                />
              </div>
            )}
            {sttCfg.mode === 'dashscope' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  placeholder="DashScope API Key (DASHSCOPE_API_KEY)"
                  type="password"
                  value={sttCfg.apiKey || ''}
                  onChange={(e) => handleSttChange('apiKey', e.target.value)}
                  style={inputStyle}
                />
                <select
                  value={sttCfg.apiModel || 'sensevoice-v1'}
                  onChange={(e) => handleSttChange('apiModel', e.target.value)}
                  style={{ ...inputStyle, flex: '0 0 auto' }}
                >
                  <option value="sensevoice-v1">SenseVoice v1 (50+ 语言)</option>
                  <option value="paraformer-v2">Paraformer v2 (中英)</option>
                  <option value="qwen3-asr-flash-realtime">Qwen3 ASR Flash Realtime (实时流式)</option>
                  <option value="fun-asr">FunASR (需 pip install dashscope)</option>
                </select>
                <input
                  placeholder="Base URL (可选, 默认阿里云)"
                  value={sttCfg.apiBaseUrl || ''}
                  onChange={(e) => handleSttChange('apiBaseUrl', e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                  sensevoice/paraformer 走兼容接口; qwen3-asr 走 WebSocket 实时流式; fun-asr 走原生 SDK
                </span>
              </div>
            )}
            <button
              onClick={handleSttSave}
              disabled={sttSaving}
              style={{
                ...actionBtnStyle,
                marginTop: 8,
                alignSelf: 'flex-start',
                background: 'rgba(9,105,218,0.15)',
                borderColor: 'rgba(9,105,218,0.3)',
              }}
            >
              {sttSaving ? '保存中...' : '💾 Save STT Config'}
            </button>
          </div>
        )}

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
              title="Export backends + Repo (Prompts + Skills). Sessions are NOT included."
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
              title="Import backends + Repo (overwrites existing). Sessions are untouched."
            >
              📥 Import Data
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
            Includes: Backends config + Repo (Prompts + Skills). Sessions are NOT included.
            <br />
            ⚠️ Import will overwrite matching entries. Skill credentials stay local.
          </p>
        </div>

        {isTauri() && (
          <div style={sectionStyle}>
            <label style={labelStyle}>〰️ Smooth 顺滑问答</label>
            <HackerModeSetting />
          </div>
        )}

        {/* 截图全局快捷键(Tauri only) */}
        {isTauri() && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Screenshot Hotkey</label>
            <ScreenshotHotkeySetting />
            <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
              Triggers the system snip tool while AgentWithU is in the background.
              Picked image lands in the focused pane's attachments.
            </p>
          </div>
        )}

        {/* 界面透明度 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Panel Transparency</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={config.uiOpacity ?? 1}
              onChange={(e) => onConfigChange({ uiOpacity: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
              {Math.round((config.uiOpacity ?? 1) * 100)}%
            </span>
          </div>
          <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--theme-text-muted)' }}>
            Controls bubble / sidebar / header background opacity
          </span>
        </div>

        {/* 背景图 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Background Image</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: config.bgImage ? 10 : 0 }}>
            {config.bgImage && (
              <img
                src={config.bgImage}
                style={{ width: 52, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--theme-border)', flexShrink: 0 }}
              />
            )}
            <button onClick={() => fileInputRef.current?.click()} style={actionBtnStyle}>
              {config.bgImage ? '🖼 Change' : '🖼 Select Image'}
            </button>
            {config.bgImage && (
              <button
                onClick={() => onConfigChange({ bgImage: '' })}
                style={{ ...actionBtnStyle, flex: 'none', padding: '8px 10px', background: 'rgba(255,80,80,0.12)', borderColor: 'rgba(255,80,80,0.3)' }}
                title="Remove background image"
              >
                ✕
              </button>
            )}
          </div>
          {config.bgImage && (
            <div>
              <label style={{ ...labelStyle, marginBottom: 4 }}>Opacity</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.bgOpacity}
                  onChange={(e) => onConfigChange({ bgOpacity: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
                />
                <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
                  {Math.round(config.bgOpacity * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
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

        {/* ---- 分隔线 ---- */}
        <div style={{ borderTop: '1px solid var(--theme-border)', margin: '20px 0' }} />

        {/* 后端管理 */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Model Backends</label>
          <button
            onClick={onOpenBackendManager}
            style={{ ...actionBtnStyle, flex: 'none', width: '100%', background: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.3)' }}
          >
            🔌 Manage Backends
          </button>
        </div>

        {/* ---- 分隔线 ---- */}
        <div style={{ borderTop: '1px solid var(--theme-border)', margin: '20px 0' }} />

        {/* 关于 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>AgentWithU</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginLeft: 8 }}>
              v{appVersion || '…'}
            </span>
          </div>
          <a
            href="https://github.com/SalienceM/agent-with-u"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: 'var(--theme-accent)', textDecoration: 'none' }}
          >
            Source ↗
          </a>
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
const inputStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12, outline: 'none', fontFamily: 'inherit',
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

const HackerModeSetting: React.FC = () => {
  const [value, setValue] = useState<HackerModeConfig>(() => readHackerMode());
  const update = (patch: Partial<HackerModeConfig>) => setValue(writeHackerMode(patch));
  const updateNumber = (key: 'doubleClickMs' | 'x' | 'y' | 'width' | 'height', raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) update({ [key]: Math.round(parsed) });
  };
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      border: `1px solid ${value.enabled ? 'rgba(34,211,238,.55)' : 'var(--theme-border)'}`,
      background: value.enabled ? 'rgba(6,182,212,.08)' : 'rgba(255,255,255,.025)',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
        <input type="checkbox" checked={value.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          style={{ accentColor: '#22d3ee' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>
          {value.enabled ? 'SMOOTH · 后台待命' : '开启 Smooth 模式'}
        </span>
      </label>
      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          触发鼠标键
          <select value={value.mouseButton}
            onChange={(e) => update({ mouseButton: e.target.value as HackerModeConfig['mouseButton'] })}
            style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
            <option value="left">Ctrl + 双击左键（推荐）</option>
            <option value="right">Ctrl + 双击右键</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          双击间隔（ms）
          <input type="number" min={180} max={1000} value={value.doubleClickMs}
            onChange={(e) => updateNumber('doubleClickMs', e.target.value)}
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 4 }} />
        </label>
      </div>
      <div style={{ marginTop: 9, display: 'flex', gap: 8 }}>
        {(['full', 'region'] as const).map((mode) => (
          <button key={mode} onClick={() => update({ captureMode: mode })} style={{
            ...actionBtnStyle,
            borderColor: value.captureMode === mode ? '#22d3ee' : 'var(--theme-border)',
            background: value.captureMode === mode ? 'rgba(34,211,238,.12)' : 'rgba(255,255,255,.05)',
          }}>{mode === 'full' ? '全屏' : '预设区域'}</button>
        ))}
      </div>
      {value.captureMode === 'region' && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label key={key} style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>
              {key.toUpperCase()}
              <input type="number" value={value[key]} onChange={(e) => updateNumber(key, e.target.value)}
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 3 }} />
            </label>
          ))}
        </div>
      )}
      <label style={{ display: 'block', marginTop: 9, fontSize: 11, color: 'var(--theme-text-muted)' }}>
        自动发送的提问词
        <textarea value={value.prompt} onChange={(e) => update({ prompt: e.target.value })}
          rows={2} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: 4 }} />
      </label>
      <div style={{ marginTop: 7, fontSize: 11, lineHeight: 1.5, color: 'var(--theme-text-muted)' }}>
        截图：Ctrl + 双击左/右键。主窗口最大化/最小化：Ctrl + 双击中键。触发点击会被拦截；模型忙碌时截图任务会静默排队。
      </div>
    </div>
  );
};

// 截图全局快捷键的配置 UI:
//   - 显示当前 accelerator(人类友好形态);
//   - 点「Change」进入捕获模式,任意键盘组合 → 立即写入;Esc 取消;
//   - 「Disable」清空 → 禁用快捷键;
//   - 「Default」一键回 CtrlOrCmd+Shift+A。
const ScreenshotHotkeySetting: React.FC = () => {
  const [hotkey, setHotkey] = useState(() => readScreenshotHotkey());
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 监听 App 端注册失败 → 把错误信息回显到这里。
  useEffect(() => {
    const onErr = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string; message?: string } | undefined;
      if (detail?.key === 'screenshot') setError(detail.message || 'failed');
    };
    window.addEventListener('awu:hotkey-error', onErr);
    return () => window.removeEventListener('awu:hotkey-error', onErr);
  }, []);

  // 捕获键盘组合。useCapture 拿到 keydown,阻止冒泡到 textarea / 全局
  // 处理器,免得 Esc 触发 close / 字母进输入框之类。
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(false); return; }
      if (isModifierOnly(e)) return; // 等用户继续按
      const accel = buildAccelerator(e);
      if (!accel) return; // 不是合法组合(单键无修饰),继续等
      writeScreenshotHotkey(accel);
      setHotkey(accel);
      setError(null);
      setCapturing(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  const onDisable = () => {
    writeScreenshotHotkey('');
    setHotkey('');
    setError(null);
  };
  const onDefault = () => {
    writeScreenshotHotkey(SCREENSHOT_HOTKEY_DEFAULT);
    setHotkey(SCREENSHOT_HOTKEY_DEFAULT);
    setError(null);
  };

  const keyCapStyle: React.CSSProperties = {
    minWidth: 140, padding: '6px 12px', borderRadius: 6,
    border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
    background: capturing ? 'rgba(99,102,241,0.25)' : 'var(--theme-input-bg, #fff)',
    color: 'var(--theme-text, #1f2328)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer', textAlign: 'center',
    transition: 'all 0.15s',
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          style={keyCapStyle}
          onClick={() => setCapturing((v) => !v)}
          title={capturing ? 'Press the key combination to set, or Esc to cancel' : 'Click then press your key combination'}
        >
          {capturing ? 'Press keys…' : displayAccelerator(hotkey)}
        </button>
        <button onClick={onDisable} style={actionBtnStyle} disabled={!hotkey}>Disable</button>
        <button onClick={onDefault} style={actionBtnStyle}>Default</button>
      </div>
      {error && (
        <div style={{
          marginTop: 6, fontSize: 11,
          color: 'rgba(239,68,68,0.95)',
        }}>
          Could not register this combo (likely taken by another app or the OS). Pick another.
        </div>
      )}
    </div>
  );
};

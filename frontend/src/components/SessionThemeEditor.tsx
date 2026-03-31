import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { themes, ThemeType, AppConfig } from '../hooks/useConfig';

interface SessionThemeEditorProps {
  sessionId: string;
  currentTheme: ThemeType;
  themeOverrides: Record<string, string> | undefined;
  onClose: () => void;
}

interface ColorOption {
  key: string;
  label: string;
  defaultValue: string;
}

// 可自定义的颜色选项
const COLOR_OPTIONS: ColorOption[] = [
  { key: 'accent', label: '主题色 (Accent)', defaultValue: '#0969da' },
  { key: 'codeBg', label: '代码块背景 (Code BG)', defaultValue: '#f0f2f5' },
  { key: 'userBubbleBg', label: '用户气泡背景', defaultValue: '#ddf4ff' },
  { key: 'userBubbleBorder', label: '用户气泡边框', defaultValue: '#0969da66' },
  { key: 'messageBg', label: '消息区域背景', defaultValue: '#f6f8fa' },
  { key: 'sidebarBg', label: '侧边栏背景', defaultValue: '#f6f8fa' },
  { key: 'inputBg', label: '输入框背景', defaultValue: '#ffffff' },
];

// 预设主题颜色映射
const themePresets: Record<ThemeType, Partial<Record<string, string>>> = {
  dark: {
    accent: '#7aa2f7',
    codeBg: '#16161e',
    userBubbleBg: '#2d3560',
    userBubbleBorder: '#7aa2f788',
    messageBg: '#1f202e',
    sidebarBg: '#1f202e',
    inputBg: '#16161e',
  },
  midnight: {
    accent: '#58a6ff',
    codeBg: '#0d1117',
    userBubbleBg: '#1a3050',
    userBubbleBorder: '#58a6ff88',
    messageBg: '#161b22',
    sidebarBg: '#0d1117',
    inputBg: '#010409',
  },
  light: {
    accent: '#8B1C1C',
    codeBg: '#ede5d6',
    userBubbleBg: '#f0dcd0',
    userBubbleBorder: '#9B233588',
    messageBg: '#ede5d6',
    sidebarBg: '#ede5d6',
    inputBg: '#f7f1e8',
  },
  classic: {
    accent: '#0969da',
    codeBg: '#f0f2f5',
    userBubbleBg: '#ddf4ff',
    userBubbleBorder: '#0969da66',
    messageBg: '#f6f8fa',
    sidebarBg: '#f6f8fa',
    inputBg: '#ffffff',
  },
};

export const SessionThemeEditor: React.FC<SessionThemeEditorProps> = ({
  sessionId,
  currentTheme,
  themeOverrides,
  onClose,
}) => {
  const [selectedTheme, setSelectedTheme] = useState<ThemeType>(currentTheme);
  const [customColors, setCustomColors] = useState<Record<string, string>>({});
  const [isCustomTheme, setIsCustomTheme] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ status: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    status: 'idle',
  });

  // 初始化颜色
  useEffect(() => {
    // 从预设主题加载颜色
    const preset = themePresets[currentTheme] || {};
    const initialColors: Record<string, string> = {};

    COLOR_OPTIONS.forEach((opt) => {
      // 优先使用 themeOverrides，其次是预设，最后是默认值
      const value =
        themeOverrides?.[opt.key] ||
        preset[opt.key] ||
        opt.defaultValue;
      initialColors[opt.key] = value as string;
    });

    setCustomColors(initialColors);
    setIsCustomTheme(false);
  }, [currentTheme, themeOverrides]);

  // 检查当前颜色是否与选中主题的预设一致
  useEffect(() => {
    if (!selectedTheme) return;
    const preset = themePresets[selectedTheme] || {};
    const isDifferent = COLOR_OPTIONS.some(
      (opt) => customColors[opt.key] !== preset[opt.key]
    );
    setIsCustomTheme(isDifferent);
  }, [selectedTheme, customColors]);

  const handleColorChange = useCallback(
    (key: string, value: string) => {
      setCustomColors((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleThemeChange = useCallback(
    (theme: ThemeType) => {
      setSelectedTheme(theme);
      const preset = themePresets[theme] || {};
      setCustomColors((prev) => {
        const updated: Record<string, string> = { ...prev };
        COLOR_OPTIONS.forEach((opt) => {
          if (preset[opt.key]) {
            updated[opt.key] = preset[opt.key] as string;
          }
        });
        return updated;
      });
      setIsCustomTheme(false);
    },
    []
  );

  const handleResetToPreset = useCallback(() => {
    const preset = themePresets[selectedTheme] || {};
    const updatedColors: Record<string, string> = {};
    COLOR_OPTIONS.forEach((opt) => {
      if (preset[opt.key]) {
        updatedColors[opt.key] = preset[opt.key] as string;
      }
    });
    setCustomColors((prev) => ({
      ...prev,
      ...updatedColors,
    }));
    setIsCustomTheme(false);
  }, [selectedTheme]);

  const handleSave = useCallback(async () => {
    setSaveStatus({ status: 'saving' });

    const overrides = isCustomTheme ? customColors : undefined;

    try {
      const result = await api.updateSessionTheme(sessionId, overrides);
      if (!result) {
        setSaveStatus({ status: 'error', message: '保存失败：无法连接到后端' });
        setTimeout(() => setSaveStatus({ status: 'idle' }), 2000);
        return;
      }
      if (result.status === 'ok') {
        setSaveStatus({ status: 'success', message: '主题已保存' });
        setTimeout(() => {
          setSaveStatus({ status: 'idle' });
          onClose();
        }, 1500);
      } else {
        setSaveStatus({ status: 'error', message: result.message || '保存失败' });
        setTimeout(() => setSaveStatus({ status: 'idle' }), 2000);
      }
    } catch (e: any) {
      setSaveStatus({ status: 'error', message: e.message || '保存失败' });
      setTimeout(() => setSaveStatus({ status: 'idle' }), 2000);
    }
  }, [sessionId, isCustomTheme, customColors, onClose]);

  const handleReset = useCallback(() => {
    const preset = themePresets[selectedTheme] || {};
    const resetColors: Record<string, string> = {};
    COLOR_OPTIONS.forEach((opt) => {
      if (preset[opt.key]) {
        resetColors[opt.key] = preset[opt.key] as string;
      }
    });
    setCustomColors(resetColors);
    setIsCustomTheme(false);
  }, [selectedTheme]);

  // 小色块组件
  const ColorSwatch: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({
    label,
    value,
    onChange,
  }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState(value);

    useEffect(() => setInputValue(value), [value]);

    const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
      if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value) || /^#[0-9A-Fa-f]{8}$/.test(e.target.value)) {
        onChange(e.target.value);
      }
    };

    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'block' }}>
          {label}
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 6,
              background: value,
              border: '1px solid var(--theme-border)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onClick={() => setIsOpen(!isOpen)}
            title="点击选择颜色"
          />
          <input
            type="text"
            value={inputValue}
            onChange={handleHexChange}
            style={{
              ...inputStyle,
              flex: 1,
              fontFamily: 'monospace',
              fontSize: 12,
            }}
            placeholder="#RRGGBB"
          />
          <button
            onClick={() => setIsOpen(!isOpen)}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: 'var(--theme-input-bg)',
              border: '1px solid var(--theme-border)',
              color: 'var(--theme-text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {isOpen ? '收起' : '更多'}
          </button>
        </div>
        {isOpen && (
          <div
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 6,
            }}
          >
            {[
              '#ef4444',
              '#f97316',
              '#eab308',
              '#22c55e',
              '#10b981',
              '#14b8a6',
              '#06b6d4',
              '#0ea5e9',
              '#3b82f6',
              '#6366f1',
              '#8b5cf6',
              '#d946ef',
              '#ec4899',
              '#f43f5e',
              '#64748b',
              '#94a3b8',
            ].map((color) => (
              <button
                key={color}
                onClick={() => {
                  onChange(color);
                  setIsOpen(false);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 4,
                  background: color,
                  border: '1px solid var(--theme-border)',
                  cursor: 'pointer',
                }}
                title={color}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={overlayStyle} onClick={(e) => e.preventDefault()}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: '1px solid var(--theme-border)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
            🎨 会话主题
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>
            ✕
          </button>
        </div>

        {/* 主题选择 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--theme-text)', marginBottom: 8, display: 'block' }}>
            选择主题预设
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(themes) as ThemeType[]).map((themeKey) => (
              <button
                key={themeKey}
                onClick={() => handleThemeChange(themeKey)}
                style={{
                  ...themeBtnStyle,
                  background: themes[themeKey].accent + '20',
                  borderColor: selectedTheme === themeKey ? themes[themeKey].accent : 'var(--theme-border)',
                  color:
                    selectedTheme === themeKey
                      ? themes[themeKey].accent
                      : 'var(--theme-text-muted)',
                  fontWeight: selectedTheme === themeKey ? 600 : 400,
                }}
              >
                {themes[themeKey].name}
                {themeKey === currentTheme && !isCustomTheme && ' (当前)'}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            选择一个预设主题，然后自定义颜色。自定义颜色仅应用于当前会话。
          </p>
        </div>

        {/* 颜色自定义 */}
        {isCustomTheme && (
          <div style={{ marginBottom: 20, padding: 12, background: 'rgba(99,102,241,0.08)', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--theme-accent)' }}>
                自定义颜色
              </h3>
              <button onClick={handleResetToPreset} style={{ fontSize: 11, color: 'var(--theme-accent)', cursor: 'pointer' }}>
                重置为 {themes[selectedTheme].name} 预设
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {COLOR_OPTIONS.map((opt) => (
                <ColorSwatch
                  key={opt.key}
                  label={opt.label}
                  value={customColors[opt.key]}
                  onChange={(value) => handleColorChange(opt.key, value)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={handleSave}
            disabled={saveStatus.status === 'saving'}
            style={{
              ...saveBtnStyle,
              flex: 1,
              opacity: saveStatus.status === 'saving' ? 0.6 : 1,
            }}
          >
            {saveStatus.status === 'saving' ? '保存中...' : '保存主题'}
          </button>
          <button onClick={handleReset} style={cancelBtnStyle}>
            重置
          </button>
        </div>

        {/* 状态消息 */}
        {saveStatus.status === 'success' && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(34,197,94,0.12)',
              color: 'rgba(34,197,94,0.9)',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            {saveStatus.message}
          </div>
        )}
        {saveStatus.status === 'error' && (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(239,68,68,0.12)',
              color: 'rgba(239,68,68,0.9)',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            {saveStatus.message}
          </div>
        )}
      </div>
    </div>
  );
};

// ── styles ──
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)',
  border: '1px solid var(--theme-border)',
  borderRadius: 12,
  padding: 24,
  width: '90%',
  maxWidth: 520,
  maxHeight: '85vh',
  overflowY: 'auto',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--theme-text-muted)',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 8px',
};

const themeBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s',
  flexShrink: 0,
};

const saveBtnStyle: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 8,
  background: 'var(--theme-accent)',
  border: 'none',
  color: '#fff',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 8,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)',
  fontSize: 13,
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  color: 'var(--theme-text)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface ConstraintsEditorProps {
  sessionId: string;
  currentConstraints: string | undefined;
  onClose: () => void;
}

export const ConstraintsEditor: React.FC<ConstraintsEditorProps> = ({
  sessionId,
  currentConstraints,
  onClose,
}) => {
  const [constraints, setConstraints] = useState<string>('');
  const [saveStatus, setSaveStatus] = useState<{ status: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    status: 'idle',
  });

  // Initialize constraints
  useEffect(() => {
    setConstraints(currentConstraints || '');
  }, [currentConstraints]);

  const handleSave = useCallback(async () => {
    setSaveStatus({ status: 'saving' });

    try {
      // 直接传入纯字符串，API 会处理
      const result = await api.updateSessionConstraints(sessionId, constraints);
      if (!result) {
        setSaveStatus({ status: 'error', message: '保存失败：无法连接到后端' });
        setTimeout(() => setSaveStatus({ status: 'idle' }), 2000);
        return;
      }
      if (result.status === 'ok') {
        setSaveStatus({ status: 'success', message: '约束已保存' });
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
  }, [sessionId, constraints, onClose]);

  const handleReset = useCallback(() => {
    setConstraints(currentConstraints || '');
  }, [currentConstraints]);

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
            📋 会话约束
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>
            ✕
          </button>
        </div>

        {/* 说明文字 */}
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-accent-bg, #7aa2f726)', borderRadius: 8 }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--theme-accent, #7aa2f7)' }}>约束/提示词</strong> 是应用于当前会话的限定性规则或特殊提示。
            <br />
            这些内容会在每次与 AI 交互时自动包含，用于：
          </p>
          <ul style={{ margin: '8px 0 0 0', paddingLeft: 18, fontSize: 11, color: 'var(--theme-text-muted)' }}>
            <li>强制 AI 遵循特定的行为规则</li>
            <li>定义特殊的输出格式要求</li>
            <li>添加领域特定的上下文约束</li>
            <li>设置代码风格或文档规范</li>
          </ul>
        </div>

        {/* 约束输入 */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'block' }}>
            约束/提示词内容
          </label>
          <textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            style={{
              ...textareaStyle,
              minHeight: 120,
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              fontSize: 13,
              lineHeight: 1.5,
            }}
            placeholder="在此输入约束或提示词...&#10;&#10;例如：&#10;1. 所有代码必须使用 TypeScript 编写&#10;2. 禁止使用 eval() 函数&#10;3. 所有文档必须使用中文撰写"
          />
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            每次与该会话交互时，这些内容都会作为系统提示的一部分发送给 AI。
            留空则使用默认设置。
          </p>
        </div>

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
            {saveStatus.status === 'saving' ? '保存中...' : '保存约束'}
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

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 8,
  color: 'var(--theme-text)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
};

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface AuthStatusBannerProps {
  /** 当前激活的后端配置对象（含 type / env） */
  activeBackend: any | null;
}

// 依赖 claude login（OAuth）的后端类型
const CLAUDE_CLI_TYPES = ['claude-agent-sdk', 'claude-code-official'];

type AuthStatus = {
  loggedIn: boolean;
  method: 'oauth' | 'apiKey' | 'none';
  expired: boolean;
  credentialsPath: string;
};

export const AuthStatusBanner: React.FC<AuthStatusBannerProps> = ({ activeBackend }) => {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const isClaudeCli = !!activeBackend && CLAUDE_CLI_TYPES.includes(activeBackend.type);
  const dismissKey = activeBackend?.id ? `awu-auth-banner-dismissed:${activeBackend.id}` : '';
  // 该后端自带 token/API Key（在 Backend Manager 里填了），无需 claude login
  const env = (activeBackend?.env || {}) as Record<string, string>;
  const hasOwnToken = !!(
    activeBackend?.apiKey
    || env.ANTHROPIC_AUTH_TOKEN
    || env.ANTHROPIC_API_KEY
  );

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.getAuthStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (isClaudeCli && !hasOwnToken) check();
  }, [isClaudeCli, hasOwnToken, check]);

  // 切换后端或刷新页面后，沿用用户对该 backend 的隐藏选择，避免反复提示。
  useEffect(() => {
    if (!dismissKey) {
      setDismissed(false);
      return;
    }
    setDismissed(localStorage.getItem(dismissKey) === '1');
  }, [dismissKey]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (dismissKey) localStorage.setItem(dismissKey, '1');
  }, [dismissKey]);

  if (!isClaudeCli || hasOwnToken || dismissed) return null;
  if (!status || status.loggedIn) return null;

  const expired = status.expired;

  return (
    <div style={bannerStyle}>
      <span style={{ fontSize: 16 }}>{expired ? '⏰' : '🔑'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {expired ? 'Claude 登录已过期' : 'Claude 未登录'}
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
          在运行后端的服务器上执行 <code style={codeStyle}>claude login</code>
          （或启动 <code style={codeStyle}>claude</code> 后输入 <code style={codeStyle}>/login</code>）；
          如果缺少 CLI，请先执行 <code style={codeStyle}>npm install -g @anthropic-ai/claude-code</code>。
          也可在 Backend Manager 中为该后端填写 API Key 或第三方 Base URL+Token。
          {status.credentialsPath && (
            <span style={{ opacity: 0.7 }}> 凭证路径：{status.credentialsPath}</span>
          )}
        </div>
      </div>
      <button onClick={check} style={btnStyle} disabled={checking}>
        {checking ? '检测中…' : '重新检测'}
      </button>
      <button onClick={dismiss} style={closeBtnStyle} title="不再提示此后端">✕</button>
    </div>
  );
};

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 14px',
  background: 'rgba(234,179,8,0.12)',
  borderBottom: '1px solid rgba(234,179,8,0.3)',
  color: 'var(--theme-text, #1f2328)',
};

const codeStyle: React.CSSProperties = {
  background: 'var(--theme-code-bg, rgba(0,0,0,0.15))',
  padding: '1px 5px',
  borderRadius: 4,
  fontSize: 11,
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
};

const btnStyle: React.CSSProperties = {
  background: 'rgba(234,179,8,0.18)',
  border: '1px solid rgba(234,179,8,0.45)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 10px',
  borderRadius: 6,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--theme-text-muted)',
  fontSize: 14,
  cursor: 'pointer',
  padding: '2px 4px',
};

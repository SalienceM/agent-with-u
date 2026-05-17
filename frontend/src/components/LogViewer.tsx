import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface LogViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ isOpen, onClose }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [path, setPath] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getBackendLogs(800);
      if (r.ok) {
        setLines(r.lines);
        setPath(r.path || '');
        setError('');
      } else {
        setError(r.error || 'failed to read logs');
      }
    } catch (e: any) {
      setError(e?.message || 'failed to read logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchLogs();
    if (!autoRefresh) return;
    const t = setInterval(fetchLogs, 3000);
    return () => clearInterval(t);
  }, [isOpen, autoRefresh, fetchLogs]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
            📋 Backend Logs
          </h2>
          <div style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--theme-text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ accentColor: 'var(--theme-accent)' }}
            />
            自动刷新
          </label>
          <button onClick={fetchLogs} style={btnStyle} disabled={loading}>
            {loading ? '...' : '刷新'}
          </button>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {path && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 6, wordBreak: 'break-all' }}>
            {path}
          </div>
        )}

        <div ref={bodyRef} style={bodyStyle}>
          {error ? (
            <div style={{ color: 'var(--theme-error, #f85149)' }}>{error}</div>
          ) : lines.length === 0 ? (
            <div style={{ color: 'var(--theme-text-muted)' }}>（暂无日志）</div>
          ) : (
            lines.map((ln, i) => (
              <div key={i} style={lineStyle}>{ln || ' '}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #1f202e)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 12,
  padding: 16,
  width: '90%',
  maxWidth: 900,
  height: '80vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  background: 'var(--theme-code-bg, #16161e)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  borderRadius: 8,
  padding: '8px 12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--theme-text, #e2e3ea)',
};

const lineStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--theme-accent-bg)',
  border: '1px solid var(--theme-accent)',
  color: 'var(--theme-accent)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 12px',
  borderRadius: 6,
  fontWeight: 500,
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--theme-text-muted)',
  fontSize: 16,
  cursor: 'pointer',
  padding: '2px 6px',
};

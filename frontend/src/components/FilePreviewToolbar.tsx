import React from 'react';

interface Props {
  name: string;
  relativePath: string;
  source: 'local' | 'remote';
  icon: string;
  nodeLabel?: string;
  dirty?: boolean;
  compact?: boolean;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}

/** 原预览与分离窗口共用同一标题、来源标记及操作栏；关闭按钮不随工具横向滚走。 */
export const FilePreviewToolbar: React.FC<Props> = ({ name, relativePath, source, icon, nodeLabel,
  dirty, compact, trailing, children }) => (
  <header data-file-preview-toolbar style={{ ...previewToolbarStyle, ...(compact ? { height: 38, padding: '0 8px', gap: 6 } : {}) }}>
    {!compact && <span aria-hidden style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>}
    <span style={{ fontWeight: compact ? 400 : 600, fontSize: compact ? 11 : 13, minWidth: 35, maxWidth: 240,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: compact ? 'var(--theme-text-muted)' : undefined }}
      title={`${relativePath} · ${nodeLabel || ''}`}>
      {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{compact ? relativePath : name}
    </span>
    <span style={previewSourceTagStyle} title={nodeLabel}>
      {compact ? source === 'local' ? '本机副本' : '执行端' : source === 'local' ? '💻 本机' : '☁️ 远端'}
    </span>
    <div style={{ flex: 1 }} />
    <div data-preview-actions style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap' }}>
      {children}
    </div>
    {trailing && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{trailing}</div>}
  </header>
);

export const previewToolbarStyle: React.CSSProperties = {
  height: 42, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
  flexShrink: 0, minWidth: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
};
export const previewToolbarButtonStyle: React.CSSProperties = {
  padding: '4px 9px', fontSize: 11, borderRadius: 5,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.14))',
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.05))',
  color: 'var(--theme-text, #c9d1d9)', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
};
export const previewSegmentStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10.5, border: 'none', background: 'transparent',
  color: 'var(--theme-text-muted, #8b949e)', cursor: 'pointer', whiteSpace: 'nowrap',
};
export const previewSegmentActiveStyle: React.CSSProperties = {
  color: 'var(--theme-accent, #58a6ff)', background: 'var(--theme-accent-bg, rgba(88,166,255,0.12))',
};
const previewSourceTagStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(88,166,255,0.15)', color: '#58a6ff', border: '1px solid rgba(88,166,255,0.25)',
  minWidth: 0, maxWidth: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

import React, { useState } from 'react';
import { usePreviewSize } from '../hooks/usePreviewLayout';

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
  dirty, compact, trailing, children }) => {
  const size = usePreviewSize<HTMLDivElement>();
  const narrow = size.width < 640;
  const [panel, setPanel] = useState<'identity' | 'tools' | null>(null);
  return <div ref={size.ref} data-file-preview-toolbar style={{ minWidth: 0, flexShrink: 0 }}>
  <style>{`[data-preview-exit] button { min-width:44px!important; min-height:44px!important; flex-shrink:0; }
    [data-preview-tools] button, [data-preview-tools] select { min-height:36px; }
    [data-preview-tools] > * { flex-shrink:0; }`}</style>
  <header style={{ ...previewToolbarStyle, padding: '0 4px', gap: 4 }}>
    {!compact && <span aria-hidden style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>}
    <button aria-label="查看文件名和来源" aria-expanded={panel === 'identity'} onClick={() => setPanel(panel === 'identity' ? null : 'identity')}
      style={{ ...previewToolbarButtonStyle, border: 0, background: 'transparent', flex: '1 1 0', textAlign: 'left', fontWeight: compact ? 400 : 600, minWidth: 0,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={`${relativePath} · ${nodeLabel || ''}`}>
      {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{compact ? relativePath : name}
    </button>
    {!narrow && <span style={previewSourceTagStyle} title={nodeLabel}>
      {compact ? source === 'local' ? '本机副本' : '执行端' : source === 'local' ? '💻 本机' : '☁️ 远端'}
    </span>}
    {narrow && <button style={{ ...previewToolbarButtonStyle, minHeight: 44 }} aria-expanded={panel === 'tools'} onClick={() => setPanel(panel === 'tools' ? null : 'tools')}>工具</button>}
    {!narrow && <div data-preview-actions style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '65%', overflowX: 'auto', whiteSpace: 'nowrap' }}>
      {children}
    </div>}
    {trailing && <div data-preview-exit style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>{trailing}</div>}
  </header>
  {panel === 'identity' && <div style={{ padding: 10, maxHeight: 'min(140px, 25dvh)', overflow: 'auto', overflowWrap: 'anywhere', fontSize: 12 }}>
    <div>{name}</div><div>{relativePath}</div><div>{source === 'local' ? '本机副本' : '执行端'} · {nodeLabel || '当前节点'}</div>
    <button style={previewToolbarButtonStyle} onClick={() => setPanel(null)}>收起详情</button>
  </div>}
  {narrow && panel === 'tools' && <div data-preview-tools style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 6, maxHeight: 'min(140px, 25dvh)', overflow: 'auto' }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPanel(null); (e.currentTarget.parentElement?.querySelector('button[aria-expanded="true"]') as HTMLElement)?.focus(); } }}>{children}</div>}
  </div>;
};

export const previewToolbarStyle: React.CSSProperties = {
  height: 48, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
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

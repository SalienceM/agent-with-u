import React, { useEffect, useId, useRef } from 'react';
import { AppModalPortal } from './AppModalPortal';

interface Props {
  entries: Array<{ rel: string; isDir: boolean }>;
  batch?: boolean;
  workingDir: string;
  executor: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 文件删除始终使用应用内明确确认，不依赖宿主的原生 confirm 行为。 */
export const FileDeleteConfirmation: React.FC<Props> = ({ entries, batch, workingDir, executor, onCancel, onConfirm }) => {
  const isDirectory = entries.some(entry => entry.isDir);
  const titleId = useId(), descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  return <AppModalPortal>
    <div style={{ position: 'fixed', inset: 0, zIndex: 18000, background: '#0008', display: 'grid', placeItems: 'center', padding: 16 }}
      onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onCancel(); }}
      onClick={event => event.stopPropagation()}>
      <section role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
        style={{ width: 'min(440px, 100%)', maxHeight: '85dvh', overflowY: 'auto', boxSizing: 'border-box', padding: 20,
          borderRadius: 12, background: 'var(--theme-panel-solid, #161b22)', color: 'var(--theme-text, #e6edf3)',
          border: '1px solid var(--theme-border, #30363d)', boxShadow: '0 16px 64px #0006' }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          if (event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === cancelRef.current ? confirmRef : cancelRef).current?.focus();
          }
        }}>
        <h3 id={titleId} style={{ margin: '0 0 14px', fontSize: 16 }}>{batch ? `确认批量删除 ${entries.length} 项` : isDirectory ? '确认删除远端目录' : '确认删除远端文件'}</h3>
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--theme-input-bg, #ffffff08)', overflowWrap: 'anywhere' }}>
          <div style={{ maxHeight: '35dvh', overflowY: 'auto' }}>{entries.map(entry => <div key={entry.rel} style={{ fontSize: 14, padding: '3px 0' }}>
            {batch && <span aria-hidden="true">{entry.isDir ? '📁 ' : '📄 '}</span>}<strong>{entry.rel}</strong>
          </div>)}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-text-muted, #8b949e)' }}>执行节点：{executor}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--theme-text-muted, #8b949e)' }}>工作目录：{workingDir}</div>
        </div>
        <p id={descriptionId} style={{ margin: '14px 0 18px', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-error, #f85149)' }}>
          {batch ? `将永久删除以上 ${entries.length} 项${isDirectory ? '，目录包含全部内容（含隐藏文件）' : ''}，不经过回收站。本机副本保留。`
            : isDirectory ? '将永久删除此目录及全部内容（含隐藏文件），不经过回收站。' : '将永久删除此文件，不经过回收站。'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button ref={cancelRef} type="button" onClick={onCancel} style={buttonStyle}>取消</button>
          <button ref={confirmRef} type="button" onClick={onConfirm}
            style={{ ...buttonStyle, color: '#fff', background: '#b42318', borderColor: '#b42318' }}>确认删除</button>
        </div>
      </section>
    </div>
  </AppModalPortal>;
};

const buttonStyle: React.CSSProperties = {
  minHeight: 36, padding: '7px 16px', borderRadius: 7, cursor: 'pointer', fontSize: 13,
  border: '1px solid var(--theme-border, #30363d)', color: 'inherit', background: 'transparent',
};

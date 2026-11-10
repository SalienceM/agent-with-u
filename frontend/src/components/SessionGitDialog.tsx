import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AppModalPortal } from './AppModalPortal';
import { FileTreePanel } from './FileTreePanel';

interface GitSession {
  id: string; title: string; workingDir: string; backendId: string;
  execKey?: string; execLabel?: string; execMode?: 'local' | 'relay'; codexConnectionMode?: string;
}

/** 会话右键直达 Git，先核对原节点的会话元数据，不切换当前会话或文件视图。 */
export const SessionGitDialog: React.FC<{ session: GitSession; focusTarget?: HTMLElement; onClose: () => void }> = ({ session, focusTarget, onClose }) => {
  const [target, setTarget] = useState<GitSession | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const returnFocus = useRef(focusTarget);
  useEffect(() => () => { requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }); }, []);
  useEffect(() => {
    let live = true;
    setTarget(null); setError('');
    void (async () => {
      try {
        if (!session.execKey) throw new Error('无法确认此会话的执行节点');
        const latest = await api.loadSessionMeta(session.id);
        if (!latest || latest.id !== session.id || latest.execKey !== session.execKey) throw new Error('会话或执行节点已变化，请重新打开');
        if (!latest.workingDir) throw new Error('此会话未设置工作目录');
        if (latest.codexConnectionMode === 'ssh') throw new Error('SSH 会话的 Git 操作需在原 SSH 主机执行');
        if (live) setTarget({ ...session, ...latest, execKey: session.execKey });
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, [session.id, session.execKey, revision]);
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 8990, display: 'grid', placeItems: 'center', padding: 12, background: '#0007' }}>
    <section role="dialog" aria-modal="true" aria-label="会话 Git 工作区" style={{ width: 'min(540px, 100%)', maxHeight: 'calc(100dvh - 24px)', overflow: 'auto',
      borderRadius: 12, border: '1px solid var(--theme-border)', background: 'var(--theme-panel-solid, #161b22)', color: 'var(--theme-text, #e6edf3)', padding: 16, boxSizing: 'border-box' }}
      onKeyDown={event => {
        // 提交/历史等子面板通过 Portal 弹出，不能由外层 Escape 关闭。
        if (!event.currentTarget.contains(event.target as Node) || event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }
      }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}><h2 style={{ margin: 0, fontSize: 16 }}>Git 工作区</h2>
          <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere', marginTop: 5 }}>{target?.title || session.title}</div></div>
        <button autoFocus type="button" aria-label="关闭 Git 工作区" onClick={onClose} style={{ cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit', padding: 8 }}>✕</button>
      </header>
      {target ? <><div style={{ fontSize: 11, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere', marginBottom: 12 }}>
        {target.execLabel || target.execKey} · {target.workingDir}</div>
        <FileTreePanel gitOnly sessionId={target.id} workingDir={target.workingDir} execKey={target.execKey} execLabel={target.execLabel} execMode={target.execMode} backendId={target.backendId} /></>
        : <div role="status">{error || '正在读取会话工作区…'}{error && <button onClick={() => setRevision(value => value + 1)} style={{ marginLeft: 8 }}>重试</button>}</div>}
    </section>
  </div></AppModalPortal>;
};

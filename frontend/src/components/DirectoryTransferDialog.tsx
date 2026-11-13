import React, { useEffect, useRef, useState } from 'react';
import { AppModalPortal } from './AppModalPortal';
import { WorkflowButton, workflowDialogStyle, workflowHeaderStyle, workflowFieldStyle } from './WorkflowControls';
import { cancelDirectoryTransfer, prepareDirectoryTransfer, submitDirectoryTransfer, type DirectoryTransferInput, type PreparedDirectoryTransfer } from '../utils/checkedDirectoryTransfer';

export const DirectoryTransferDialog: React.FC<{ input: DirectoryTransferInput; onClose: () => void; onChanged: () => void; focusTarget?: HTMLElement | null }> = ({ input, onClose, onChanged, focusTarget }) => {
  const [mirror, setMirror] = useState(input.mirror), [prepared, setPrepared] = useState<PreparedDirectoryTransfer | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const panel = useRef<HTMLDivElement>(null), trigger = useRef(focusTarget || document.activeElement as HTMLElement | null);
  const currentPlan = useRef<PreparedDirectoryTransfer | null>(null), submitted = useRef(false), generation = useRef(0);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close.current(); } };
    document.addEventListener('keydown', escape); panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      generation.current++; document.removeEventListener('keydown', escape);
      if (!submitted.current && currentPlan.current) void cancelDirectoryTransfer(currentPlan.current).catch(() => {});
      requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus(); });
    };
  }, []);
  useEffect(() => {
    const request = ++generation.current;
    if (currentPlan.current) void cancelDirectoryTransfer(currentPlan.current).catch(() => {});
    currentPlan.current = null; setPrepared(null); setLoading(true); setError('');
    prepareDirectoryTransfer({ ...input, mirror, includeGit: mirror ? false : input.includeGit }).then(value => {
      if (generation.current !== request) { void cancelDirectoryTransfer(value).catch(() => {}); return; }
      currentPlan.current = value; setPrepared(value);
    }).catch(reason => { if (generation.current === request) setError(String(reason.message || reason)); })
      .finally(() => { if (generation.current === request) setLoading(false); });
  }, [input, mirror]);
  const entries = prepared?.plan.entries || [];
  const deletions = entries.filter(e => e.action === 'delete');
  const writes = entries.filter(e => e.action === 'add' || e.action === 'update');
  const bytes = writes.reduce((sum, e) => sum + e.size, 0);
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, background: '#0007', display: 'grid', placeItems: 'center', padding: 12 }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label="上传到执行端" style={{ ...workflowDialogStyle, width: 'min(500px, 100%)', maxHeight: 'calc(100dvh - 24px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--theme-panel-solid, #fff)', color: 'var(--theme-text, #273244)' }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const elements = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')];
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header style={workflowHeaderStyle}><h2 style={{ margin: 0, flex: 1, fontSize: 16 }}>上传到执行端</h2><WorkflowButton icon="close" tone="quiet" aria-label="关闭传输预览" onClick={onClose} /></header>
      <div style={{ padding: '14px 18px', overflowY: 'auto', overflowWrap: 'anywhere', fontSize: 12 }}>
        <p style={{ margin: '0 0 10px' }}>本机副本 → {input.label}</p>
        <div style={{ color: 'var(--theme-text-muted)', lineHeight: 1.6 }}>来源：{input.fs.label()}<br />目标：{input.workingDir}<br />范围：{input.scope || '整个目录'}</div>
        {input.directory && <label style={{ display: 'block', marginTop: 14 }}>传输模式<select aria-label="传输模式" disabled={sending} value={mirror ? 'mirror' : 'copy'} style={{ ...workflowFieldStyle, marginTop: 5 }} onChange={event => setMirror(event.target.value === 'mirror')}>
          <option value="copy">上传变化 · 保留目标多余文件</option><option value="mirror">镜像同步 · 删除目标多余文件</option>
        </select></label>}
        <p style={{ color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>{mirror ? '按本机目录同步目标文件。Git 元数据、忽略项和范围外内容保留。' : '先检查实际内容，相同文件自动跳过。'}</p>
        {loading && <p role="status">{sending ? '正在上传变化并核对结果…关闭后可在传输中心查看进展。' : '正在检查两端文件内容…'}</p>}
        {error && <p role="alert" style={{ color: '#d74b4b' }}>{error}</p>}
        {prepared && <>
          <p role="status">新增 {entries.filter(e => e.action === 'add').length} · 覆盖 {entries.filter(e => e.action === 'update').length} · 跳过 {entries.filter(e => e.action === 'skip').length} · 删除 {deletions.length}</p>
          <p>实际传输：{bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`}</p>
          {deletions.length > 0 && <div style={{ border: '1px solid var(--theme-border)', borderRadius: 8, padding: 10 }}>
            <strong style={{ color: '#d74b4b' }}>将删除执行端的 {deletions.length} 个文件</strong>
            <ul aria-label="待删除文件" tabIndex={0} style={{ margin: '8px 0 0', paddingLeft: 18, maxHeight: 150, overflowY: 'auto' }}>{deletions.map(e => <li key={e.path}>{e.path}</li>)}</ul>
          </div>}
          {writes.length > 0 && <details style={{ marginTop: 10 }}><summary>查看新增和覆盖文件（{writes.length}）</summary><ul style={{ paddingLeft: 18, maxHeight: 130, overflowY: 'auto' }}>{writes.map(e => <li key={e.path}>{e.action === 'add' ? '新增' : '覆盖'} · {e.path}</li>)}</ul></details>}
        </>}
      </div>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--theme-border)' }}>
        <WorkflowButton tone="quiet" onClick={onClose}>{sending ? '关闭' : '取消'}</WorkflowButton>
        <WorkflowButton tone="primary" disabled={loading || !prepared} onClick={() => {
          if (!prepared) return;
          submitted.current = true; setLoading(true); setSending(true);
          void submitDirectoryTransfer(prepared, onChanged, onClose).catch(reason => {
            submitted.current = false; setLoading(false); setSending(false); setError(String(reason.message || reason));
          });
        }}>{sending ? '正在传输…' : mirror && deletions.length ? '确认同步并删除' : '确认传输'}</WorkflowButton>
      </footer>
    </div>
  </div></AppModalPortal>;
};

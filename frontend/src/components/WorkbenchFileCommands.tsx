import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceDocuments } from '../utils/workspaceDocuments';
import { uuid } from '../utils/uuid';
import { WorkbenchButton, WorkbenchPopover, workbenchButtonStyle, workbenchFieldStyle } from './WorkbenchChrome';

interface Props {
  host: HTMLElement; visible: boolean; scope: string;
  connect: () => Promise<WorkspaceDocuments>;
  onOpen: (path: string, line?: number, column?: number) => void;
  onActivate: () => void;
  onEditorCommand: (type: 'search' | 'line') => void;
  editable: boolean; relativePath?: string; draft?: string;
}
const button = workbenchButtonStyle;
/** 工程检索不复用目录传输接口；所有结果保持执行端来源，不把离线副本当成远端。 */
export const WorkbenchFileCommands: React.FC<Props> = props => {
  const [panel, setPanel] = useState<'files' | 'content' | 'diff' | null>(null);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<{ relativePath: string; line?: number; column?: number; preview?: string }[]>([]);
  const [status, setStatus] = useState('');
  const [diff, setDiff] = useState<{ baseline: string; disk: string; draft?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0), pending = useRef<{ client: WorkspaceDocuments; id: string } | null>(null);
  const latest = useRef(props); latest.current = props;
  const returnFocus = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = () => {
    sequence.current++; const request = pending.current; pending.current = null;
    if (request) void request.client.cancelSearch(request.id).catch(() => {});
    setBusy(false);
  };
  const close = () => { cancel(); setPanel(null); setRows([]); setDiff(null); returnFocus.current?.focus(); };
  const show = (mode: 'files' | 'content' | 'diff') => {
    cancel(); returnFocus.current = document.activeElement as HTMLElement;
    setPanel(mode); setRows([]); setDiff(null); setStatus(''); props.onActivate();
  };
  useEffect(() => {
    const host = props.host.closest('.awu-session-workbench') || props.host.parentElement;
    const keydown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (!latest.current.visible || !(key.ctrlKey || key.metaKey) || key.altKey) return;
      if (key.key.toLowerCase() === 'p' && !key.shiftKey || key.key.toLowerCase() === 'f' && key.shiftKey) {
        key.preventDefault(); key.stopPropagation(); show(key.shiftKey ? 'content' : 'files');
      }
    };
    host?.addEventListener('keydown', keydown);
    return () => host?.removeEventListener('keydown', keydown);
  }, [props.host]);
  useEffect(() => { if (panel && panel !== 'diff') input.current?.focus(); }, [panel]);
  useEffect(() => { if (!props.visible) close(); }, [props.visible]);
  useEffect(() => () => { sequence.current++; const request = pending.current;
    if (request) void request.client.cancelSearch(request.id).catch(() => {}); }, [props.scope]);
  const search = async () => {
    if (!panel || panel === 'diff') return;
    cancel(); const seq = sequence.current, mode = panel, scope = props.scope;
    setBusy(true); setStatus('查询中…'); setRows([]);
    try {
      const client = await props.connect(); if (seq !== sequence.current || latest.current.scope !== scope) return;
      const id = uuid(); pending.current = { client, id };
      const result = await client.search(mode, query, id);
      if (seq !== sequence.current || latest.current.scope !== scope) return;
      setRows(result.results); setStatus(`${result.results.length} 个结果${result.truncated ? '（已达预算，缩小查询范围）' : ''}`);
    } catch (error) { if (seq === sequence.current) setStatus(`查询失败：${error instanceof Error ? error.message : error}；没有切换节点。`); }
    finally { if (seq === sequence.current) { pending.current = null; setBusy(false); } }
  };
  const compare = async () => {
    show('diff'); const seq = sequence.current, path = props.relativePath, draft = props.draft;
    if (!path) return;
    setBusy(true); setStatus('读取 Git HEAD 与磁盘…');
    try {
      const client = await props.connect(); if (seq !== sequence.current) return;
      const result = await client.gitComparison(path, uuid());
      if (seq !== sequence.current) return;
      setDiff({ baseline: result.baseline.text, disk: result.disk.text, draft }); setStatus(path + ' · 只读比较，未执行 Git 写操作');
    } catch (error) { if (seq === sequence.current) setStatus(`无法比较：${error instanceof Error ? error.message : error}`); }
    finally { if (seq === sequence.current) setBusy(false); }
  };
  return <div onKeyDown={event => { if (event.key === 'Escape' && panel) { event.preventDefault(); event.stopPropagation(); close(); } }}
    style={{ flexShrink: 0, maxHeight: '55%', overflow: 'auto', borderBottom: '1px solid var(--theme-border)' }}>
    <div role="toolbar" aria-label="工程文件命令" style={{ display: 'flex', gap: 4, padding: '5px 8px', alignItems: 'center', background: 'var(--theme-panel-solid)' }}>
      <WorkbenchButton icon="search" onClick={() => show('files')} title="快速打开 · Ctrl/⌘+P" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', color: 'var(--theme-text-muted)' }}>快速打开<span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 10, opacity: .7 }}>Ctrl P</span></WorkbenchButton>
      <WorkbenchButton icon="files" aria-label="项目搜索" title="项目搜索 · Ctrl/⌘+Shift+F" onClick={() => show('content')} style={{ border: 0, background: 'transparent' }} />
      <WorkbenchButton icon="diff" aria-label="Git 差异（只读）" title="Git 差异（只读）" disabled={!props.relativePath} onClick={() => void compare()} style={{ border: 0, background: 'transparent' }} />
      <WorkbenchPopover label="编辑导航" width={240}>{close => <>
        <WorkbenchButton className="awu-wb-menu-action" disabled={!props.editable} onClick={() => { close(); props.onEditorCommand('line'); }}>跳到行</WorkbenchButton>
        <WorkbenchButton className="awu-wb-menu-action" disabled={!props.editable} onClick={() => { close(); props.onEditorCommand('search'); }}>查找 / 替换</WorkbenchButton>
      </>}</WorkbenchPopover>
    </div>
    {panel && <section aria-label="工程文件查询" style={{ padding: 8, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <strong>{panel === 'files' ? '快速打开 · 执行端' : panel === 'content' ? '项目内容搜索 · 执行端' : '版本差异'}</strong>
        <button style={button} onClick={close}>关闭查询</button>
      </div>
      {panel !== 'diff' && <form onSubmit={event => { event.preventDefault(); void search(); }} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input ref={input} aria-label={panel === 'files' ? '文件名查询' : '项目内容查询'} value={query} maxLength={256}
          onChange={event => setQuery(event.target.value)} style={{ ...workbenchFieldStyle, minWidth: 0, flex: 1 }} />
        <button style={button} disabled={busy} type="submit">查找</button>
        {busy && <button style={button} type="button" onClick={() => { cancel(); setStatus('已取消；迟到结果不会打开文件。'); }}>取消查询</button>}
      </form>}
      <div role="status">{status}</div>
      <ul aria-label="查询结果" style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((row, index) => <li key={index}><button style={{ ...button, display: 'block', width: '100%', textAlign: 'left' }}
          onClick={() => { close(); props.onOpen(row.relativePath, row.line, row.column); }}>
          {row.relativePath}{row.line ? `:${row.line}:${row.column || 1}` : ''}{row.preview ? ` · ${row.preview}` : ''}
        </button></li>)}
      </ul>
      {diff && <div style={{ display: 'flex', gap: 6, overflow: 'auto' }}>
        {([['Git HEAD', diff.baseline], ['当前磁盘', diff.disk], ['当前草稿', diff.draft]] as const).map(([label, text]) => text !== undefined &&
          <label key={label} style={{ minWidth: 150, flex: 1 }}>{label}<textarea aria-label={label} readOnly value={text} style={{ width: '100%', height: 150 }} /></label>)}
      </div>}
    </section>}
  </div>;
};

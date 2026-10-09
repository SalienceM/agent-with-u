import React, { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { WorkspaceTerminals, TerminalOutputFilter, terminalResources, type TerminalRecord } from '../utils/workspaceTerminals';
import { handoffScope } from '../utils/workbenchHandoffState';
import { resourceHandoff } from '../utils/resourceHandoff';
import { useWindowWriteBlocked } from '../hooks/useWindowWriteBlocked';
import { WorkbenchButton, workbenchButtonStyle, workbenchFieldStyle } from './WorkbenchChrome';

interface Props { user: string; executor: string; session: string; workingDir: string; visible: boolean; focusResource?: string }
const buttonStyle = workbenchButtonStyle;

export const WorkspaceTerminal: React.FC<Props> = ({ user, executor, session, workingDir, visible, focusResource }) => {
  const scope = handoffScope(user, executor, session, workingDir);
  const [client, setClient] = useState<WorkspaceTerminals | null>(null);
  const [rows, setRows] = useState<TerminalRecord[]>([]);
  const [shells, setShells] = useState<TerminalRecord['shell'][]>([]);
  const [shell, setShell] = useState(''), [active, setActive] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState<{ text: string; resource: string; generation: string } | null>(null);
  const focusedResource = useRef('');
  useEffect(() => {
    if (!focusResource) focusedResource.current = '';
    if (focusResource && focusedResource.current !== focusResource && rows.some(r => r.resourceId === focusResource)) {
      focusedResource.current = focusResource; setActive(focusResource);
    }
  }, [focusResource, rows]);
  const blocked = useWindowWriteBlocked(executor, session);
  const control = useRef(0), generation = useRef(0), rowsRef = useRef(rows), activeRef = useRef(active);
  const clientRef = useRef(client), blockedRef = useRef(blocked), visibleRef = useRef(visible);
  rowsRef.current = rows; activeRef.current = active; clientRef.current = client; blockedRef.current = blocked; visibleRef.current = visible;
  const node = useRef<HTMLDivElement>(null), terminal = useRef<Xterm | null>(null), fit = useRef<FitAddon | null>(null);
  const stream = useRef({ resource: '', generation: '', position: 0, filter: new TerminalOutputFilter(), reading: false, wanted: false });
  const inputQueue = useRef(Promise.resolve()), inputSize = useRef(0), inputUnknown = useRef(new Set<string>());
  const remember = (records: TerminalRecord[]) => {
    records = records.map(row => {
      const old = rowsRef.current.find(previous => previous.resourceId === row.resourceId && previous.generation === row.generation);
      return old && old.revision > row.revision ? old : row;
    });
    rowsRef.current = records; setRows(records); terminalResources.set(scope, records);
    if (!activeRef.current && records.length) { activeRef.current = records[0].resourceId; setActive(records[0].resourceId); }
  };
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const drainRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    const service = clientRef.current, epoch = generation.current; if (!service) return;
    const listing = await service.list(); if (epoch !== generation.current) return;
    control.current = listing.controlRevision; setShells(listing.shells); setShell(value => value || listing.shells[0]?.id || '');
    remember(listing.terminals); await drainRef.current();
  };
  drainRef.current = async () => {
    const state = stream.current;
    if (state.reading) { state.wanted = true; return; }
    if (!visibleRef.current || !terminal.current) return;
    const service = clientRef.current, record = rowsRef.current.find(row => row.resourceId === activeRef.current);
    if (!service || !record) return;
    const epoch = generation.current;
    state.reading = true;
    try {
      if (state.resource !== record.resourceId || state.generation !== record.generation) {
        terminal.current.reset(); state.position = 0; state.filter.reset(); state.resource = record.resourceId; state.generation = record.generation;
      }
      // 一批最多读 2 MiB；xterm 消费一个帧后再请求下一个，不堆积渲染队列。
      for (let page = 0; page < 16; page++) {
        state.wanted = false;
        const result = await service.read(record, state.position);
        if (epoch !== generation.current || activeRef.current !== record.resourceId) return;
        const xterm = terminal.current; if (!xterm) return;
        if (result.gap) { state.filter.reset(); xterm.write('\r\n[部分终端历史已丢失，仅显示可用尾部]\r\n'); }
        for (const chunk of result.chunks) {
          await new Promise<void>(resolve => xterm.write(state.filter.feed(chunk.text), resolve));
          if (epoch !== generation.current || activeRef.current !== record.resourceId) return;
          state.position = chunk.sequence;
        }
        const updated = { ...result, status: result.terminalStatus } as TerminalRecord;
        remember(rowsRef.current.map(row => row.resourceId === record.resourceId ? updated : row));
        if (state.position >= result.lastSequence) break;
      }
    } catch (reason) { if (epoch === generation.current) setError(String(reason)); }
    finally { state.reading = false; if (state.wanted && epoch === generation.current && visibleRef.current) setTimeout(() => void drainRef.current(), 0); }
  };
  const sendRef = useRef<(text: string) => void>(() => {});
  sendRef.current = (text: string) => {
    const record = rowsRef.current.find(row => row.resourceId === activeRef.current), service = clientRef.current, epoch = generation.current;
    if (!record || !service || blockedRef.current || inputUnknown.current.has(record.resourceId) || record.status !== 'running') return;
    if (inputSize.current + text.length > 65536) { setError('输入队列已满，未发送新增输入。'); return; }
    inputSize.current += text.length;
    inputQueue.current = inputQueue.current.then(async () => {
      if (epoch !== generation.current || blockedRef.current || inputUnknown.current.has(record.resourceId)) return;
      const latest = rowsRef.current.find(row => row.resourceId === record.resourceId && row.generation === record.generation);
      if (!latest || latest.status !== 'running') return;
      try {
        const result = await service.input(latest, text, latest.inputSequence + 1);
        if (epoch === generation.current) remember(rowsRef.current.map(row => row.resourceId === result.resourceId ? result : row));
      } catch (reason) { inputUnknown.current.add(record.resourceId); if (epoch === generation.current) setError(`${reason}；后续输入已暂停，不自动重放。`); }
    }).finally(() => { inputSize.current -= text.length; });
  };
  useEffect(() => {
    const epoch = ++generation.current;
    setClient(null); clientRef.current = null; setRows([]); setError(''); inputUnknown.current.clear();
    void api.workspaceTerminals(session, executor, workingDir, () => generation.current === epoch).then(service => {
      if (generation.current !== epoch) return;
      clientRef.current = service; setClient(service);
      return refreshRef.current();
    }).catch(reason => { if (generation.current === epoch) setError(String(reason)); });
    const off = api.onTerminalUpdated((data, from) => {
      if (from !== executor || data.sessionId !== session || generation.current !== epoch || !clientRef.current) return;
      try {
        const record = clientRef.current.record(data);
        remember([...rowsRef.current.filter(row => row.resourceId !== record.resourceId), record]);
        void drainRef.current();
      } catch { /* 不采用其他实例的迟到推送 */ }
    });
    const offConnection = api.onSessionConnectionStatus(session, connected => {
      if (connected) void refreshRef.current().catch(reason => setError(String(reason)));
      else { rowsRef.current.forEach(row => inputUnknown.current.add(row.resourceId)); setError('节点连接中断；输入已暂停，重连只恢复输出，不重放命令。'); }
    });
    return () => { generation.current++; off(); offConnection(); };
  }, [scope]);
  useEffect(() => resourceHandoff.register(scope, 'terminals', {
    export: async () => {
      if (inputSize.current) throw new Error('终端仍有待确认输入，请先核对再移动窗口');
      if (clientRef.current) await refreshRef.current();
      return { terminals: rowsRef.current.map(row => ({ resourceId: row.resourceId, generation: row.generation })), active: activeRef.current };
    },
    import: async (value: any) => {
      if (!value || !Array.isArray(value.terminals) || value.terminals.length > 64 || typeof value.active !== 'string') throw new Error('终端交接引用无效');
      if (!value.terminals.length) return;
      if (!clientRef.current) {
        const epoch = generation.current;
        clientRef.current = await api.workspaceTerminals(session, executor, workingDir, () => epoch === generation.current);
        setClient(clientRef.current);
      }
      const checked = await clientRef.current.list();
      if (value.terminals.some((ref: any) => !checked.terminals.some(row => row.resourceId === ref.resourceId && row.generation === ref.generation))) throw new Error('原终端实例不可恢复，未新建替代进程；请保留源工作台');
      remember(checked.terminals); setActive(value.active); activeRef.current = value.active;
    },
  }), [scope]);
  useEffect(() => {
    if (!node.current || !visible) return;
    if (!terminal.current) {
      const xterm = new Xterm({ scrollback: 3000, fontSize: 12, convertEol: false, allowProposedApi: false,
        theme: { background: '#14141c', foreground: '#d4d4d4' }, linkHandler: { activate: () => {} } });
      const addon = new FitAddon(); xterm.loadAddon(addon); xterm.open(node.current);
      // 不让输出查询通过 onData 回送为用户输入。
      for (const prefix of ['', '?', '>']) for (const final of ['n', 'c', 't']) xterm.parser.registerCsiHandler({ prefix, final }, () => true);
      xterm.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true);
      xterm.onData(text => sendRef.current(text)); terminal.current = xterm; fit.current = addon;
    }
    const resize = () => {
      if (!visibleRef.current) return;
      fit.current?.fit(); const xterm = terminal.current;
      const record = rowsRef.current.find(row => row.resourceId === activeRef.current);
      if (record?.status === 'running' && clientRef.current && xterm && !blockedRef.current
        && (record.cols !== xterm.cols || record.rows !== xterm.rows)) {
        void clientRef.current.resize(record, Math.min(500, Math.max(2, xterm.cols)), Math.min(500, Math.max(2, xterm.rows)))
          .then(updated => remember(rowsRef.current.map(row => row.resourceId === updated.resourceId ? updated : row)))
          .catch(reason => setError(String(reason)));
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(resize, 120); });
    observer.observe(node.current); resize(); void drainRef.current();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [visible, active, client]);
  useEffect(() => () => { terminal.current?.dispose(); terminal.current = null; }, []);
  const run = async (action: () => Promise<void>) => { if (busy || blocked) return; setBusy(true); setError(''); try { await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const selected = rows.find(row => row.resourceId === active);
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--theme-panel-solid, var(--theme-bg))' }}>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', padding: 5 }}>
      <strong>执行端终端</strong>
      <select style={workbenchFieldStyle} aria-label="终端 Shell" value={shell} onChange={event => setShell(event.target.value)}>{shells.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}</select>
      <button style={buttonStyle} disabled={!client || !shell || busy || blocked} onClick={() => void run(async () => {
        if (!window.confirm(`在 ${executor} 创建 ${shell}？\n用户：${user}\n目录：${workingDir}\n使用执行端当前账户真实权限，不是模型沙箱；不加载 Shell profile。`)) return;
        const created = await client!.create(shell, control.current); remember([...rowsRef.current.filter(row => row.resourceId !== created.resourceId), created]);
        inputUnknown.current.delete(created.resourceId); setActive(created.resourceId); activeRef.current = created.resourceId;
      })}>创建终端</button>
      <button style={buttonStyle} disabled={!client || busy} onClick={() => void run(async () => { await refreshRef.current();
        if (rowsRef.current.find(row => row.resourceId === activeRef.current)?.status === 'running') { inputUnknown.current.delete(activeRef.current); setError('已核对原实例，之前未确认的输入不会重发。'); } })}>核对 / 恢复输出</button>
      {rows.map(row => <button key={row.resourceId} style={buttonStyle} aria-pressed={active === row.resourceId} onClick={() => { setActive(row.resourceId); activeRef.current = row.resourceId; }}>
        {row.shell.id} · {row.resourceId.slice(0, 6)} · {row.status}</button>)}
      {selected && !selected.exitConfirmed && <button style={buttonStyle} disabled={busy || blocked} onClick={() => void run(async () => {
        const stopped = await client!.stop(selected); remember(rowsRef.current.map(row => row.resourceId === stopped.resourceId ? stopped : row));
        if (!stopped.exitConfirmed) setError('退出尚未确认，活动保护仍保留。');
      })}>停止所属进程树</button>}
      {selected?.exitConfirmed && <button style={buttonStyle} onClick={() => { remember(rows.filter(row => row.resourceId !== selected.resourceId)); setActive(''); activeRef.current = ''; }}>关闭已结束标签</button>}
    </div>
    <div style={{ fontSize: 11, padding: '0 6px', overflowWrap: 'anywhere' }}>{user} · {executor} · {workingDir} · {selected?.shell.executable || '尚未创建'}；隐藏视图不停止进程。</div>
    {error && <div role="status" style={{ color: '#fbbf24', padding: 5 }}>{error}</div>}
    {paste && <div role="dialog" aria-label="检查终端多行粘贴" style={{ padding: 8 }}>
      <div>发送到 {executor} / {paste.resource.slice(0, 8)}，换行可能立即执行：</div>
      <pre style={{ maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{paste.text}</pre>
      <WorkbenchButton onClick={() => { if (activeRef.current === paste.resource && rowsRef.current.some(row => row.resourceId === paste.resource && row.generation === paste.generation)) sendRef.current(paste.text); setPaste(null); }}>确认发送</WorkbenchButton>
      <WorkbenchButton onClick={() => setPaste(null)}>取消粘贴</WorkbenchButton>
    </div>}
    <div ref={node} aria-label="终端交互内容" onPasteCapture={event => {
      event.preventDefault(); event.stopPropagation();
      const text = event.clipboardData.getData('text/plain');
      if (text.length > 65536) { setError('粘贴超过 64 Ki 字符，未发送。'); return; }
      if (!selected || blocked) return;
      if (/[\r\n]/.test(text)) setPaste({ text, resource: selected.resourceId, generation: selected.generation });
      else sendRef.current(text);
    }} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 4 }} />
  </div>;
};

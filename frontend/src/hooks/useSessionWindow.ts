import { useEffect, useRef, useState } from 'react';
import { api, getCurrentUserProfile } from '../api';
import { SessionWindowHandoff, type HandoffProgress } from '../utils/sessionWindowHandoff';
import { windowTransport, type WindowOwnershipClient } from '../utils/workbenchWindows';
import { handoffParticipants, handoffJournal, handoffScope, type HandoffState } from '../utils/workbenchHandoffState';
import { documentKey, documentStore } from '../utils/documentStore';
import { openDetachedWindow, focusDetachedWindow, isDesktopWindow } from '../utils/detachedWindow';
import { readSessionWindowRoute, sessionWindowUrl } from '../utils/sessionWindowRoute';
import { uuid } from '../utils/uuid';
import { consumeSessionDrag, type SessionDrag } from '../utils/sessionWindowDrag';

type Wake = { kind: 'hello' | 'ready' | 'offer' | 'ack' | 'changed' | 'focus' | 'attach'; from: string; to: string; requestId?: string };
interface Runtime { client: WindowOwnershipClient; controller: SessionWindowHandoff; send: (msg: Omit<Wake, 'from'>) => void;
  wait: (kind: Wake['kind'], from: string, request?: string) => Promise<void>; dispose: () => void }

/** 通道只传标识和唤醒；可写性来自服务器回执，正文来自有界恢复 journal。 */
export function useSessionWindow(user: string, executor: string, session: string, workingDir: string, ready: boolean) {
  const scope = handoffScope(user, executor, session, workingDir), scopeRef = useRef(scope); scopeRef.current = scope;
  const [progress, setProgress] = useState<HandoffProgress>({ phase: 'idle', message: '' });
  const [available, setAvailable] = useState(false), [renderView, setRenderView] = useState(true);
  const [checkpoint, setCheckpoint] = useState<string>();
  const [, repaint] = useState(0), runtime = useRef<Runtime>();
  const closing = useRef(false), closeAction = useRef<() => void>(() => {});
  const moveAction = useRef<() => void>(() => {});
  const route = readSessionWindowRoute(window.location.search);
  useEffect(() => {
    if (!route) return;
    let active = true, unlisten: (() => void) | undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (closing.current) return;
      const row = windowTransport.get(executor, session);
      if (!row || row.unknown || row.state.frozen || row.state.windowId === windowTransport.identity?.windowId) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    if (isDesktopWindow()) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onCloseRequested(event => {
        if (!closing.current) { event.preventDefault(); closeAction.current(); }
      });
      if (active) unlisten = off; else off();
    });
    return () => { active = false; unlisten?.(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [scope]);
  useEffect(() => windowTransport.subscribe(() => repaint(n => n + 1)), []);
  useEffect(() => {
    if (!ready) return;
    let alive = true, cleanup: (() => void) | undefined;
    const current = () => alive && scopeRef.current === scope && getCurrentUserProfile().userId === user;
    setAvailable(false);
    void (async () => {
      const client = await api.workbenchWindows(session, executor, workingDir, current);
      const state = await client.register(); if (!current()) return;
      if (typeof BroadcastChannel === 'undefined') throw new Error('当前环境不支持安全的窗口唤醒通道');
      const identity = client.transport.identity!;
      const channel = new BroadcastChannel(`awu-session-window-v1:${JSON.stringify([user, client.workspace.workspaceRevision, identity.clientId])}`);
      const listeners = new Set<(message: Wake) => void>();
      const cancellations = new Set<() => void>();
      const send = (msg: Omit<Wake, 'from'>) => { if (current()) channel.postMessage({ ...msg, from: identity.windowId }); };
      const wait = (kind: Wake['kind'], from: string, requestId?: string) => new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); listeners.delete(listener); cancellations.delete(cancel); error ? reject(error) : resolve(); };
        const cancel = () => finish(new Error('窗口身份已变化'));
        const listener = (msg: Wake) => { if (msg.kind === kind && msg.from === from && (!requestId || msg.requestId === requestId)) finish(); };
        const timer = setTimeout(() => finish(new Error('目标窗口未在时限内确认；请保留原窗口并核对原操作')), 15000);
        listeners.add(listener); cancellations.add(cancel);
      });
      let captured: HandoffState['parts'] = {};
      const release = () => {
        if (!current()) return;
        // 权威提交后卸下源视图。只清理已经进入可靠交接包的同版内存缓冲区。
        setRenderView(false);
        for (const part of [captured.filesEngine, captured.filesChat] as any[]) for (const draft of part?.documents || []) {
          const key = documentKey(draft.identity), doc = documentStore.get(key);
          if (doc && doc.text === draft.text && doc.revision === draft.revision) documentStore.close(key, true);
        }
      };
      const controller = new SessionWindowHandoff(client, {
        capture: async () => {
          captured = await handoffParticipants.capture(scope);
          captured.stream = api.captureWorkbenchStream(session, executor);
          return captured;
        },
        restore: async (parts, stillCurrent) => {
          setRenderView(true);
          const { stream, ...components } = parts;
          await handoffParticipants.restore(scope, components, stillCurrent);
          if (!stream) throw new Error('交接缺少流恢复位置');
          await api.restoreWorkbenchStream(client, stream as any, stillCurrent);
          await api.reloadWorkbenchPermission(session, executor, stillCurrent);
        },
        persist: (envelope, status) => handoffJournal.put(envelope, status),
        read: request => handoffJournal.get(client.workspace, identity.clientId, request),
        offer: async plan => { const ack = wait('ack', plan.targetWindow, plan.requestId); send({ kind: 'offer', to: plan.targetWindow, requestId: plan.requestId }); await ack; },
        release,
      }, value => { if (current()) setProgress(value); }, current);
      channel.onmessage = event => {
        const msg = event.data as Wake;
        if (!current() || !msg || msg.to !== identity.windowId || typeof msg.from !== 'string' || msg.from === identity.windowId
          || !['hello', 'ready', 'offer', 'ack', 'changed', 'focus', 'attach'].includes(msg.kind)) return;
        listeners.forEach(listener => listener(msg));
        if (msg.kind === 'hello') send({ kind: 'ready', to: msg.from });
        if (msg.kind === 'focus') window.focus();
        if (msg.kind === 'attach' && route?.homeWindow === msg.from && msg.requestId && consumeSessionDrag(session, msg.requestId)) moveAction.current();
        if (msg.kind === 'offer' && typeof msg.requestId === 'string') {
          void controller.receive(msg.requestId).then(() => send({ kind: 'ack', to: msg.from, requestId: msg.requestId }))
            .catch(error => { if (current()) setProgress({ phase: 'unknown', message: String(error), requestId: msg.requestId }); });
        }
        if (msg.kind === 'changed') void controller.reconcile().catch(error => { if (current()) setProgress({ phase: 'unknown', message: String(error) }); });
      };
      const selected = (event: Event) => {
        if ((event as CustomEvent).detail?.session !== session || !current()) return;
        const owner = client.transport.get(executor, session)?.state.windowId;
        if (owner && owner !== identity.windowId) { void focusDetachedWindow(`session-${owner}`); send({ kind: 'focus', to: owner }); }
      };
      window.addEventListener('awu-session-selected', selected);
      const command = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (!current() || detail?.session !== session || !isDesktopWindow()) return;
        if (detail.action === 'drop') {
          const drag = detail.drag as SessionDrag;
          if (drag.client === identity.clientId && drag.executor === executor && drag.window !== identity.windowId)
            send({ kind: 'attach', to: drag.window, requestId: drag.nonce });
        } else if (detail.action === (route ? 'attach' : 'detach')) moveAction.current();
      };
      window.addEventListener('awu-session-window-command', command);
      const rt: Runtime = { client, controller, send, wait, dispose: () => { controller.dispose(); cancellations.forEach(cancel => cancel()); channel.close(); window.removeEventListener('awu-session-selected', selected); window.removeEventListener('awu-session-window-command', command); } };
      runtime.current = rt; cleanup = () => { rt.dispose(); if (runtime.current === rt) runtime.current = undefined; };
      setAvailable(true);
      setRenderView(state.windowId === identity.windowId || !!route);
      setProgress({ phase: state.frozen ? 'unknown' : state.windowId === identity.windowId ? 'idle' : 'moved',
        message: state.frozen ? '发现未完成交接；请只读核对原操作。' : state.windowId === identity.windowId ? '' : '工作台属于其他窗口；当前视图不可发送或保存。', requestId: state.pending?.requestId });
      if (route) send({ kind: 'ready', to: route.homeWindow });
      if (state.windowId === identity.windowId && !state.frozen) {
        const records = await handoffJournal.list(user); if (!current()) return;
        for (const record of records.filter(row => row.client === identity.clientId).sort((a, b) => b.updatedAt - a.updatedAt)) {
          let envelope: HandoffState;
          try { envelope = JSON.parse(record.payload); } catch { continue; }
          if (envelope.workspace?.workspaceRevision !== client.workspace.workspaceRevision) continue;
          const checked = await client.get(record.requestId); if (!current()) return;
          if (checked.receipt?.ownerWindow === identity.windowId && checked.receipt.committedGeneration === state.generation
            && checked.state.generation === state.generation && ['committed', 'cancelled'].includes(checked.receipt.status)) {
            client.transport.hold(executor, session, true); setCheckpoint(record.requestId);
            setProgress({ phase: 'unknown', message: '找到此窗口最后可靠交接包。请恢复或导出核对；尚未恢复的输入不会自动发送。', requestId: record.requestId });
            break;
          }
        }
      }
    })().catch(error => { if (current()) setProgress({ phase: 'idle', message: error instanceof Error ? error.message : String(error) }); });
    return () => { alive = false; cleanup?.(); };
  }, [scope, ready]);
  const row = windowTransport.get(executor, session), ours = row?.state.windowId === windowTransport.identity?.windowId;
  const frozen = !!route && !available || !!row && (windowTransport.held(executor, session) || row.unknown || row.state.frozen || !ours)
    || ['waiting', 'committing', 'unknown'].includes(progress.phase);
  const move = (closeAfter = false) => {
    const rt = runtime.current;
    const close = async () => {
      closing.current = true;
      if (isDesktopWindow()) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('close_session_window'); }
      else window.close();
    };
    if (closeAfter && rt && row && !ours && !row.state.frozen && !row.unknown) { void close(); return; }
    if (!rt || frozen || progress.phase === 'preparing') {
      if (closeAfter) setProgress(previous => ({ ...previous, settled: false, message: '窗口尚未就绪或归属待核对；未关闭。请核对、取消原交接，或导出可靠恢复包。' }));
      return;
    }
    const identity = rt.client.transport.identity!;
    const target = route?.homeWindow || uuid();
    const targetReady = rt.wait('ready', target);
    // Web 创建必须在用户点击栈内，不能 await capability/动态 import 后才 window.open。
    const opened = route ? Promise.resolve().then(() => rt.send({ kind: 'hello', to: target })) : openDetachedWindow({
      label: `session-${target}`, title: 'AgentWithU · Session', width: 1400, height: 900, minWidth: 640, minHeight: 400, dragDropEnabled: false,
      url: sessionWindowUrl(window.location.pathname, { session, executor, windowId: target, homeWindow: identity.windowId }),
    });
    // 即便窗口被拦截也消耗 wait 的 rejection，避免悬空 Promise；不提交 prepare。
    void targetReady.catch(() => {});
    void rt.controller.move(target, opened.then(() => targetReady)).then(async () => {
      rt.send({ kind: 'changed', to: target }); if (closeAfter) await close();
    })
      .catch(() => {});
  };
  closeAction.current = () => move(true);
  moveAction.current = () => move(false);
  const reconcile = () => { const rt = runtime.current; if (rt) void rt.controller.reconcile().catch(error => setProgress({ phase: 'unknown', message: String(error) })); };
  const cancel = () => { const rt = runtime.current; if (rt) void rt.controller.cancel().then(() => setRenderView(true)).catch(error => setProgress({ phase: 'unknown', message: String(error) })); };
  const resume = () => { const rt = runtime.current; if (!rt) return;
    const pending = windowTransport.get(executor, session)?.state.pending;
    void rt.controller.resume().then(() => { if (pending) rt.send({ kind: 'changed', to: pending.targetWindow }); })
      .catch(error => setProgress({ phase: 'unknown', message: String(error) })); };
  const focus = () => { const rt = runtime.current; if (!rt || !row) return;
    void focusDetachedWindow(`session-${row.state.windowId}`); rt.send({ kind: 'focus', to: row.state.windowId }); };
  const restore = () => { const rt = runtime.current; if (!rt || !checkpoint) return;
    void rt.controller.restoreCheckpoint(checkpoint).then(() => { windowTransport.hold(executor, session, false); setCheckpoint(undefined); }).catch(() => {}); };
  const skipRestore = () => {
    const rt = runtime.current;
    if (!rt || !window.confirm('不自动恢复此交接包，继续使用当前已呈现内容？恢复包仍可导出。此操作不会自动保存或丢弃磁盘文件；可能缺失的流输出须另行核对。')) return;
    void rt.controller.reconcile().then(() => { windowTransport.hold(executor, session, false); setCheckpoint(undefined); })
      .catch(error => setProgress({ phase: 'unknown', message: String(error) }));
  };
  const reclaim = () => {
    const rt = runtime.current; if (!rt || !window.confirm('显式收回此会话的视图归属？旧窗口的新发送、保存和终端输入会被拒绝；后台任务不停止。旧窗口未交接的新草稿无法自动恢复，请先核对或导出恢复包。')) return;
    void rt.client.reclaim().then(() => { setRenderView(true); setProgress({ phase: 'idle', settled: true, message: '已收回视图归属；没有停止旧进程，也没有重放命令。可从恢复包或文件草稿恢复内容。' }); })
      .catch(error => setProgress({ phase: 'unknown', message: String(error) }));
  };
  return { available, frozen: frozen || !!checkpoint, renderView, progress, move: () => move(false), safeClose: () => move(true), reconcile, cancel, resume, focus, restore, skipRestore, checkpoint, reclaim, detached: !!route };
}

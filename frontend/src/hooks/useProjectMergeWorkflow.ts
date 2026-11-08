import { useContext, useEffect, useRef, useState } from 'react';
import { AppModalVisibilityContext } from '../components/AppModalPortal';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import type { MergeSummary, ProjectMerge } from '../types/taskWorkspaces';
import { uuid } from '../utils/uuid';

type Action = 'Prepare' | 'Verify' | 'Apply' | 'Cancel' | 'Start';
interface Intent { request: string; action: Action | 'Preview'; operation: string; fingerprint: string; candidate?: string }
interface Draft { selected: string; source: string; target: string; query: string; intents: Record<string, Intent> }
const pending = new Map<string, Promise<unknown>>();
const settled = new Set<(identity: string) => void>();
const reads = new Map<string, Promise<ProjectMerge>>();
const listings = new Map<string, Promise<{ items: MergeSummary[]; nextOffset: number | null }>>();
const autoChecked = new Map<string, string>();
const terminal = new Set(['succeeded', 'cancelled', 'error']);
const storageKey = (key: string) => `awu.merge.v1:${key}`;
function restore(key: string, source: string, target: string, operation: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(key)) || 'null');
    if (saved && typeof saved.selected === 'string' && typeof saved.source === 'string' && typeof saved.target === 'string'
      && typeof saved.query === 'string' && saved.intents && typeof saved.intents === 'object') return { ...saved, selected: operation || saved.selected };
  } catch { /* 恢复失败只显示新建入口，不提交任何操作。 */ }
  return { selected: operation, source, target, query: '', intents: {} };
}

/** 草稿不保存授权；所有副作用仍绑定原 origin，断线只查原 requestId。 */
export function useProjectMergeWorkflow(session: string, executor: string, fixedTarget = '', initialOperation = '') {
  const visible = useContext(AppModalVisibilityContext), visibility = useRef(visible); visibility.current = visible;
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  useEffect(() => onCurrentUserChanged(() => setOwner(getCurrentUserProfile().userId)), []);
  const identity = JSON.stringify([owner, executor, session]);
  const [draft, setDraft] = useState(() => restore(identity, fixedTarget ? session : '', fixedTarget, initialOperation));
  const [row, setRow] = useState<ProjectMerge>(), [history, setHistory] = useState<MergeSummary[]>([]);
  const [next, setNext] = useState<number | null>(null), [supported, setSupported] = useState<boolean>();
  const [branchSync, setBranchSync] = useState(false);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [online, setOnline] = useState(true);
  const [nonce, setNonce] = useState(0), [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Array<{ id: string; title: string; workingDir: string }>>([]);
  const current = useRef(identity), state = useRef({ draft, row, supported, online }), mounted = useRef(false);
  const inspected = useRef(false);
  const readTurn = useRef<{ key: string; again: boolean }>();
  current.current = identity; state.current = { draft, row, supported, online };
  const valid = () => mounted.current && current.current === identity && getCurrentUserProfile().userId === owner;
  const save = (update: (old: Draft) => Draft) => {
    if (!valid()) return;
    const value = update(state.current.draft); state.current.draft = value; setDraft(value);
    try { sessionStorage.setItem(storageKey(identity), JSON.stringify(value)); } catch { /* 内存继续保留，不重发。 */ }
  };
  useEffect(() => {
    mounted.current = true;
    const saved = restore(identity, fixedTarget ? session : '', fixedTarget, initialOperation);
    state.current.draft = saved; setDraft(saved); setRow(undefined); setHistory([]); setSupported(undefined); setBranchSync(false); setNotice('');
    return () => { mounted.current = false; };
  }, [identity, initialOperation]);
  const install = (value: ProjectMerge, fresh = false) => {
    if (!valid() || state.current.draft.selected !== value.id) return;
    setRow(old => {
      if (old?.id === value.id && old.revision > value.revision) return old;
      inspected.current = fresh; return value;
    });
  };
  const inspect = async (id = state.current.draft.selected) => {
    if (!id || !valid()) return;
    inspected.current = false;
    const key = `${identity}:${id}`;
    let promise = reads.get(key);
    if (!promise) {
      promise = (async () => {
        const capability = state.current.supported;
        // Status 的退出恢复只允许原 origin；相关入口仅用 Inspect，不冒用来源身份。
        const origin = state.current.row?.id === id ? state.current.row.sourceSessionId : history.find(item => item.id === id)?.originSessionId;
        if (!capability || origin === session || state.current.draft.intents[id]) {
          const status = await api.projectMergeStatus(session, executor, id);
          if (!capability) return status;
        }
        if (getCurrentUserProfile().userId !== owner) throw new Error('身份已变化');
        return api.projectMergeInspect(session, executor, id);
      })();
      reads.set(key, promise); void promise.finally(() => { if (reads.get(key) === promise) reads.delete(key); }).catch(() => {});
    }
    const value = await promise; install(value, true);
    const intent = state.current.draft.intents[id];
    if (intent && valid()) {
      try {
        const receipt = await api.collaborationRequestStatus(session, executor, intent.request);
        if (['succeeded', 'failed', 'cancelled'].includes(receipt.status)) save(old => { const intents = { ...old.intents }; delete intents[id]; return { ...old, intents }; });
      } catch { /* 不存在/断线不证明请求未执行，保留未知意图。 */ }
    }
    return value;
  };
  const list = async (offset = 0, capability = state.current.supported, restoreSelection = false) => {
    const key = JSON.stringify([identity, fixedTarget, offset, capability]);
    let request = listings.get(key);
    if (!request) {
      request = capability ? api.projectMergeOperations(session, executor, '', '', offset).then(result => ({ ...result,
        items: fixedTarget ? result.items.filter(item =>
          item.sourceSessionId === session && item.targetSessionId === fixedTarget || item.sourceSessionId === fixedTarget && item.targetSessionId === session) : result.items }))
        : api.collaborationList(session, executor, 'merge', offset).then(value => ({ ...value, items: value.items.map(item => ({ ...item, status: item.status || 'unknown', originSessionId: session })) }));
      listings.set(key, request); void request.finally(() => { if (listings.get(key) === request) listings.delete(key); }).catch(() => {});
    }
    const result = await request;
    if (!valid()) return;
    setHistory(old => offset ? [...old, ...result.items.filter(item => !old.some(saved => saved.id === item.id))] : result.items);
    setNext(result.nextOffset);
    if (restoreSelection && !offset && !state.current.draft.selected && result.nextOffset === null) {
      const active = result.items.filter(item => !terminal.has(item.status));
      const unique = active.length === 1 ? active[0] : result.items.length === 1 ? result.items[0] : undefined;
      if (unique) save(old => ({ ...old, selected: unique.id }));
    }
  };
  useEffect(() => {
    let live = true; setLoading(true);
    api.projectMergeCapabilities(session, executor).then(async caps => {
      if (!live || !valid()) return;
      const enabled = caps.mergeWorkflow === 1; state.current.supported = enabled; setSupported(enabled);
      setBranchSync(caps.branchSync === 1);
      if (!enabled) setNotice('此节点只支持原发起 Session 历史；关联详情与自动核对不可用。已有操作保留。');
      await list(0, enabled, true);
    }).catch(error => { if (live && valid()) setNotice(`读取失败，未创建新操作：${String(error)}`); })
      .finally(() => { if (live && valid()) setLoading(false); });
    return () => { live = false; };
  }, [identity]);
  useEffect(() => {
    if (supported === undefined || !draft.selected || !online || !visible || document.visibilityState === 'hidden') return;
    const key = `${identity}:${draft.selected}`;
    if (readTurn.current?.key === key) { readTurn.current.again = true; return; }
    const turn = { key, again: false }; readTurn.current = turn;
    void inspect().catch(error => { if (valid()) setNotice(`核对失败；未重试写入。${String(error)}`); }).finally(() => {
      if (readTurn.current !== turn) return;
      readTurn.current = undefined;
      if (turn.again && valid()) setNonce(n => n + 1);
    });
  }, [identity, draft.selected, supported, nonce, online, visible]);
  useEffect(() => {
    const seen = new Map<string, number>();
    const refresh = () => { if (visibility.current && document.visibilityState !== 'hidden' && valid()) setNonce(n => n + 1); };
    const finished = (key: string) => { if (key === identity && valid()) { setBusy(false); refresh(); } };
    settled.add(finished);
    const offMerge = api.onProjectMergeUpdated((value, node) => {
      if (node !== executor || !valid()) return;
      if ((seen.get(value.id) || 0) >= value.revision) return;
      seen.set(value.id, value.revision);
      if (seen.size > 100) seen.delete(seen.keys().next().value!);
      if (value.id === state.current.draft.selected) refresh();
      if ([value.sourceSessionId, value.actualSourceSessionId, value.targetSessionId, value.integrationSessionId].includes(session)) void list().catch(() => {});
    });
    const offStream = api.onStreamDelta(delta => {
      if (delta.executor === executor && delta.sessionId === state.current.row?.integration?.sessionId && delta.type === 'done') refresh();
    });
    const offActivity = api.onSessionUpdated(value => {
      if (value.execKey === executor && value.type === 'merge_activity' && value.sessionId === state.current.row?.integration?.sessionId) refresh();
    });
    const offConnection = api.onExecutorConnectionStatus(executor, connected => {
      if (!valid()) return; setOnline(connected);
      if (!connected) setNotice('执行节点离线；保留原操作和请求，重连只查询。');
    });
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh);
    return () => { settled.delete(finished); offMerge(); offStream(); offActivity(); offConnection(); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [identity]);
  const run = async (work: () => Promise<void>) => {
    if (pending.has(identity) || !valid() || !state.current.online) return;
    setBusy(true); setNotice('');
    const promise = work(); pending.set(identity, promise);
    try { await promise; } catch (error) { if (valid()) setNotice(String(error)); }
    finally { pending.delete(identity); settled.forEach(callback => callback(identity)); }
  };
  const action = (name: Action) => run(async () => {
    const value = state.current.row;
    if (!value || value.sourceSessionId !== session || state.current.draft.intents[value.id]) return;
    const intent: Intent = { request: uuid(), operation: value.id, action: name, fingerprint: value.planFingerprint, candidate: value.candidate };
    if (name !== 'Verify') save(old => ({ ...old, intents: { ...old.intents, [value.id]: intent } }));
    try {
      const result = await api.projectMergeAction(session, executor, name, value, intent.request);
      install(result);
      if (name !== 'Verify') save(old => { const intents = { ...old.intents }; delete intents[value.id]; return { ...old, intents }; });
      await list();
    } catch (error) { if (valid()) setNotice(`接收结果待核对；没有重发。${String(error)}`); }
  });
  useEffect(() => {
    if (!row || !['candidate', 'conflict'].includes(row.status) || !row.integration?.sessionId || !inspected.current || busy || !online || !supported || row.sourceSessionId !== session || draft.intents[row.id]
      || !visible || document.visibilityState === 'hidden' || !row.workflow?.canAutoVerify || row.workflow.gitVerified) return;
    const integration = row.workflow.sides.integration;
    const key = `${identity}:${row.id}`, candidate = `${integration?.head}:${integration?.fingerprint || ''}`;
    if (!integration?.head || autoChecked.get(key) === candidate) return;
    autoChecked.set(key, candidate); if (autoChecked.size > 100) autoChecked.delete(autoChecked.keys().next().value!);
    void action('Verify');
  }, [row, busy, online, supported, identity, visible]);
  return { row: row?.id === draft.selected ? row : undefined, history, next, loading, supported, branchSync, notice, busy: busy || pending.has(identity), online,
    draft, items, uncertain: !!draft.intents[draft.selected],
    change: (patch: Partial<Draft>) => save(old => ({ ...old, ...patch })),
    select: (id: string) => { save(old => ({ ...old, selected: id })); setRow(undefined); setNotice(''); },
    refresh: () => { setNonce(n => n + 1); if (supported === undefined) void run(async () => {
      const caps = await api.projectMergeCapabilities(session, executor); if (!valid()) return;
      setBranchSync(caps.branchSync === 1);
      state.current.supported = caps.mergeWorkflow === 1; setSupported(state.current.supported); await list();
    }); },
    more: () => next !== null && void run(() => list(next)), action,
    discover: () => run(async () => { const result = await api.projectMergeDiscover(session, executor, state.current.draft.query); if (valid()) { setItems(result.items); if (result.truncated) setNotice('候选较多，请输入名称缩小范围。'); } }),
    preview: (selection?: { source: string; target: string }) => run(async () => {
      const draft = state.current.draft, row = state.current.row;
      // 重新预览必须是明确点击；未知回执和其他发起者的记录不能借此绕过。
      if (draft.intents[draft.selected] || selection && row && (row.sourceSessionId !== session || ['preparing', 'applying', 'unknown'].includes(row.status))) return;
      const request = uuid(), value = selection || draft;
      if (!value.source || !value.target || value.source === value.target) return;
      save(old => ({ ...old, source: value.source, target: value.target, selected: request, intents: { ...old.intents, [request]: { request, operation: request, action: 'Preview', fingerprint: JSON.stringify([value.source, value.target]) } } }));
      const result = await api.projectMergePreview(session, executor, value.source, value.target, request);
      save(old => { const intents = { ...old.intents }; delete intents[request]; return { ...old, selected: result.id, intents }; }); install(result); await list();
    }),
  };
}

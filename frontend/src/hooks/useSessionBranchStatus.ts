import { useEffect, useState } from 'react';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import { projectBranchBadges, type BranchBadge } from '../utils/sessionBranchStatus';
import type { SessionBranchTip } from '../types/taskWorkspaces';

// 关闭后旧 RPC 仍计入额度；再次打开不会无限叠加读取。
let activeReads = 0;
const waiters: Array<() => void> = [];
async function limited<T>(read: () => Promise<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => waiters.push(resolve)); else activeReads++;
  try { return await read(); }
  finally { const next = waiters.shift(); if (next) next(); else activeReads--; }
}

interface CheckState {
  loading: boolean; notice: string; checkedAt: number;
  rows: Array<{ tip: SessionBranchTip; badge: BranchBadge }>;
}

/** 仅检查窗口挂载和显式刷新读取。事件只使快照失效，不自动调度新查询。 */
export function useSessionBranchStatus(session: string, executor: string) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<CheckState>({ loading: true, notice: '', checkedAt: 0, rows: [] });
  useEffect(() => {
    let live = true, invalidated = false;
    const owner = getCurrentUserProfile().userId, members = new Set([session]);
    const valid = () => live && !invalidated && getCurrentUserProfile().userId === owner;
    const invalidate = (notice: string) => {
      if (!live) return;
      invalidated = true;
      setState({ loading: false, notice, checkedAt: 0, rows: [] });
    };
    setState({ loading: true, notice: '', checkedAt: 0, rows: [] });
    const offOwner = onCurrentUserChanged(() => invalidate('用户身份已改变，请关闭后重新打开检查。'));
    const offConnection = api.onExecutorConnectionStatus(executor, online => {
      if (!online) invalidate('原节点离线，状态待核对。连接恢复后请重新检查。');
    });
    const offSession = api.onSessionUpdated(event => {
      if ((event.execKey || 'local') === executor && members.has(event.sessionId)
          && !['favorite_changed', 'token_usage_updated'].includes(event.type))
        invalidate('项目已变化，请重新检查分支状态。');
    });
    const offMerge = api.onProjectMergeUpdated((row, node) => {
      if (node === executor && [row.sourceSessionId, row.actualSourceSessionId, row.targetSessionId].some(id => members.has(id || '')))
        invalidate('合并状态已变化，请重新检查分支状态。');
    });
    void limited(async () => {
      if (!valid()) return;
      try {
        const caps = await api.projectMergeCapabilities(session, executor);
        if (!valid()) return;
        if (caps.branchStatus !== 1) throw Error('原节点尚不支持分支状态检查，请升级该节点。');
        let offset = 0, identity = '', total = -1, checkedAt = 0;
        const tips = new Map<string, SessionBranchTip>();
        do {
          const page = await api.projectBranchStatus(session, executor, offset);
          if (!valid()) return;
          const main = page.items.find(tip => tip.main);
          if (!main || main.sessionId !== session || page.parentSessionId !== session || page.version !== 1) throw Error('项目关联不可核对');
          const mark = JSON.stringify([page.familyRevision, main.head, main.branch, main.dirty, main.busy]);
          if (identity && identity !== mark) throw Error('分页期间主干或成员已变化，请重新检查');
          identity = mark; total = page.total; checkedAt = Math.min(checkedAt || page.checkedAt, page.checkedAt);
          page.items.forEach(tip => { tips.set(tip.sessionId, tip); members.add(tip.sessionId); });
          if (page.nextOffset === null) break;
          if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw Error('分页状态不可核对');
          offset = page.nextOffset;
        } while (valid());
        if (!valid()) return;
        if (tips.size !== total + 1) throw Error('项目成员读取不完整');
        if (!Number.isFinite(checkedAt) || Date.now() / 1000 - checkedAt > 60) throw Error('分支快照已过期，请重新检查');
        const badges = projectBranchBadges([...tips.values()], checkedAt);
        setState({ loading: false, notice: '', checkedAt, rows: [...tips.values()].map(tip => ({
          tip, badge: badges.get(tip.sessionId) || { label: '状态待核对', detail: '当前成员状态不可核对', tone: 'muted' },
        })) });
      } catch (error) {
        if (valid()) setState({ loading: false, notice: String(error instanceof Error ? error.message : error), checkedAt: 0, rows: [] });
      }
    });
    return () => { live = false; offOwner(); offConnection(); offSession(); offMerge(); };
  }, [session, executor, nonce]);
  return { ...state, refresh: () => setNonce(value => value + 1) };
}

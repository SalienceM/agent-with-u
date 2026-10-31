import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppModalPortal } from './AppModalPortal';
import { DirectorySyncDiff } from './DirectorySyncDiff';
import { useDirectorySyncReview } from '../hooks/useDirectorySyncReview';
import { useReviewPathFilter } from '../hooks/useReviewPathFilter';
import { reviewPage, type CompareSnapshot, type ReviewPair, type ReviewStatus } from '../utils/directorySyncReview';
import type { RemoteSyncReview, ReviewAdapter } from '../utils/syncReviewProtocol';
import { reviewDirty, submitReviewTransfer } from '../utils/directorySyncTransfers';
import { fileTransfers } from '../utils/fileTransfers';
import { DocumentProtocolError } from '../utils/workspaceDocuments';

const labels: Record<ReviewStatus, string> = { pending: '未处理', skipped: '已跳过', stale: '需重新审阅',
  transferring: '传输中', pushed: '已推送', pulled: '已拉取', failed: '失败', unresolved: '结果未知' };
const reasons: Record<string, string> = { too_large: '文件超过 2 MiB', too_many_lines: '超过 20,000 行', line_too_long: '单行超过 64 Ki 字符',
  binary: '二进制内容', invalid_encoding: '无法完整解码', unsupported_encoding: '不支持的编码', specialized_preview: '非普通文本类型',
  diff_budget_exceeded: '差异计算超出预算', review_unsupported: '执行端不支持安全审阅协议', type_conflict: '文件/目录类型冲突',
  dirty_document: '存在未保存草稿或未确认保存，请先处理文档', disk_conflict: '磁盘版本已变化，请重新审阅',
  stale_workspace: '工作区身份已变化，请重新比对', safe_create_unsupported: '浏览器目录不支持安全无覆盖创建', document_readonly: '目标文件只读' };
export const reviewReason = (reason: string) => reasons[reason] || reason;
export interface ReviewViewPreferences {
  search: string; regex: boolean; pendingOnly: boolean; page: number; listOpen: boolean;
  selected?: string; skipped: string[];
}
export interface DirectorySyncReviewProps {
  snapshot: CompareSnapshot; local: ReviewAdapter; remote: RemoteSyncReview; localLabel: string; remoteLabel: string;
  transferKey: string; subtree?: string; selected?: string; onlyDifferent?: boolean; trigger: HTMLElement | null;
  current: () => boolean; onClose: () => void;
  initialPreferences?: ReviewViewPreferences;
  onPreferencesChange?: (preferences: ReviewViewPreferences) => void;
}
export const DirectorySyncReviewPanel: React.FC<DirectorySyncReviewProps> = props => {
  const { snapshot, local, remote } = props;
  const saved = props.initialPreferences;
  const review = useDirectorySyncReview(snapshot, local, remote, props.subtree, props.selected || saved?.selected, props.onlyDifferent, saved?.skipped);
  // 从文件入口定位时清除可能隐藏该文件的筛选；普通重开保留审阅位置。
  const targeted = !!props.selected;
  const [search, setSearch] = useState(targeted ? '' : saved?.search || ''), [pendingOnly, setPendingOnly] = useState(!targeted && !!saved?.pendingOnly), [page, setPage] = useState(targeted ? 0 : saved?.page || 0);
  const [regex, setRegex] = useState(!!saved?.regex);
  const filter = useReviewPathFilter(review.queue.entries, search, regex);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760), [listOpen, setListOpen] = useState(targeted || saved?.listOpen !== false);
  const savePreferences = useRef(props.onPreferencesChange); savePreferences.current = props.onPreferencesChange;
  useEffect(() => {
    savePreferences.current?.({ search, regex, pendingOnly, page, listOpen, selected: review.queue.selected || undefined,
      skipped: review.queue.entries.filter(entry => entry.status === 'skipped').map(entry => entry.path) });
  }, [search, regex, pendingOnly, page, listOpen, review.queue]);
  const [confirm, setConfirm] = useState<{ direction: 'push' | 'pull'; pair: ReviewPair } | null>(null), [actionError, setActionError] = useState('');
  const root = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  const allTransfers = useSyncExternalStore(fileTransfers.subscribe, fileTransfers.getSnapshot);
  const busy = !!allTransfers.find(j => j.workspace === props.transferKey && ['running','preparing','unresolved'].includes(j.status));
  const currentEntry = review.queue.entries.find(e => e.path === review.queue.selected);
  const rows = reviewPage(review.queue, search, pendingOnly, page, filter.matchedPaths);
  const reviewed = review.queue.entries.filter(entry => ['pushed', 'pulled', 'skipped'].includes(entry.status)).length;
  const sampledTime = (mtime?: number) => Number.isFinite(mtime) && mtime! > 0
    ? new Date(mtime!).toLocaleString() : '未提供';
  useEffect(() => {
    const media = window.matchMedia('(max-width: 759px)'), update = () => setNarrow(media.matches);
    media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    close.current?.focus();
    const trigger = props.trigger;
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const blocked = (direction: 'push' | 'pull'): string => {
    if (!props.current()) return 'stale_workspace';
    if (busy) return '该工作区已有传输或未确认结果';
    if (!review.pair || review.pair.path !== review.queue.selected || review.diff?.status !== 'ok') return '等待完整审阅';
    if (currentEntry?.typeConflict) return 'type_conflict';
    if (currentEntry?.status === 'stale') return '请点击重新审阅';
    const source = direction === 'push' ? review.pair.local : review.pair.remote, target = direction === 'push' ? review.pair.remote : review.pair.local;
    if (source.kind !== 'file') return '来源不存在，不能用缺失传播删除';
    if (!target.version || source.reasonCode || target.reasonCode) return source.reasonCode || target.reasonCode || 'review_incomplete';
    if (target.readonly) return 'document_readonly';
    if (reviewDirty(snapshot.scope, review.pair.path)) return 'dirty_document';
    if (direction === 'push' && !remote.capability.apply) return remote.capability.writeReasonCode || 'review_write_unsupported';
    if (direction === 'pull' && target.kind === 'missing' && !local.canCreate) return 'safe_create_unsupported';
    return '';
  };
  const decide = async () => {
    if (!confirm) return;
    const frozen = confirm; setConfirm(null); setActionError('');
    try {
      await submitReviewTransfer({ scope: snapshot.scope, pair: frozen.pair, direction: frozen.direction,
        local, remote, transferKey: props.transferKey, label: `${props.remoteLabel} · ${snapshot.scope.workspace.sessionId}`,
        assertCurrent: () => {
          if (!props.current() || !review.isCurrent(frozen.pair)) throw new DocumentProtocolError('stale_workspace');
        } });
    } catch (e) { setActionError(e instanceof Error ? e.message : 'review_failed'); }
  };
  const button: React.CSSProperties = { minHeight: 36, padding: '6px 10px', borderRadius: 5, color: 'var(--theme-text)',
    border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', cursor: 'pointer' };
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 10060, background: 'rgba(0,0,0,.5)', display: 'flex', padding: narrow ? 4 : 20 }}>
    <div ref={root} role="dialog" aria-modal="true" aria-label="目录同步审阅" onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (confirm) setConfirm(null); else props.onClose(); }
      if (e.key === 'Tab') {
        const focusable = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') || [])].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }} style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 1500, margin: 'auto', height: '100%', maxHeight: 950,
      overflow: 'hidden', background: 'var(--theme-panel-solid, #151922)', opacity: 1,
      color: 'var(--theme-text)', border: '1px solid var(--theme-border)', borderRadius: 10 }}>
      <header style={{ padding: 10, borderBottom: '1px solid var(--theme-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong style={{ flex: 1 }}>目录同步审阅 · {review.queue.entries.findIndex(e => e.path === review.queue.selected) + 1}/{review.queue.entries.length}</strong>
        <button style={button} onClick={() => setListOpen(v => !v)}>{listOpen ? '收起列表' : '文件列表'}</button>
        <button style={button} ref={close} onClick={props.onClose}>关闭审阅</button>
      </header>
      <div style={{ padding: '6px 10px', fontSize: 12, overflowWrap: 'anywhere' }}>
        <div>本机副本：{props.localLabel}</div><div>执行端：{props.remoteLabel} · {snapshot.scope.workspace.workingDir}</div>
        <div>比对时间 {new Date(snapshot.comparedAt).toLocaleTimeString()} · 只读对比，整文件选择；非逐行合并</div>
        <div role="status">已处理 {reviewed}/{review.queue.entries.length} 项（含跳过，跳过不等于同步）{reviewed > 0 && reviewed === review.queue.entries.length ? ' · 本轮审阅已完成，可返回任意文件查看' : ''}</div>
        {props.onlyDifferent && <div>仅不同：两端都存在且内容不同，不含仅本机／仅执行端文件</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', flex: 1, minHeight: 0 }}>
        {listOpen && <aside aria-label="差异文件列表" style={{ width: narrow ? '100%' : 240, flexShrink: 0, maxHeight: narrow ? 185 : undefined,
          display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--theme-border)', overflow: 'hidden' }}>
          <input aria-label="筛选差异文件" aria-invalid={!!filter.error} aria-describedby={regex ? 'sync-review-regex-hint' : undefined}
            placeholder={regex ? '如 ^src/.*\\.(ts|tsx)$' : '筛选文件名'} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
            style={{ margin: 6, minWidth: 0, minHeight: 32, boxSizing: 'border-box', border: '1px solid var(--theme-border)', borderRadius: 4,
              padding: '4px 8px', color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)' }} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, padding: '0 8px' }}>
            <label><input type="checkbox" checked={pendingOnly} onChange={e => { setPendingOnly(e.target.checked); setPage(0); }} />只看未处理</label>
            <label><input type="checkbox" checked={regex} onChange={e => { setRegex(e.target.checked); setPage(0); }} />正则 .*</label>
          </div>
          {regex && <small id="sync-review-regex-hint" style={{ padding: '4px 8px' }}>匹配相对路径，忽略大小写</small>}
          {filter.error && <div role="alert" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--theme-error, #ef4444)' }}>{filter.error}</div>}
          {filter.pending && <small role="status" style={{ padding: '4px 8px' }}>正在筛选…</small>}
          <div style={{ overflow: 'auto', flex: 1 }}>
            {rows.entries.map(entry => <button key={entry.path} aria-current={entry.path === review.queue.selected ? 'true' : undefined}
              disabled={!!confirm} style={{ ...button, display: 'block', width: '100%', textAlign: 'left', borderRadius: 0, overflowWrap: 'anywhere',
                background: entry.path === review.queue.selected ? 'var(--theme-bg-tertiary)' : 'transparent' }}
              onClick={() => review.dispatch({ type: 'select', path: entry.path })}>
              {entry.path}<small style={{ display: 'block' }}>{entry.conflict ? '⚠ 双端变化/类型冲突 · ' : ''}{labels[entry.status]}</small>
            </button>)}
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', fontSize: 12 }}>
            <button style={button} disabled={rows.page === 0} onClick={() => setPage(rows.page - 1)}>前页</button>
            <span>{rows.page + 1}/{rows.pages} · {rows.count} 项</span>
            <button style={button} disabled={rows.page + 1 >= rows.pages} onClick={() => setPage(rows.page + 1)}>后页</button>
          </div>
        </aside>}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 8, overflowWrap: 'anywhere', borderBottom: '1px solid var(--theme-border)' }}>
            <strong>{review.queue.selected || '没有差异文件'}</strong> · {currentEntry && labels[currentEntry.status]}
            <div style={{ fontSize: 12 }}>{snapshot.baseline[review.queue.selected || ''] ? '有当前作用域的可信基线（无历史正文）' : '无可信同步基线；修改时间仅供参考，不预选推拉方向'}</div>
            {review.pair && <div style={{ fontSize: 12 }}>本机：{review.pair.local.kind === 'missing' ? '不存在' : review.pair.local.version?.exists ? `${review.pair.local.version.byteLength} 字节` : '不可读取'} · 执行端：{review.pair.remote.kind === 'missing' ? '不存在' : review.pair.remote.version?.exists ? `${review.pair.remote.version.byteLength} 字节` : '不可读取'}</div>}
            {review.queue.selected && <div style={{ fontSize: 12 }}>修改时间（比对采样，仅参考）：本机 {sampledTime(snapshot.local[review.queue.selected]?.mtime)} · 执行端 {sampledTime(snapshot.remote[review.queue.selected]?.mtime)}</div>}
          </div>
          {review.diff?.status === 'ok' ? <DirectorySyncDiff diff={review.diff} narrow={narrow}
            localMissing={review.pair?.local.kind === 'missing'} remoteMissing={review.pair?.remote.kind === 'missing'} /> : <div role="status" style={{ padding: 16, flex: 1 }}>
            {review.error ? reviewReason(review.error) : review.diff?.status === 'unavailable' ? `无法完整审阅：${reviewReason(review.diff.reasonCode)}` : review.queue.selected ? '按需读取当前文件并计算差异…' : '当前范围内没有差异'}
            {review.diff?.status === 'unavailable' && review.diff.side && <div>受限来源：{review.diff.side === 'local' ? '本机副本' : '执行端'}</div>}
          </div>}
          {(currentEntry?.reason || actionError) && <div role="status" style={{ padding: 8 }}>{reviewReason(actionError || currentEntry?.reason || '')}</div>}
        </main>
      </div>
      {confirm ? <section role="alertdialog" aria-label="确认单文件同步" style={{ borderTop: '1px solid var(--theme-border)', padding: 12, overflowWrap: 'anywhere' }}>
        <strong>{confirm.direction === 'push' ? '推送到执行端' : '拉取到本机'}：{confirm.pair.path}</strong>
        <div>来源：{confirm.direction === 'push' ? props.localLabel : `${props.remoteLabel} · ${snapshot.scope.workspace.workingDir}`}</div>
        <div>目标：{confirm.direction === 'push' ? `${props.remoteLabel} · ${snapshot.scope.workspace.workingDir}` : props.localLabel}</div>
        <div>{(confirm.direction === 'push' ? confirm.pair.remote : confirm.pair.local).kind === 'missing' ? '创建缺失文件' : '覆盖目标文件'}，仅传输这一份已审阅的完整原字节。</div>
        <small>提交前复核两端；不能阻止所有外部程序在最终核验之后抢先修改。</small>
        <div><button style={button} onClick={() => setConfirm(null)}>取消</button> <button style={button} onClick={() => void decide()}>确认{confirm.direction === 'push' ? '推送' : '拉取'}</button></div>
      </section> : <footer style={{ padding: 10, display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--theme-border)' }}>
        <button style={button} onClick={() => review.dispatch({ type: 'navigate', direction: -1 })}>上一文件</button>
        <button style={button} onClick={() => review.dispatch({ type: 'navigate', direction: 1 })}>下一文件</button>
        <button style={button} disabled={busy || !review.queue.selected} onClick={() => { review.dispatch({ type: 'result', path: review.queue.selected!, status: 'pending' }); review.reload(); }}>重新审阅</button>
        <button style={button} disabled={busy || !review.queue.selected} onClick={() => review.dispatch({ type: 'result', path: review.queue.selected!, status: 'skipped' })}>跳过</button>
        {(['push','pull'] as const).map(direction => <span key={direction} title={reviewReason(blocked(direction))}>
          <button style={button} disabled={!!blocked(direction)} onClick={() => review.pair && setConfirm({ direction, pair: review.pair })}>{direction === 'push' ? '推送到执行端 →' : '← 拉取到本机'}</button>
          {!!blocked(direction) && <small style={{ display: 'block', maxWidth: narrow ? 165 : 260 }}>{reviewReason(blocked(direction))}</small>}
        </span>)}
      </footer>}
    </div>
  </div></AppModalPortal>;
};

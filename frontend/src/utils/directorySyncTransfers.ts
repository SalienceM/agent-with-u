import { byteHash } from './documentCodec';
import { documentStore } from './documentStore';
import { DocumentProtocolError, sameDiskVersion } from './workspaceDocuments';
import { fileTransfers } from './fileTransfers';
import { reviewScopeKey, saveReviewBaseline, type ReviewPair, type ReviewScope, type ReviewStatus } from './directorySyncReview';
import { ReviewNotSubmitted, type RemoteSyncReview, type ReviewAdapter, type ReviewReceipt } from './syncReviewProtocol';
import { reviewText } from './syncReviewDiff';
import { uuid } from './uuid';

export interface ReviewTransferResult { scopeKey: string; compareRevision: number; path: string; requestId: string; status: ReviewStatus; reason?: string; receipt?: ReviewReceipt }
const results = new Map<string, ReviewTransferResult>(), listeners = new Set<() => void>();
let snapshot: readonly ReviewTransferResult[] = [];
function publish(result: ReviewTransferResult): void {
  const key = JSON.stringify([result.scopeKey, result.path]);
  results.delete(key); results.set(key, result);
  const terminal = [...results].filter(([, row]) => !['transferring', 'unresolved'].includes(row.status));
  for (const [expired] of terminal.slice(0, Math.max(0, terminal.length - 256))) results.delete(expired);
  snapshot = [...results.values()]; listeners.forEach(fn => fn());
}
export const reviewTransfers = {
  getSnapshot: () => snapshot,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
export function reviewDirty(scope: ReviewScope, path: string): boolean {
  return documentStore.all().some(doc => {
    const w = doc.identity.workspace;
    const normalize = (p: string) => /^[a-z]:|^\\\\/i.test(scope.workspace.workingDir) ? p.toLowerCase() : p;
    if (w.ownerId !== scope.workspace.ownerId || normalize(doc.identity.relativePath) !== normalize(path)) return false;
    const relevant = doc.identity.source === 'local-copy' ? w.workingDir === scope.bindingId
      : w.executorInstance === scope.workspace.executorInstance && w.workingDir === scope.workspace.workingDir;
    return relevant && (doc.dirty || !!doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || ''));
  });
}
/** 任务由模块持有，面板关闭只丢弃视图。没有写重试、定时器或扫描。 */
export async function submitReviewTransfer(input: {
  scope: ReviewScope; pair: ReviewPair; direction: 'push' | 'pull'; transferKey: string; label: string;
  local: ReviewAdapter; remote: RemoteSyncReview; assertCurrent: () => void;
}): Promise<void> {
  const { scope, pair, direction, local, remote, assertCurrent } = input;
  const scopeKey = reviewScopeKey(scope), path = pair.path;
  assertCurrent();
  if (scopeKey !== pair.scopeKey || local.bindingId !== scope.bindingId) throw new DocumentProtocolError('stale_workspace');
  if (reviewDirty(scope, path)) throw new DocumentProtocolError('dirty_document');
  const source = direction === 'push' ? pair.local : pair.remote, target = direction === 'push' ? pair.remote : pair.local;
  if (source.kind !== 'file' || !source.bytes || !source.version?.exists || !target.version || source.reasonCode || target.reasonCode
    || target.readonly || source.bytes.length !== source.version.byteLength || byteHash(source.bytes) !== source.version.sha256) throw new DocumentProtocolError('review_incomplete');
  reviewText(source.bytes, path);
  if (target.bytes) reviewText(target.bytes, path);
  if (direction === 'pull' && target.kind === 'missing' && !local.canCreate) throw new DocumentProtocolError('safe_create_unsupported');
  if ([...results.values()].filter(r => ['transferring', 'unresolved'].includes(r.status)).length >= 32) throw new DocumentProtocolError('review_limit');
  const job = fileTransfers.start(input.transferKey, input.label, direction, path);
  if (!job) throw new DocumentProtocolError('transfer_busy');
  job.ownerId = scope.workspace.ownerId;
  fileTransfers.reviewState(job, 'preparing', '核对已审阅的两端版本…');
  const requestId = uuid();
  const base: ReviewTransferResult = { scopeKey, compareRevision: pair.compareRevision, path, requestId, status: 'transferring' };
  publish(base);
  const request = { requestId, relativePath: path, baseVersion: { ...target.version }, bytes: source.bytes.slice(), scopeKey };
  const sourceHash = byteHash(request.bytes);
  let submitted = false, reconciling: Promise<void> | undefined;
  const setUnknown = () => {
    publish({ ...base, status: 'unresolved', reason: '结果未知，请核对原请求；不会重发写入' });
    fileTransfers.reviewState(job, 'unresolved', '审阅传输结果未知；该工作区写入仍保留占用', reconcile);
  };
  const settle = async (receipt: ReviewReceipt) => {
    if (receipt.requestId !== requestId || (receipt.status !== 'unknown' && (receipt.scopeKey !== scopeKey || receipt.relativePath !== path
      || receipt.sourceHash !== sourceHash))) throw new DocumentProtocolError('invalid_review_receipt');
    if (receipt.status === 'succeeded') {
      if (!receipt.version?.exists || receipt.version.sha256 !== sourceHash) throw new DocumentProtocolError('invalid_review_receipt');
      let synced = false;
      try {
        const [l, r] = await Promise.all([local.check(path), remote.check(path)]);
        synced = !!(l.version?.exists && r.version?.exists && l.version.sha256 === r.version.sha256
          && l.version.byteLength === r.version.byteLength && l.version.sha256 === receipt.version.sha256);
        if (synced) saveReviewBaseline(scope, path, l.version!, r.version!, localStorage);
      } catch { /* 已提交成功，但当前两端无法证明一致；保留需重新审阅。 */ }
      publish({ ...base, status: synced ? direction === 'push' ? 'pushed' : 'pulled' : 'stale', receipt,
        reason: synced ? '已核验两端一致' : '本次传输完成；当前两端仍需重新审阅' });
      fileTransfers.reviewState(job, 'done', synced ? '审阅传输完成，已核验两端一致' : '传输完成，但当前版本需重新审阅');
      request.bytes = new Uint8Array();
    } else if (receipt.status === 'failed') {
      publish({ ...base, status: receipt.reasonCode === 'disk_conflict' ? 'stale' : 'failed', reason: receipt.reasonCode, receipt });
      fileTransfers.reviewState(job, 'error', `未完成：${receipt.reasonCode || '提交失败'}`);
      request.bytes = new Uint8Array();
    } else setUnknown();
  };
  async function reconcile(): Promise<void> {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      try { await settle(direction === 'push' ? await remote.get(requestId, 10) : await local.get(requestId)); }
      catch { setUnknown(); }
    })().finally(() => { reconciling = undefined; });
    return reconciling;
  }
  try {
    const [l, r] = await Promise.all([local.check(path), remote.check(path)]);
    assertCurrent();
    if (reviewDirty(scope, path)) throw new DocumentProtocolError('dirty_document');
    if (!sameDiskVersion(l.version, pair.local.version) || !sameDiskVersion(r.version, pair.remote.version)) throw new DocumentProtocolError('disk_conflict');
    if (target.version.exists && target.version.sha256 === source.version.sha256) {
      saveReviewBaseline(scope, path, l.version!, r.version!, localStorage);
      publish({ ...base, status: direction === 'push' ? 'pushed' : 'pulled', reason: '两端已一致，未写入' });
      fileTransfers.reviewState(job, 'done', '两端已一致，未写入'); return;
    }
    submitted = true;
    fileTransfers.reviewState(job, 'running', '提交当前文件的已审阅字节…');
    const receipt = direction === 'push' ? await remote.apply(request) : await local.apply(request, () => {
      assertCurrent(); if (reviewDirty(scope, path)) throw new DocumentProtocolError('dirty_document');
    });
    request.bytes = new Uint8Array();
    if (receipt.status === 'accepted') await reconcile(); else await settle(receipt);
  } catch (e) {
    request.bytes = new Uint8Array();
    if (submitted && !(e instanceof ReviewNotSubmitted)) await reconcile();
    else {
      const reason = e instanceof Error ? e.message : 'review_failed';
      publish({ ...base, status: ['disk_conflict', 'stale_workspace'].includes(reason) ? 'stale' : 'failed', reason });
      fileTransfers.reviewState(job, 'error', `未提交：${reason}`);
    }
  }
}

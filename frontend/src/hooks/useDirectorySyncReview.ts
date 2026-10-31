import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createReviewQueue, reduceReviewQueue, reviewScopeKey, type CompareSnapshot, type ReviewPair } from '../utils/directorySyncReview';
import type { ReviewAdapter, RemoteSyncReview } from '../utils/syncReviewProtocol';
import type { ReviewDiff } from '../utils/syncReviewDiff';
import { ReviewPairReader } from '../utils/reviewPairReader';
import { reviewTransfers } from '../utils/directorySyncTransfers';

export function useDirectorySyncReview(snapshot: CompareSnapshot, local: ReviewAdapter, remote: RemoteSyncReview,
  subtree = '', selected?: string, onlyDifferent = false, skipped: readonly string[] = []) {
  const [queue, dispatch] = useReducer(reduceReviewQueue, undefined, () => {
    const queue = createReviewQueue(snapshot, subtree, selected, onlyDifferent), paths = new Set(skipped);
    return { ...queue, entries: queue.entries.map(entry => paths.has(entry.path) ? { ...entry, status: 'skipped' as const } : entry) };
  });
  const [pair, setPair] = useState<ReviewPair | null>(null), [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const revision = useRef(0), current = useRef({ path: queue.selected, pair });
  current.current = { path: queue.selected, pair };
  const reader = useMemo(() => new ReviewPairReader(p => local.read(p), p => remote.read(p)), [local, remote]);
  const transfers = useSyncExternalStore(reviewTransfers.subscribe, reviewTransfers.getSnapshot);
  const appliedResults = useRef(new WeakSet<object>());
  const scopeKey = reviewScopeKey(snapshot.scope);
  useEffect(() => {
    for (const result of transfers) if (result.scopeKey === scopeKey && result.compareRevision === snapshot.revision) {
      if (appliedResults.current.has(result)) continue;
      appliedResults.current.add(result);
      dispatch({ type: 'result', path: result.path, status: result.status, reason: result.reason });
    }
  }, [transfers, scopeKey, snapshot.revision]);
  useEffect(() => {
    const generation = ++revision.current, path = queue.selected;
    let active = true, worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    setPair(null); setDiff(null); setError('');
    if (path) void reader.read(snapshot, path, generation).then(read => {
      if (!active || generation !== revision.current) return;
      setPair(read);
      const limited = [read.local, read.remote].find(s => s.reasonCode || !['file', 'missing'].includes(s.kind));
      if (limited) { setDiff({ status: 'unavailable', reasonCode: limited.reasonCode || 'review_unavailable', side: limited === read.local ? 'local' : 'remote' }); return; }
      if ((read.local.kind === 'file' && !read.local.bytes) || (read.remote.kind === 'file' && !read.remote.bytes)) {
        setDiff({ status: 'unavailable', reasonCode: 'incomplete_read' }); return;
      }
      try {
        worker = new Worker(new URL('../utils/syncReviewDiff.worker.ts', import.meta.url), { type: 'module' });
        const id = JSON.stringify([scopeKey, snapshot.revision, path, generation]);
        timer = setTimeout(() => { worker?.terminate(); if (active) setDiff({ status: 'unavailable', reasonCode: 'diff_budget_exceeded' }); }, 2500);
        worker.onmessage = event => {
          if (!active || generation !== revision.current || event.data.id !== id) return;
          clearTimeout(timer); worker?.terminate(); setDiff(event.data.result);
        };
        worker.onerror = () => { clearTimeout(timer); worker?.terminate(); if (active) setDiff({ status: 'unavailable', reasonCode: 'diff_unavailable' }); };
        worker.postMessage({ id, path, left: read.local.bytes || new Uint8Array(), right: read.remote.bytes || new Uint8Array() });
      } catch { setDiff({ status: 'unavailable', reasonCode: 'diff_unavailable' }); }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'read_failed'); });
    return () => { active = false; revision.current++; clearTimeout(timer); worker?.terminate(); };
  }, [queue.selected, snapshot, reader, reload, scopeKey]);
  return { queue, dispatch, pair, diff, error, reload: () => setReload(v => v + 1),
    isCurrent: (expected: ReviewPair) => current.current.path === expected.path && current.current.pair === expected };
}

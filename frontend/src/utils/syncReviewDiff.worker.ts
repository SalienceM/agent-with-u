import { calculateReviewDiff } from './syncReviewDiff';
self.onmessage = (event: MessageEvent<{ id: string; left: Uint8Array; right: Uint8Array; path: string }>) => {
  const { id, left, right, path } = event.data;
  self.postMessage({ id, result: calculateReviewDiff(left, right, path) });
};

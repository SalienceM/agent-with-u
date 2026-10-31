import { matchReviewPaths } from './directorySyncReview';

self.onmessage = (event: MessageEvent<{ id: string; paths: string[]; expression: string }>) => {
  const { id, paths, expression } = event.data;
  self.postMessage({ id, result: matchReviewPaths(paths, expression) });
};

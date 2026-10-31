import { useEffect, useState } from 'react';
import type { ReviewEntry, ReviewPathMatch } from '../utils/directorySyncReview';

const empty = new Set<string>();
const messages = { invalid_regex: '正则表达式无效，请检查括号、转义等语法', pattern_too_long: '正则表达式最多 512 个字符' };

/** 只过滤文件名，不读取正文；隔离可能指数回溯的正则，换条件/关闭即终止。 */
export function useReviewPathFilter(entries: readonly ReviewEntry[], expression: string, regex: boolean) {
  const pathsKey = JSON.stringify(entries.map(entry => entry.path));
  const key = JSON.stringify([pathsKey, expression]);
  const [result, setResult] = useState<{ key: string; paths: Set<string>; error: string } | null>(null);
  const active = regex && expression !== '';
  useEffect(() => {
    if (!active) return;
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, alive = true, finished = false;
    const finish = (paths: string[], error = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); worker?.terminate();
      if (alive) setResult({ key, paths: new Set(paths), error });
    };
    try {
      worker = new Worker(new URL('../utils/syncReviewFilter.worker.ts', import.meta.url), { type: 'module' });
      timer = setTimeout(() => finish([], '正则匹配超时，请简化表达式'), 1500);
      worker.onmessage = (event: MessageEvent<{ id: string; result: ReviewPathMatch }>) => {
        if (!alive || event.data.id !== key) return;
        const matched = event.data.result;
        finish(matched.status === 'ok' ? matched.paths : [], matched.status === 'error' ? messages[matched.reason] : '');
      };
      worker.onerror = () => finish([], '正则筛选不可用，请改用普通文本筛选');
      worker.postMessage({ id: key, paths: JSON.parse(pathsKey), expression });
    } catch { finish([], '正则筛选不可用，请改用普通文本筛选'); }
    return () => { alive = false; clearTimeout(timer); worker?.terminate(); };
  }, [active, key, pathsKey, expression]);
  return { matchedPaths: active ? result?.key === key ? result.paths : empty : undefined,
    error: active && result?.key === key ? result.error : '', pending: active && result?.key !== key };
}

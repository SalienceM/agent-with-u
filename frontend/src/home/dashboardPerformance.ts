/** 保序、限并发的 allSettled；用于避免大量会话在首页启动时同时冲击 WebSocket。 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  let cursor = 0;

  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

/**
 * 合并一轮局部数据加载结果：成功源采用新值，失败源保留上次成功快照，
 * 同时剔除已经不在当前会话清单中的旧源。
 */
export function mergeSuccessfulSnapshots<T>(
  previous: Readonly<Record<string, T>>,
  currentIds: readonly string[],
  successful: Readonly<Record<string, T>>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const id of currentIds) {
    if (Object.prototype.hasOwnProperty.call(successful, id)) {
      merged[id] = successful[id];
    } else if (Object.prototype.hasOwnProperty.call(previous, id)) {
      merged[id] = previous[id];
    }
  }
  return merged;
}

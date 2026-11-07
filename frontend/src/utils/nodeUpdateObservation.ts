/** 更新写请求只提交一次；丢失回复后仅核对原请求，不从超时推断失败。 */
export class UpdateResultUnknown extends Error {}

export interface UpdateObservation {
  phase: string;
  stageRequestId?: string;
  applyRequestId?: string;
}

export async function observeNodeUpdate<T extends UpdateObservation>(options: {
  read: () => Promise<T>;
  receive: (status: T) => void;
  waiting: (message: string) => void;
  requestId: string;
  kind: 'stage' | 'apply';
  active?: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<T> {
  const sleep = options.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const deadline = now() + (options.timeoutMs ?? 2 * 60 * 60 * 1000);
  let failures = 0, unmatched = 0;
  while (now() < deadline && (options.active?.() ?? true)) {
    let status: T;
    try {
      status = await options.read();
      failures = 0;
    } catch {
      failures++;
      options.waiting('暂时无法连接，正在核对原任务；节点可能仍在继续。');
      if (failures >= 6) break;
      await sleep(Math.min(1000 * 2 ** (failures - 1), 8000));
      continue;
    }
    options.receive(status);
    const id = options.kind === 'stage' ? status.stageRequestId : status.applyRequestId;
    if (options.requestId && id !== options.requestId) {
      options.waiting('尚未查到本次请求，正在核对；不会重复提交。');
      if (++unmatched >= 6) break;
    } else {
      unmatched = 0;
      const pending = options.kind === 'stage'
        ? ['checking', 'downloading'].includes(status.phase)
        : status.phase === 'staged';
      if (!pending) return status;
    }
    await sleep(unmatched ? 2000 : 1000);
  }
  throw new UpdateResultUnknown('暂未确认原任务结果。可刷新状态继续核对；此次没有重复提交下载或安装。');
}

export function updateRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

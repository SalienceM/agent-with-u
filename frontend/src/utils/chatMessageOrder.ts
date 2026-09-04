import { shouldKeepChatMessage } from './chatMessageVisibility';

export interface OrderableChatMessage {
  id: string;
  role?: unknown;
  streaming?: unknown;
  waitingForFirstDelta?: unknown;
  content?: unknown;
  thinking?: unknown;
  thinkingBlocks?: Array<{ content?: unknown }> | null;
  toolCalls?: unknown[] | null;
  images?: unknown[] | null;
  textAttachments?: unknown[] | null;
  contentBlocks?: Array<{ type?: unknown; text?: unknown }> | null;
}

/**
 * 后端返回的数组决定所有已落盘消息的顺序。
 *
 * RPC 往返期间可能刚好发送了新消息，所以只补回有明确来源的本地状态：
 * 尚待后端确认的乐观消息、正在流式/等待首帧的消息，以及纯前端 system 消息。
 * 不能再把任意“后端没返回”的已完成 assistant 追加到末尾，否则切换 Session
 * 时，缓存中的旧气泡会短暂越过正在刷新的新气泡。
 */
export function mergeAuthoritativeChatMessages<T extends OrderableChatMessage>(
  loaded: readonly T[],
  current: readonly T[],
  pendingLocalIds: ReadonlySet<string>,
): T[] {
  const loadedIds = new Set(loaded.map((message) => message.id));
  const shouldPreserveLocal = (message: T): boolean => {
    if (!shouldKeepChatMessage(message)) return false;
    if (loadedIds.has(message.id)) return false;
    return message.role === 'system'
      || pendingLocalIds.has(message.id)
      || message.streaming === true
      || message.waitingForFirstDelta === true;
  };

  // 本地 send 通常位于末尾，但运行中 follow-up 会被插到目标 assistant 前面。
  // 将保留项锚定到 current 中紧随其后的第一条权威消息，既不打乱 loaded
  // 自身的顺序，也不会把 follow-up 从 assistant 前面挪到整个会话末尾。
  const beforeLoaded = new Map<string, T[]>();
  const trailing: T[] = [];
  const seenLocalIds = new Set<string>();
  for (let index = 0; index < current.length; index += 1) {
    const message = current[index];
    if (!shouldPreserveLocal(message) || seenLocalIds.has(message.id)) continue;
    seenLocalIds.add(message.id);

    let anchorId: string | null = null;
    for (let next = index + 1; next < current.length; next += 1) {
      if (loadedIds.has(current[next].id)) {
        anchorId = current[next].id;
        break;
      }
    }
    if (anchorId) {
      const group = beforeLoaded.get(anchorId) || [];
      group.push(message);
      beforeLoaded.set(anchorId, group);
    } else {
      trailing.push(message);
    }
  }

  if (beforeLoaded.size === 0 && trailing.length === 0) return [...loaded];
  const merged: T[] = [];
  for (const message of loaded) {
    const before = beforeLoaded.get(message.id);
    if (before) merged.push(...before);
    merged.push(message);
  }
  merged.push(...trailing);
  return merged;
}

/**
 * 切回 Session 时，全局 StreamState 可以覆盖缓存中同 ID 的原位置。
 * 只有仍在运行的 tail 才允许作为新气泡补到末尾；已完成但缓存中不存在的
 * tail 必须等待 loadSession 给出权威位置。
 */
export function mergeCachedHistoryWithStreamTail<T extends { id: string }>(
  cached: readonly T[] | undefined,
  tail: T | null,
  active: boolean,
): T[] {
  const result = cached ? [...cached] : [];
  if (!tail) return result;

  const existingIndex = result.findIndex((message) => message.id === tail.id);
  if (existingIndex >= 0) {
    result[existingIndex] = tail;
  } else if (active) {
    result.push(tail);
  }
  return result;
}

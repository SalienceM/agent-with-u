/**
 * StreamStateManager: 全局流式状态管理器
 *
 * 问题：当用户切换 session 时，正在流式输出的 session 的中间状态会丢失。
 *
 * 解决方案：
 * - 创建全局单例，存储每个 session 的流式累积状态
 * - 收到 streamDelta 时，更新对应 session 的状态
 * - 切换 session 时，从全局状态恢复流式状态
 */

import type { ChatMessage, ToolCall, ContentBlock } from './useChat';

// 流式状态
export interface StreamState {
  messageId: string | null;
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  contentBlocks: ContentBlock[];
  streamStart: number;
  isStreaming: boolean;
}

// 创建空的流式状态
function createEmptyState(): StreamState {
  return {
    messageId: null,
    text: '',
    thinking: '',
    toolCalls: [],
    contentBlocks: [],
    streamStart: 0,
    isStreaming: false,
  };
}

// 全局流式状态存储
const streamStates = new Map<string, StreamState>();

// 获取或创建 session 的流式状态
export function getStreamState(sessionId: string): StreamState {
  let state = streamStates.get(sessionId);
  if (!state) {
    state = createEmptyState();
    streamStates.set(sessionId, state);
  }
  return state;
}

// 清除 session 的流式状态
export function clearStreamState(sessionId: string): void {
  streamStates.delete(sessionId);
}

// 重置流式累积器（消息完成时调用）
// 注意：此函数已弃用，不再调用。状态会在下一次 initStreamMessage 时自动覆盖。
// 保留此函数仅用于 session 清理等特殊场景。
export function resetStreamAccumulators(sessionId: string): void {
  const state = streamStates.get(sessionId);
  if (state) {
    state.text = '';
    state.thinking = '';
    state.toolCalls = [];
    state.contentBlocks = [];
    state.messageId = null;
    state.isStreaming = false;
  }
}

// 清除 session 的流式状态（用于 session 删除等场景）
export function clearStreamStateForSession(sessionId: string): void {
  clearStreamState(sessionId);
}

// 初始化新的流式消息
export function initStreamMessage(sessionId: string, messageId: string): void {
  const state = getStreamState(sessionId);
  state.messageId = messageId;
  state.text = '';
  state.thinking = '';
  state.toolCalls = [];
  state.contentBlocks = [];
  state.streamStart = Date.now();
  state.isStreaming = true;
}

// 处理 streamDelta，更新流式状态
export function processStreamDelta(sessionId: string, delta: any): {
  messagesUpdated: boolean;
  state: StreamState;
} {
  const state = getStreamState(sessionId);
  const mid = delta.messageId;

  // 如果是新消息，初始化状态
  if (state.messageId !== mid && delta.type !== 'done' && delta.type !== 'error') {
    state.messageId = mid;
    state.text = '';
    state.thinking = '';
    state.toolCalls = [];
    state.contentBlocks = [];
    state.streamStart = Date.now();
    state.isStreaming = true;
  }

  // 辅助：将所有 running 工具标记为 done
  const finishRunningTools = () => {
    const now = Date.now();
    let changed = false;
    const updated = state.toolCalls.map((tc) => {
      if (tc.status === 'running') {
        changed = true;
        return { ...tc, status: 'done', duration: tc.startTime ? now - tc.startTime : undefined };
      }
      return tc;
    });
    if (changed) state.toolCalls = updated;
    return changed ? updated : null;
  };

  switch (delta.type) {
    case 'text_delta': {
      state.text += delta.text || '';
      finishRunningTools();
      // 只保留一个 text 块
      const blocksNoText = state.contentBlocks.filter(b => b.type !== 'text');
      state.contentBlocks = [...blocksNoText, { type: 'text' }];
      break;
    }

    case 'thinking': {
      state.thinking += delta.text || '';
      if (!state.contentBlocks.some(b => b.type === 'thinking')) {
        state.contentBlocks = [...state.contentBlocks, { type: 'thinking' }];
      }
      break;
    }

    case 'tool_start': {
      finishRunningTools();
      const tc: ToolCall = {
        id: delta.toolCall?.id || '',
        name: delta.toolCall?.name || 'unknown',
        input: delta.toolCall?.input || '',
        status: 'running',
        startTime: Date.now(),
      };
      const exists = tc.id && state.toolCalls.some((t) => t.id === tc.id);
      state.toolCalls = exists
        ? state.toolCalls.map((t) =>
            t.id === tc.id ? { ...t, input: tc.input || t.input } : t
          )
        : [...state.toolCalls, tc];
      if (!exists) {
        state.contentBlocks = [
          ...state.contentBlocks,
          { type: 'tool', toolIndex: state.toolCalls.length - 1 },
        ];
      }
      break;
    }

    case 'tool_input': {
      const inputDelta = delta.toolCall?.inputDelta || '';
      if (state.toolCalls.length > 0 && inputDelta) {
        const last = state.toolCalls[state.toolCalls.length - 1];
        last.input = (last.input || '') + inputDelta;
      }
      break;
    }

    case 'tool_result': {
      const resultId = delta.toolCall?.id || '';
      const output = delta.toolCall?.output || '';
      const status = delta.toolCall?.status || 'done';
      const durationFromBackend = delta.toolCall?.duration;

      let matched = false;
      state.toolCalls = state.toolCalls.map((tc) => {
        if (resultId && tc.id === resultId) {
          matched = true;
          const duration = durationFromBackend ?? (tc.startTime ? Date.now() - tc.startTime : undefined);
          return { ...tc, output, status, duration };
        }
        return tc;
      });

      // Fallback: 更新最后一个 running 工具
      if (!matched) {
        const lastRunningIdx = state.toolCalls.reduceRight(
          (found, tc, i) => (found === -1 && tc.status === 'running' ? i : found),
          -1
        );
        if (lastRunningIdx >= 0) {
          const tc = state.toolCalls[lastRunningIdx];
          const duration = durationFromBackend ?? (tc.startTime ? Date.now() - tc.startTime : undefined);
          state.toolCalls = [
            ...state.toolCalls.slice(0, lastRunningIdx),
            { ...tc, output, status, duration },
            ...state.toolCalls.slice(lastRunningIdx + 1),
          ];
        }
      }
      break;
    }

    case 'done': {
      const now = Date.now();
      state.toolCalls = state.toolCalls.map((tc) => {
        if (tc.status === 'running' && tc.startTime) {
          return {
            ...tc,
            status: 'done',
            duration: now - tc.startTime,
            output: tc.output || '(completed)',
          };
        }
        return tc;
      });
      state.isStreaming = false;
      break;
    }

    case 'error': {
      state.isStreaming = false;
      // ★ 保存错误信息到 text，让前端能显示错误
      const errorMsg = delta.error || '未知错误';
      state.text = state.text + `\n\n**错误**: ${errorMsg}`;
      break;
    }
  }

  return { messagesUpdated: true, state };
}

// 构建流式消息（用于更新 UI）
export function buildStreamingMessage(state: StreamState, baseMessage: ChatMessage): ChatMessage {
  return {
    ...baseMessage,
    content: state.text,
    thinking: state.thinking || undefined,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    contentBlocks: state.contentBlocks.length > 0 ? state.contentBlocks : undefined,
    streaming: state.isStreaming,
    elapsed: state.streamStart ? Date.now() - state.streamStart : undefined,
  };
}
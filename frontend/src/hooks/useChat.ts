import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import type { ImageAttachment } from './useClipboardImage';
import {
  getStreamState,
  processStreamDelta,
  resetStreamAccumulators,
  clearStreamState,
  initStreamMessage,
  buildStreamingMessage,
  type StreamState,
} from './useStreamState';

export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
  status: string;
  startTime?: number;  // ★ Track start time for duration calculation
  duration?: number;   // ★ Duration in milliseconds
  diff?: { path: string; old: string; new: string };  // ★ Diff data for Edit tools
}

// ★ 有序内容块：按到达顺序记录 thinking / tool / text 的出现
export interface ContentBlock {
  type: 'thinking' | 'tool' | 'text';
  toolIndex?: number;  // type === 'tool' 时指向 toolCalls 数组的索引
}

export interface PermissionRequest {
  sessionId: string;
  messageId: string;
  tools: ToolCall[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  images?: ImageAttachment[];
  backendId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: ToolCall[];
  thinking?: string;
  streaming?: boolean;
  contentBlocks?: ContentBlock[];  // ★ 有序内容块，按到达顺序排列
  elapsed?: number;  // ★ 本次回复总耗时（毫秒）
}

// ═══════════════════════════════════════
//  ★ 斜杠命令定义
// ═══════════════════════════════════════
export interface SlashCommand {
  name: string;
  description: string;
  shortDesc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help',          description: '显示可用命令列表',                     shortDesc: '帮助' },
  { name: '/new',           description: '清空对话上下文（session不变，重置下游agent session）', shortDesc: '清空上下文' },
  { name: '/clear',         description: '清空当前对话历史',                     shortDesc: '清空' },
  { name: '/compact',       description: '压缩早期消息以节省上下文窗口',         shortDesc: '压缩' },
  { name: '/cost',          description: '显示本次会话的 Token 用量与估算费用',  shortDesc: '费用' },
  { name: '/status',        description: '显示当前会话状态信息',                 shortDesc: '状态' },
  { name: '/continue',      description: '让 Claude 从上次停止处继续',           shortDesc: '继续' },
  { name: '/autocontinue',  description: '切换 max_tokens 时自动续跑',           shortDesc: '自动续跑' },
  { name: '/model',         description: '显示当前模型信息',                     shortDesc: '模型' },
  { name: '/init',          description: '让 Claude 分析项目并创建 CLAUDE.md',   shortDesc: '初始化' },
  { name: '/config',        description: '显示当前后端配置',                     shortDesc: '配置' },
  { name: '/migrate',       description: '切换到其他模型（保留对话历史）',        shortDesc: '迁移' },
];

const HELP_TEXT = `📋 **可用命令：**

| 命令 | 说明 |
|------|------|
| \`/help\` | 显示此帮助信息 |
| \`/clear\` | 清空对话历史 |
| \`/compact\` | 压缩早期消息节省上下文 |
| \`/cost\` | 显示 Token 用量 |
| \`/status\` | 显示会话状态 |
| \`/continue\` | 让 Claude 继续上次回复 |
| \`/autocontinue\` | 开关自动续跑模式 |
| \`/model\` | 显示当前模型 |
| \`/init\` | 创建 CLAUDE.md 项目文件 |
| \`/config\` | 显示后端配置 |
| \`/migrate\` | 切换到其他模型（保留历史） |

**快捷键：** Enter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴图片`;

function normalizeMessage(msg: any): ChatMessage {
  const thinking =
    msg.thinking ||
    msg.thinkingBlocks?.map((b: any) => b.content).join('\n\n') ||
    undefined;

  // ★ 修复存储中残留的 running 工具状态：非流式消息的工具调用不可能还在运行
  const toolCalls = msg.streaming
    ? msg.toolCalls
    : msg.toolCalls?.map((tc: any) =>
        tc.status === 'running' ? { ...tc, status: 'done' } : tc
      );

  // ★ 为历史消息重建 contentBlocks（加载时没有此字段）
  let contentBlocks = msg.contentBlocks as ContentBlock[] | undefined;
  if (!contentBlocks && msg.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    if (thinking) blocks.push({ type: 'thinking' });
    if (toolCalls?.length) {
      toolCalls.forEach((_: any, i: number) => blocks.push({ type: 'tool', toolIndex: i }));
    }
    if (msg.content) blocks.push({ type: 'text' });
    if (blocks.length > 0) contentBlocks = blocks;
  }

  return {
    ...msg,
    thinking,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(contentBlocks ? { contentBlocks } : {}),
  };
}

export function useChat(sessionId: string, backendId: string, backends?: any[], skipPermissions: boolean = true, onNewSession?: () => void, onClearContext?: () => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [needsMigrate, setNeedsMigrate] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  // 累积器 refs - 用于本地快速访问，实际状态存储在全局 StreamState
  const textRef = useRef('');
  const thinkingRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const contentBlocksRef = useRef<ContentBlock[]>([]);  // ★ 有序内容块
  const streamStartRef = useRef<number>(0);  // ★ 流式开始时间戳
  const msgIdRef = useRef<string | null>(null);
  // ★ 流式进行时用户发送的新消息（中断续发队列，最多保留最后一条）
  const pendingMessageRef = useRef<{ content: string; images?: ImageAttachment[] } | null>(null);

  // 稳定引用 refs
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  const autoContinueRef = useRef(true);
  autoContinueRef.current = autoContinue;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const skipPermissionsRef = useRef(skipPermissions);
  skipPermissionsRef.current = skipPermissions;

  // ★ 同步本地 refs 与全局状态
  const syncFromGlobalState = useCallback((state: StreamState) => {
    textRef.current = state.text;
    thinkingRef.current = state.thinking;
    toolCallsRef.current = state.toolCalls;
    contentBlocksRef.current = state.contentBlocks;
    streamStartRef.current = state.streamStart;
    msgIdRef.current = state.messageId;
  }, []);

  // ── 检查后端是否存在 ──
  useEffect(() => {
    if (!backends || backends.length === 0) return;
    const backendExists = backends.some(b => b.id === backendId);
    if (!backendExists) {
      setNeedsMigrate(true);
    }
  }, [backendId, backends]);

  // ── 加载 session ──
  useEffect(() => {
    if (!sessionId) return;

    // ★ 先检查全局流式状态
    const globalState = getStreamState(sessionId);
    const hasActiveStream = globalState.isStreaming && globalState.messageId;

    api.loadSession(sessionId).then((session) => {
      if (session?.messages) {
        // 加载持久化的消息
        const loadedMessages = session.messages.map(normalizeMessage);

        // ★ 如果有正在进行的流式消息，需要合并
        if (hasActiveStream && globalState.messageId) {
          // 检查是否已包含该消息
          const hasStreamingMsg = loadedMessages.some((m: ChatMessage) => m.id === globalState.messageId);
          if (!hasStreamingMsg && (globalState.text || globalState.thinking || globalState.toolCalls.length > 0)) {
            // 添加流式消息
            const streamingMsg: ChatMessage = {
              id: globalState.messageId,
              role: 'assistant',
              content: globalState.text,
              timestamp: Date.now() / 1000,
              streaming: true,
              thinking: globalState.thinking || undefined,
              toolCalls: globalState.toolCalls.length > 0 ? globalState.toolCalls : undefined,
              contentBlocks: globalState.contentBlocks.length > 0 ? globalState.contentBlocks : undefined,
            };
            loadedMessages.push(streamingMsg);
          }
        }

        setMessages(loadedMessages);
      }
      if (session?.autoContinue !== undefined) {
        setAutoContinue(session.autoContinue);
      }
    });

    // ★ 恢复流式状态
    if (hasActiveStream) {
      setIsStreaming(true);
      syncFromGlobalState(globalState);
    } else {
      setIsStreaming(false);
    }

    // 清理函数：切换 session 或卸载时清理全局流式状态
    return () => {
      clearStreamState(sessionId);
    };
  }, [sessionId, syncFromGlobalState]);

  // ── sessionUpdated 监听（compact 等后端操作完成后重载）──
  useEffect(() => {
    return api.onSessionUpdated(async (data: any) => {
      if (data.sessionId !== sessionId) return;
      if (data.type === 'session_compacted') {
        const session = await api.loadSession(sessionId);
        if (session?.messages) {
          setMessages(session.messages.map(normalizeMessage));
        }
      } else if (data.type === 'context_cleared') {
        // ★ clearSessionContext：清空对话窗口，session 本身不变
        setMessages([]);
        setIsStreaming(false);
      }
    });
  }, [sessionId]);

  // ── 权限请求监听 ──
  useEffect(() => {
    return api.onPermissionRequest((data: PermissionRequest) => {
      if (data.sessionId !== sessionId) return;
      setPendingPermission(data);
    });
  }, [sessionId]);

  // ── 流式 delta 监听 ──
  useEffect(() => {
    return api.onStreamDelta((delta) => {
      if (delta.sessionId !== sessionId) return;

      // ★ 使用全局状态处理器
      const result = processStreamDelta(sessionId, delta);
      const state = result.state;

      // ★ 同步本地 refs
      syncFromGlobalState(state);

      const mid = delta.messageId;

      // ★ 辅助函数：更新流式消息
      const updateStreamingMessage = (extra: Partial<ChatMessage> = {}) => {
        setMessages((prev) => {
          const existing = prev.find(m => m.id === mid);
          if (existing) {
            return prev.map(m =>
              m.id === mid
                ? buildStreamingMessage(state, { ...m, ...extra })
                : m
            );
          } else {
            // 消息不存在时创建新的
            const newMsg: ChatMessage = {
              id: mid,
              role: 'assistant',
              content: state.text,
              timestamp: Date.now() / 1000,
              streaming: state.isStreaming,
              thinking: state.thinking || undefined,
              toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
              contentBlocks: state.contentBlocks.length > 0 ? state.contentBlocks : undefined,
              ...extra,
            };
            return [...prev, newMsg];
          }
        });
      };

      switch (delta.type) {
        case 'text_delta':
        case 'thinking':
        case 'tool_start':
        case 'tool_input':
        case 'tool_result':
          updateStreamingMessage();
          break;

        case 'tool_end':
          updateStreamingMessage();
          break;

        case 'done': {
          // ★ 捕获最终状态快照（使用展开创建新对象，避免引用问题）
          const finalText = state.text;
          const finalThinking = state.thinking || undefined;
          const finalToolCalls = state.toolCalls.length > 0 ? [...state.toolCalls] : undefined;
          const finalBlocks = state.contentBlocks.length > 0 ? [...state.contentBlocks] : undefined;
          const finalElapsed = state.streamStart ? Date.now() - state.streamStart : undefined;

          // ★ 先保存到全局状态（作为备份），再更新 React 状态
          const sessionState = getStreamState(sessionId);
          sessionState.text = finalText;
          sessionState.thinking = finalThinking || '';
          sessionState.toolCalls = finalToolCalls || [];
          sessionState.contentBlocks = finalBlocks || [];
          sessionState.isStreaming = false;
          sessionState.messageId = null;

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== mid) return m;
              return {
                ...m,
                content: finalText,
                thinking: finalThinking,
                toolCalls: finalToolCalls,
                contentBlocks: finalBlocks,
                streaming: false,
                elapsed: finalElapsed,
                ...(delta.usage ? { usage: delta.usage } : {}),
              };
            })
          );
          setIsStreaming(false);
          break;
        }

        case 'error': {
          // ★ 捕获最终状态快照（使用展开创建新对象，避免引用问题）
          const errText = state.text;
          const errThinking = state.thinking || undefined;
          const errToolCalls = state.toolCalls.length > 0 ? [...state.toolCalls] : undefined;
          const errBlocks = state.contentBlocks.length > 0 ? [...state.contentBlocks] : undefined;
          const errElapsed = state.streamStart ? Date.now() - state.streamStart : undefined;

          // ★ 先保存到全局状态（作为备份），再更新 React 状态
          const sessionState = getStreamState(sessionId);
          sessionState.text = errText;
          sessionState.thinking = errThinking || '';
          sessionState.toolCalls = errToolCalls || [];
          sessionState.contentBlocks = errBlocks || [];
          sessionState.isStreaming = false;
          sessionState.messageId = null;

          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid
                ? {
                    ...m,
                    content: errText + `\n\n**Error:** ${delta.error}`,
                    thinking: errThinking,
                    toolCalls: errToolCalls,
                    contentBlocks: errBlocks,
                    streaming: false,
                    elapsed: errElapsed,
                  }
                : m
            )
          );
          setIsStreaming(false);
          break;
        }
      }
    });
  }, [sessionId, syncFromGlobalState]);

  // ── 添加系统消息（纯前端） ──
  const addSystemMessage = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content,
      timestamp: Date.now() / 1000,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // ★ streaming 结束后自动发送 pending 消息（用户在流式进行中提交的中断续发）
  useEffect(() => {
    if (isStreaming) return;
    if (!pendingMessageRef.current) return;
    const pending = pendingMessageRef.current;
    pendingMessageRef.current = null;
    // 用 setTimeout(0) 确保在当前 React 批次渲染完成后再发，避免和 done 处理竞争
    setTimeout(() => {
      if (!isStreamingRef.current) {
        doSendRef.current(pending.content, pending.images);
      }
    }, 0);
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 核心发送逻辑（不含斜杠命令判断） ──
  const doSend = useCallback(
    (content: string, images?: ImageAttachment[]) => {
      if (isStreamingRef.current) return;
      if (needsMigrate) {
        // Backend is missing - show migrate prompt
        const sysMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `⚠️ **当前会话的后端已被删除**\n\n请点击右上角的 **Migrate** 按钮，选择一个新的后端继续对话。`,
          timestamp: Date.now() / 1000,
        };
        setMessages((prev) => [...prev, sysMsg]);
        return;
      }

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        images,
        timestamp: Date.now() / 1000,
      };
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now() / 1000,
        backendId,
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      // ★ 初始化全局流式状态（会自动清理之前的错误状态）
      initStreamMessage(sessionId, assistantId);

      // ★ 同步本地 refs
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current = [];
      contentBlocksRef.current = [];
      streamStartRef.current = Date.now();
      msgIdRef.current = assistantId;

      api.sendMessage({
        sessionId,
        content,
        images,
        backendId,
        messageId: assistantId,
        autoContinue: autoContinueRef.current,
        skipPermissions: skipPermissionsRef.current,
      });
    },
    [sessionId, backendId, needsMigrate]
  );

  // 稳定 ref 给命令处理器调用
  const doSendRef = useRef(doSend);
  doSendRef.current = doSend;
  const addSystemMessageRef = useRef(addSystemMessage);
  addSystemMessageRef.current = addSystemMessage;

  // ═══════════════════════════════════════
  //  ★ 斜杠命令处理器
  // ═══════════════════════════════════════
  const handleCommand = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const command = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
      const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

      const sys = (msg: string) => addSystemMessageRef.current(msg);

      switch (command) {
        // ── 帮助 ──
        case '/help':
          sys(HELP_TEXT);
          break;

        // ── 清空上下文（同 session，重置 agent 下游 session）──
        case '/new':
          if (onClearContext) {
            onClearContext();
          } else if (onNewSession) {
            onNewSession();  // 降级兼容
          } else {
            sys('⚠️ 无法清空上下文：未注册 onClearContext 回调。');
          }
          break;

        // ── 清空 ──
        case '/clear':
          setMessages([]);
          await api.executeCommand({ command: 'clear', sessionId, backendId });
          sys('🗑️ 对话已清空。');
          break;

        // ── 压缩 ──
        case '/compact': {
          const msgs = messagesRef.current;
          if (msgs.length <= 6) {
            sys('ℹ️ 消息数量较少，无需压缩。');
            break;
          }
          sys('⏳ 正在压缩对话...');
          const result = await api.executeCommand({
            command: 'compact',
            sessionId,
            backendId,
          });
          if (result?.status === 'ok') {
            // ★ 直接从后端重载消息，不依赖 sessionUpdated 事件
            const session = await api.loadSession(sessionId);
            if (session?.messages) {
              const reloaded = session.messages.map(normalizeMessage);
              // 追加一条系统消息告知用户
              const sysMsg: ChatMessage = {
                id: crypto.randomUUID(),
                role: 'system' as const,
                content: `✅ 已压缩 ${result.removed} 条早期消息，保留最近 ${result.remaining} 条。`,
                timestamp: Date.now() / 1000,
              };
              setMessages([...reloaded, sysMsg]);
            }
          } else {
            sys(`ℹ️ ${result?.message || '压缩未执行'}`);
          }
          break;
        }

        // ── 费用统计 ──
        case '/cost': {
          const msgs = messagesRef.current;
          let totalInput = 0;
          let totalOutput = 0;
          let countWithUsage = 0;
          msgs.forEach((m) => {
            if (m.usage) {
              totalInput += m.usage.inputTokens || 0;
              totalOutput += m.usage.outputTokens || 0;
              countWithUsage++;
            }
          });
          const total = totalInput + totalOutput;
          // 估算费用（以 Claude Sonnet 4 为例：input $3/M, output $15/M）
          const costInput = (totalInput / 1_000_000) * 3;
          const costOutput = (totalOutput / 1_000_000) * 15;
          const costTotal = costInput + costOutput;
          sys(
            `📊 **Token 用量统计**\n\n` +
            `| 方向 | Tokens | 估算费用 |\n` +
            `|------|--------|----------|\n` +
            `| ↑ 输入 | ${totalInput.toLocaleString()} | $${costInput.toFixed(4)} |\n` +
            `| ↓ 输出 | ${totalOutput.toLocaleString()} | $${costOutput.toFixed(4)} |\n` +
            `| **合计** | **${total.toLocaleString()}** | **$${costTotal.toFixed(4)}** |\n\n` +
            `_${countWithUsage} 条回复有用量数据。费用按 Sonnet 定价估算。_`
          );
          break;
        }

        // ── 状态 ──
        case '/status': {
          const msgs = messagesRef.current;
          const userCount = msgs.filter((m) => m.role === 'user').length;
          const assistantCount = msgs.filter((m) => m.role === 'assistant').length;
          sys(
            `📋 **会话状态**\n\n` +
            `- 会话 ID: \`${sessionId}\`\n` +
            `- 后端: \`${backendId}\`\n` +
            `- 消息数: ${msgs.length}（用户 ${userCount} / 助手 ${assistantCount}）\n` +
            `- 自动续跑: ${autoContinueRef.current ? '✅ 开启' : '❌ 关闭'}\n` +
            `- 流式状态: ${isStreamingRef.current ? '🔄 进行中' : '⏸️ 空闲'}`
          );
          break;
        }

        // ── 继续 ──
        case '/continue':
          if (isStreamingRef.current) {
            sys('⚠️ 当前正在响应中，请等待完成。');
            break;
          }
          doSendRef.current(
            'Continue exactly from where you left off. Do not repeat any content you already generated.'
          );
          break;

        // ── 自动续跑开关 ──
        case '/autocontinue': {
          const newVal = !autoContinueRef.current;
          setAutoContinue(newVal);
          sys(`⟳ 自动续跑已${newVal ? '**开启**' : '**关闭**'}。\n\n_开启后，当模型因 token 上限中断时会自动继续生成。_`);
          break;
        }

        // ── 模型信息 ──
        case '/model': {
          const backends = await api.getBackends();
          const current = backends.find((b: any) => b.id === backendId);
          if (current) {
            sys(
              `🤖 **当前模型**\n\n` +
              `- 后端: ${current.label}\n` +
              `- 模型: ${current.model || '默认'}\n` +
              `- 类型: ${current.type}`
            );
          } else {
            sys(`⚠️ 未找到后端配置: ${backendId}`);
          }
          break;
        }

        // ── 初始化项目 ──
        case '/init':
          if (isStreamingRef.current) {
            sys('⚠️ 当前正在响应中，请等待完成。');
            break;
          }
          sys('⏳ 正在让 Claude 分析项目并创建 CLAUDE.md...');
          doSendRef.current(
            'Please analyze this project directory thoroughly and create a CLAUDE.md file at the project root. ' +
            'The file should include: project overview, tech stack, directory structure, ' +
            'build/test/run commands, coding conventions, and any important notes for AI assistants working on this codebase. ' +
            'Use the available file tools to explore the project first, then write the file.'
          );
          break;

        // ── 显示配置 ──
        case '/config': {
          const backends = await api.getBackends();
          const current = backends.find((b: any) => b.id === backendId);
          sys(
            `⚙️ **当前配置**\n\n\`\`\`json\n${JSON.stringify(current || {}, null, 2)}\n\`\`\``
          );
          break;
        }

        // ── 未知命令 ──
        default:
          sys(`❓ 未知命令: \`${command}\`\n\n输入 \`/help\` 查看可用命令。`);
          break;
      }
    },
    [sessionId, backendId]
  );

  // ── 公开的 sendMessage（含斜杠命令拦截）──
  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      if (!content.trim() && (!images || images.length === 0)) return;

      if (isStreamingRef.current) {
        // ★ 流式进行中：斜杠命令不中断，普通消息入队并中止当前响应
        if (content.trim().startsWith('/')) return;
        pendingMessageRef.current = { content, images };
        api.abortMessage(sessionId);
        return;
      }

      // ★ 斜杠命令拦截
      if (content.trim().startsWith('/')) {
        await handleCommand(content);
        return;
      }

      doSend(content, images);
    },
    [doSend, handleCommand, sessionId]
  );

  const abort = useCallback(() => {
    // ★ 按 sessionId 停止，精确定位到当前 session，不影响其他并发 session
    pendingMessageRef.current = null; // 手动停止时清除 pending，不续发
    api.abortMessage(sessionId);
    setIsStreaming(false);
  }, [sessionId]);

  return {
    messages, isStreaming, sendMessage, abort, autoContinue, setAutoContinue,
    pendingPermission, clearPermission: () => setPendingPermission(null),
    needsMigrate,
  };
}
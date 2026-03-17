import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import type { ImageAttachment } from './useClipboardImage';

export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
  status: string;
  startTime?: number;  // ★ Track start time for duration calculation
  duration?: number;   // ★ Duration in milliseconds
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

  return { ...msg, thinking, ...(toolCalls !== undefined ? { toolCalls } : {}) };
}

export function useChat(sessionId: string, backendId: string, backends?: any[], skipPermissions: boolean = true) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [needsMigrate, setNeedsMigrate] = useState(false);

  // 累积器 refs
  const textRef = useRef('');
  const thinkingRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const msgIdRef = useRef<string | null>(null);

  // 稳定引用 refs
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  const autoContinueRef = useRef(true);
  autoContinueRef.current = autoContinue;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const skipPermissionsRef = useRef(skipPermissions);
  skipPermissionsRef.current = skipPermissions;

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
    api.loadSession(sessionId).then((session) => {
      if (session?.messages) {
        setMessages(session.messages.map(normalizeMessage));
      }
      if (session?.autoContinue !== undefined) {
        setAutoContinue(session.autoContinue);
      }
    });
    // ★ Reset streaming state when switching sessions
    setIsStreaming(false);
  }, [sessionId]);

  // ── sessionUpdated 监听（compact 等后端操作完成后重载）──
  useEffect(() => {
    return api.onSessionUpdated(async (data: any) => {
      if (data.sessionId !== sessionId) return;
      if (data.type === 'session_compacted') {
        const session = await api.loadSession(sessionId);
        if (session?.messages) {
          setMessages(session.messages.map(normalizeMessage));
        }
      }
    });
  }, [sessionId]);

  // ── 流式 delta 监听 ──
  useEffect(() => {
    return api.onStreamDelta((delta) => {
      if (delta.sessionId !== sessionId) return;
      const mid = delta.messageId;

      switch (delta.type) {
        case 'text_delta':
          textRef.current += delta.text || '';
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid ? { ...m, content: textRef.current, streaming: true } : m
            )
          );
          break;

        case 'thinking':
          thinkingRef.current += delta.text || '';
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid
                ? { ...m, thinking: thinkingRef.current, streaming: true }
                : m
            )
          );
          break;

        case 'tool_start': {
          const tc: ToolCall = {
            id: delta.toolCall?.id || '',
            name: delta.toolCall?.name || 'unknown',
            input: delta.toolCall?.input || '',
            status: 'running',
            startTime: Date.now(),
          };
          // 去重：同一 tool id 可能从 stream_event 和 AssistantMessage 各发一次
          const exists = tc.id && toolCallsRef.current.some((t) => t.id === tc.id);
          const newToolCalls = exists
            ? toolCallsRef.current.map((t) =>
                t.id === tc.id ? { ...t, input: tc.input || t.input } : t
              )
            : [...toolCallsRef.current, tc];
          toolCallsRef.current = newToolCalls;
          console.log('[useChat] tool_start:', { id: tc.id, name: tc.name, exists, toolCallsCount: newToolCalls.length });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid
                ? { ...m, toolCalls: newToolCalls, streaming: true }
                : m
            )
          );
          break;
        }

        case 'tool_input': {
          const inputDelta = delta.toolCall?.inputDelta || '';
          if (toolCallsRef.current.length > 0 && inputDelta) {
            const last = toolCallsRef.current[toolCallsRef.current.length - 1];
            last.input = (last.input || '') + inputDelta;
            const newToolCalls = [...toolCallsRef.current];
            toolCallsRef.current = newToolCalls;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === mid ? { ...m, toolCalls: newToolCalls } : m
              )
            );
          }
          break;
        }

        case 'tool_result': {
          const resultId = delta.toolCall?.id || '';
          const output = delta.toolCall?.output || '';
          const status = delta.toolCall?.status || 'done';
          console.log('[useChat] tool_result:', { resultId, status, toolCallsCount: toolCallsRef.current.length });

          let matched = false;
          let newToolCalls = toolCallsRef.current.map((tc) => {
            if (resultId && tc.id === resultId) {
              matched = true;
              const duration = tc.startTime ? Date.now() - tc.startTime : undefined;
              console.log('[useChat] tool matched by id:', { id: resultId, duration });
              return { ...tc, output, status, duration };
            }
            return tc;
          });

          // ★ Fallback：ID 匹配失败时更新最后一个 running 工具（防止 tool_use_id 属性名问题）
          if (!matched) {
            console.warn('[useChat] tool_result id not matched, falling back to last running tool');
            const lastRunningIdx = newToolCalls.reduceRight(
              (found, tc, i) => (found === -1 && tc.status === 'running' ? i : found),
              -1
            );
            if (lastRunningIdx >= 0) {
              const tc = newToolCalls[lastRunningIdx];
              const duration = tc.startTime ? Date.now() - tc.startTime : undefined;
              newToolCalls = [
                ...newToolCalls.slice(0, lastRunningIdx),
                { ...tc, output, status, duration },
                ...newToolCalls.slice(lastRunningIdx + 1),
              ];
            }
          }

          toolCallsRef.current = newToolCalls;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid ? { ...m, toolCalls: newToolCalls } : m
            )
          );
          break;
        }

        case 'tool_end':
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid
                ? {
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.name === delta.toolCall?.name
                        ? { ...tc, ...delta.toolCall }
                        : tc
                    ),
                  }
                : m
            )
          );
          break;

        case 'done': {
          // ★ 捕获快照，避免 setMessages 回调执行时 toolCallsRef 已被清空
          const now = Date.now();
          const finalToolCalls = toolCallsRef.current.map((tc) => {
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

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== mid) return m;
              // ★ 无论哪条路径，都确保 running → done
              // 当 toolCallsRef 被 error 事件清空时，直接修复 m.toolCalls 中残留的 running 状态
              const resolvedToolCalls = finalToolCalls.length > 0
                ? finalToolCalls
                : (m.toolCalls || []).map((tc) =>
                    tc.status === 'running'
                      ? { ...tc, status: 'done', output: tc.output || '(completed)' }
                      : tc
                  );
              return {
                ...m,
                streaming: false,
                toolCalls: resolvedToolCalls.length > 0 ? resolvedToolCalls : m.toolCalls,
                ...(delta.usage ? { usage: delta.usage } : {}),
              };
            })
          );
          setIsStreaming(false);
          textRef.current = '';
          thinkingRef.current = '';
          toolCallsRef.current = [];
          msgIdRef.current = null;
          break;
        }

        case 'error':
          setMessages((prev) =>
            prev.map((m) =>
              m.id === mid
                ? {
                    ...m,
                    content: textRef.current + `\n\n**Error:** ${delta.error}`,
                    streaming: false,
                  }
                : m
            )
          );
          setIsStreaming(false);
          textRef.current = '';
          thinkingRef.current = '';
          toolCallsRef.current = [];
          break;
      }
    });
  }, [sessionId]);

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
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current = [];
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
            // 后端会发 sessionUpdated 信号，useEffect 会自动重载
            sys(`✅ 已压缩 ${result.removed} 条早期消息。`);
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
      if (isStreamingRef.current) return;

      // ★ 斜杠命令拦截
      if (content.trim().startsWith('/')) {
        await handleCommand(content);
        return;
      }

      doSend(content, images);
    },
    [doSend, handleCommand]
  );

  const abort = useCallback(() => {
    api.abortMessage(backendId);
    setIsStreaming(false);
  }, [backendId]);

  return { messages, isStreaming, sendMessage, abort, autoContinue, setAutoContinue };
}
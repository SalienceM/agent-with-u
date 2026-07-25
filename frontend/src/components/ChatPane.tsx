import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { api } from '../api';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { PermissionGate } from './PermissionGate';
import { LoopPanel } from './LoopPanel';
import { SeqTaskPanel } from './SeqTaskPanel';
import type { SeqTaskT } from './SeqTaskPanel';
import { ByTheWayDrawer } from './ByTheWayDrawer';
import { useChat } from '../hooks/useChat';
import type { AppConfig } from '../hooks/useConfig';
import { HACKER_CAPTURE_EVENT } from '../utils/hackerMode';
import type { SmoothGhostState } from '../utils/smoothGhost';
import { normalizeModelRuntime, type ModelRuntime } from './CodexRuntimeFields';
import type { TextAttachment } from '../types/attachments';

// 注入「等待气泡」用的脉冲点动画(一次性)。请求发出后到首个 delta 之间,
// 旧版只靠底部「生成中」chip,聊天区空白让人怀疑后端是不是没收到;这里
// 在消息列表里挂一个占位气泡兜底反馈。
if (typeof document !== 'undefined' && !document.getElementById('awu-pending-bubble-css')) {
  const s = document.createElement('style');
  s.id = 'awu-pending-bubble-css';
  s.textContent = `
    @keyframes awu-pending-dot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
    .awu-pending-dot { display: inline-block; width: 6px; height: 6px; margin: 0 2px;
                       border-radius: 50%; background: currentColor;
                       animation: awu-pending-dot 1.4s infinite ease-in-out both; }
    .awu-pending-dot:nth-child(2) { animation-delay: 0.18s; }
    .awu-pending-dot:nth-child(3) { animation-delay: 0.36s; }
  `;
  document.head.appendChild(s);
}

const PendingAssistantBubble: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '4px 16px' }}>
    <div style={{
      maxWidth: '70%', padding: '10px 14px', borderRadius: 12,
      background: 'var(--theme-bg-secondary, rgba(255,255,255,0.04))',
      color: 'var(--theme-text-muted, #8b8b9b)',
      fontSize: 13, display: 'flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{ marginRight: 4 }}>已收到，等待响应</span>
      <span className="awu-pending-dot"></span>
      <span className="awu-pending-dot"></span>
      <span className="awu-pending-dot"></span>
    </div>
  </div>
);

// ChatPane: 自给自足的单 session 工作区。
// 每个 pane 内部:
//   1. 调用 useChat —— 独立的流式状态、消息列表、权限气泡
//   2. 维护自己的滚动状态(autoScroll / 跟踪最新按钮)
//   3. 历史分页:首次只加载最近若干条,顶部「↑ load earlier」按需翻页
//   4. 维护自己的 activeSession 详情 (workingDir / backendId / skipPermissions / sandboxEnabled)
//   5. 渲染消息列表 + 权限气泡 + ChatInput
//
// 多 pane 之间不直接通信;App 通过 onStreamingChange 回调聚合
// "哪些 session 在流式" 状态,用于侧边栏指示灯。

export interface ChatPaneProps {
  paneId: number;                           // 0/1/2/3, 用于 React key
  sessionId: string | null;                 // null = 空 pane
  isFocused: boolean;                       // 是否当前焦点 pane
  onFocus: () => void;                      // 点击 pane 时调用
  backends: any[];                          // 共享 backends 列表
  config: AppConfig;                        // 共享配置(fontSize, renderMarkdown)
  themeBorderFocused: string;               // 焦点边框色
  isMobile: boolean;
  onRequestNewSession: () => void;          // 用户在这个 pane 想新建 session 时
  onSessionDeleted?: (id: string) => void;  // 删除 session 后回调,清掉这个 pane
  // 系统级 toast / 错误提示(预留, 当前未使用)
  onToast?: (type: 'success' | 'error' | 'info', message: string) => void;
  // 流式状态变化回调,App 用来聚合所有 pane 的 streaming 状态
  onStreamingChange?: (sessionId: string, streaming: boolean) => void;
  onGhostStateChange?: (state: SmoothGhostState) => void;
  // 对话字号步进(全局 config.fontSize),由 App 注入
  onAdjustFontSize?: (delta: number) => void;
  // 全局工具(由 App 注入,放在输入框正上方,避免顶栏拥挤)
  layoutLabel?: string;
  onCycleLayout?: () => void;
  onOpenSync?: () => void;
}

export const ChatPane: React.FC<ChatPaneProps> = ({
  paneId,
  sessionId,
  isFocused,
  onFocus,
  backends,
  config,
  themeBorderFocused,
  isMobile,
  onRequestNewSession,
  onStreamingChange,
  onGhostStateChange,
  onAdjustFontSize,
  layoutLabel,
  onCycleLayout,
  onOpenSync,
}) => {
  // ── pane 自己的 session 详情(workingDir / backendId / skip / sandbox) ──
  const [activeSession, setActiveSession] = useState<any | null>(null);
  const [nodeBackends, setNodeBackends] = useState<any[]>(backends);
  const [loopControlMode, setLoopControlMode] = useState<'loop' | 'manual'>('loop');
  const [loopSwitchBusy, setLoopSwitchBusy] = useState(false);
  // 权限 state: 初值从 session 读,变化时持久化
  const [skipPermissions, setSkipPermissions] = useState(true);
  // 可见消息条数(切换 session / 切回历史时只显示最近几条)
  // visibleCount 已废:历史分页由后端 + chat.loadEarlier() 控制,前端不再折叠

  // 滚动相关 refs (与 App 原有一致)
  const endRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevStreamingRef = useRef(false);
  const animSessionRef = useRef<string | null>(null);
  const animMsgCountRef = useRef(0);
  const prevSessionRef = useRef<string | null>(sessionId);

  // 加载 session 详情(切换 sessionId 时重新拉)
  useEffect(() => {
    if (!sessionId) {
      setActiveSession(null);
      return;
    }
    // 切换 session 时仅拉元数据(workingDir / backendId / skipPermissions 等),
    // 历史消息由内部 useChat 走 INITIAL_LOAD_LIMIT 分页加载,不要在这再拉一次
    // 全量,否则等于白费一次大 RPC。
    let cancelled = false;
    api.loadSession(sessionId, 1).then((session) => {
      if (cancelled) return;
      setActiveSession(session);
      if (session?.skipPermissions !== undefined) {
        setSkipPermissions(session.skipPermissions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // A LOOP session keeps its identity; only its current owner changes between
  // the automated panel and the ordinary-chat manual takeover surface.
  useEffect(() => {
    if (!sessionId || activeSession?.sessionType !== 'loop') {
      setLoopControlMode('loop');
      return;
    }
    let cancelled = false;
    api.loopGetState(sessionId).then((state) => {
      if (!cancelled) setLoopControlMode(state?.controlMode === 'manual' ? 'manual' : 'loop');
    });
    const unsubscribe = api.onLoopUpdated((state: any) => {
      if (state?.sessionId === sessionId) {
        setLoopControlMode(state.controlMode === 'manual' ? 'manual' : 'loop');
      }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [sessionId, activeSession?.sessionType]);

  // Backend configuration belongs to the executor that owns the session.
  useEffect(() => {
    const execKey = activeSession?.execKey;
    if (!execKey) {
      setNodeBackends(backends);
      return;
    }
    let cancelled = false;
    setNodeBackends([]);
    api.getBackends(execKey)
      .then((list) => { if (!cancelled) setNodeBackends(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setNodeBackends([]); });
    return () => { cancelled = true; };
  }, [activeSession?.execKey, backends]);

  const effectiveBackends = activeSession?.execKey ? nodeBackends : backends;
  const activeBackendId = activeSession?.backendId || effectiveBackends[0]?.id || '';

  const handleSessionRuntimeChange = useCallback(async (runtime: ModelRuntime) => {
    if (!sessionId) return { status: 'error', message: 'Session 不存在' };
    const normalized = normalizeModelRuntime(runtime);
    const result = await api.updateSessionRuntime(sessionId, normalized);
    if (result.status === 'ok') {
      const applied = result.runtime || normalized;
      setActiveSession((current: any) => current ? {
        ...current,
        modelOverride: applied.model,
        reasoningEffort: applied.reasoningEffort,
      } : current);
    }
    return result;
  }, [sessionId]);

  // ── /new 命令处理:复用 workingDir + backendId,免弹窗静默新建 ──
  // 注意:静默新建会切换当前 pane 的 session,需要走 onRequestNewSession 上抛
  // 让 App 决定如何处理。这里简化处理:直接打开新建对话框。
  const handleQuickNewSession = useCallback(async () => {
    onRequestNewSession();
  }, [onRequestNewSession]);

  const handleClearContext = useCallback(async () => {
    if (!sessionId) return;
    await api.clearSessionContext(sessionId);
  }, [sessionId]);

  // ── 核心 useChat 调用 ──
  const chat = useChat(
    sessionId || '',
    activeBackendId,
    effectiveBackends,
    skipPermissions,
    handleQuickNewSession,
    handleClearContext,
    {
      modelOverride: activeSession?.modelOverride,
      reasoningEffort: activeSession?.reasoningEffort,
    },
  );

  // ── 向 App 上报流式状态,用于侧边栏指示灯 ──
  useEffect(() => {
    if (!sessionId || chat.resolvedSessionId !== sessionId) return;
    onStreamingChange?.(sessionId, chat.isStreaming);
  }, [sessionId, chat.isStreaming, chat.resolvedSessionId, onStreamingChange]);

  // ── 序列任务队列 + by-the-way（普通 session 侧挂状态）──
  const [seqTasks, setSeqTasks] = useState<SeqTaskT[]>([]);
  const [byTheWayOpen, setByTheWayOpen] = useState(false);
  const dispatchingRef = useRef(false);
  const seqRetryTimerRef = useRef<number | null>(null);
  const dispatchNextRef = useRef<() => void>(() => {});
  const seqPendingRef = useRef(false);
  // 新输入在模型忙碌时会自动排队并激活本轮连续派发。应用重启后保留的
  // 历史队列不会擅自恢复，需要用户在队列条上点一次继续。
  const [seqChainActive, setSeqChainActive] = useState(false);
  const seqChainSessionRef = useRef<string | null>(null);
  const setChain = useCallback((v: boolean) => { setSeqChainActive(v); }, []);

  useEffect(() => {
    let cancelled = false;
    if (seqRetryTimerRef.current !== null) {
      window.clearTimeout(seqRetryTimerRef.current);
      seqRetryTimerRef.current = null;
    }
    seqChainSessionRef.current = null;
    setChain(false);
    if (!sessionId) { setSeqTasks([]); return; }
    api.seqtaskGet(sessionId).then((r) => {
      if (!cancelled && r.status === 'ok') setSeqTasks(r.seqTasks || []);
    });
    const unsubscribe = api.onSeqtaskUpdated((data) => {
      if (data.sessionId !== sessionId) return;
      setSeqTasks(data.seqTasks || []);
    });
    return () => {
      cancelled = true;
      if (seqRetryTimerRef.current !== null) {
        window.clearTimeout(seqRetryTimerRef.current);
        seqRetryTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [sessionId, setChain]);

  // 取队首待发任务，派发进主对话（doSend 跳过斜杠命令拦截 + 自带 isStreaming 守卫）
  // ★ 用 ref 持有 chat 方法，避免 chat 对象每 render 换新导致 dispatchNext 被频繁重建、
  //   auto-dispatch effect 不断清除/重建 timeout 引发的竞态：seqtaskUpdated 事件触发
  //   re-render 时 dispatchNext 正在 await 中，旧的 chat 闭包可能持有过期的 isStreaming
  //   或 doSend 引用，造成 setMessages(userMsg) 被跳过或被后续 loadSession 覆盖。
  const isStreamingRef = useRef(chat.isStreaming);
  isStreamingRef.current = chat.isStreaming;
  const doSendRef = useRef(chat.doSend);
  doSendRef.current = chat.doSend;
  const sendMessageRef = useRef(chat.sendMessage);
  sendMessageRef.current = chat.sendMessage;
  seqPendingRef.current = seqTasks.some((task) => task.status === 'pending');

  // Smooth 顺滑问答只投递到最后聚焦的 pane。若当前回答尚未结束，先在
  // 内存中排队，等 done 边缘再发送，避免打断培训录屏中的现有回答。
  const hackerPendingRef = useRef<Array<{ prompt: string; image: any }>>([]);
  useEffect(() => {
    const onCapture = (event: Event) => {
      if (!isFocused || !sessionId) return;
      const detail = (event as CustomEvent<{ prompt?: string; image?: any }>).detail;
      if (!detail?.image) return;
      const task = { prompt: detail.prompt?.trim() || '请分析这张截图。', image: detail.image };
      if (isStreamingRef.current) hackerPendingRef.current.push(task);
      else doSendRef.current(task.prompt, [task.image]);
    };
    window.addEventListener(HACKER_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(HACKER_CAPTURE_EVENT, onCapture);
  }, [isFocused, sessionId]);

  useEffect(() => {
    if (chat.isStreaming || !sessionId || !isFocused) return;
    const next = hackerPendingRef.current.shift();
    if (next) doSendRef.current(next.prompt, [next.image]);
  }, [chat.isStreaming, isFocused, sessionId]);

  const dispatchNext = useCallback(async () => {
    if (!sessionId || dispatchingRef.current || isStreamingRef.current) return;
    seqChainSessionRef.current = sessionId;
    setChain(true);   // 主动派发即激活连发链（▶按钮也走这里，可续上被打断的链）
    dispatchingRef.current = true;
    try {
      const r = await api.seqtaskTakeNext(sessionId);
      if (r.status === 'ok' && r.task) {
        const imgs = r.task.images && r.task.images.length ? r.task.images : undefined;
        const textAttachments = r.task.textAttachments && r.task.textAttachments.length
          ? r.task.textAttachments
          : undefined;
        const text = r.task.text || '';
        // 以 / 开头的条目当作斜杠命令处理（/compact、/clear 等可排进队列）；
        // 其余走原始发送，绕过命令拦截。
        // ★ 通过 ref 调用，始终拿到最新的函数引用，不受闭包陈旧影响
        if (text.trim().startsWith('/') && !textAttachments?.length) {
          await sendMessageRef.current(text, imgs, textAttachments);
        } else {
          // React state 要到下一次 render 才会回写这个 ref；先同步占位，封住
          // seqtaskUpdated 与 setIsStreaming(true) 之间的同帧二次派发窗口。
          isStreamingRef.current = true;
          doSendRef.current(text, imgs, textAttachments);
        }
      } else if (seqPendingRef.current) {
        // done 帧会略早于后端任务清理/落盘；Relay 断线时 RPC 也可能暂不可用。
        // 队首保持 pending，短暂轮询权威 busy 状态，不把“取不到”当成已完成。
        const delay = Math.max(250, Math.min(Number(r.retryAfterMs) || 1000, 3000));
        if (seqRetryTimerRef.current === null) {
          seqRetryTimerRef.current = window.setTimeout(() => {
            seqRetryTimerRef.current = null;
            if (seqChainSessionRef.current === sessionId && seqPendingRef.current) {
              dispatchNextRef.current();
            }
          }, delay);
        }
      }
    } finally {
      dispatchingRef.current = false;
    }
  }, [sessionId]); // ★ 不再依赖 chat 对象，dispatchNext 稳定不变
  dispatchNextRef.current = dispatchNext;

  // 空闲时的第一条输入直接发送。
  const handleUserSend = useCallback((
    content: string,
    images?: any[],
    textAttachments?: TextAttachment[],
  ) => {
    return sendMessageRef.current(content, images, textAttachments);
  }, []); // ★ 通过 ref 调用，无需依赖 chat

  // 模型忙碌时 ChatInput 会把后续输入送到这里；无需显式开启模式。
  const handleQueueTask = useCallback((
    content: string,
    images?: any[],
    textAttachments?: TextAttachment[],
  ) => {
    if (!sessionId) return;
    const text = (content || '').trim();
    if (!text && !(images && images.length) && !textAttachments?.length) return;
    seqChainSessionRef.current = sessionId;
    setChain(true);
    api.seqtaskAdd(
      sessionId,
      text,
      images && images.length ? images : undefined,
      textAttachments?.length ? textAttachments : undefined,
    );
  }, [sessionId, setChain]);

  // 当前回答结束后自动取队首；dispatchNext 使用稳定 ref，并由 dispatchingRef
  // 防止流状态与队列事件同时到达造成重复派发。
  useEffect(() => {
    if (!seqChainActive || seqChainSessionRef.current !== sessionId || chat.isStreaming || isStreamingRef.current) return;
    if (!seqTasks.some((t) => t.status === 'pending')) return;
    dispatchNext();
  }, [chat.isStreaming, seqChainActive, seqTasks, dispatchNext, sessionId]);

  // ── 持久化 skipPermissions ──
  const handleSkipPermissionsChange = useCallback(
    (enabled: boolean) => {
      setSkipPermissions(enabled);
      if (sessionId) {
        api.executeCommand({
          command: 'set_skip_permissions',
          sessionId,
          backendId: activeBackendId,
          args: { enabled },
        });
      }
    },
    [sessionId, activeBackendId],
  );

  const handleCompact = useCallback(() => {
    handleClearContext();
  }, [handleClearContext]);

  // ── 全部消息直接渲染。
  //   早先版本用 visibleCount 在前端折叠成最近 N 条,但那只是「不渲染」,
  //   loadSession 仍然把全部消息塞过来——session 大 + 远程经中继时,首屏延迟
  //   完全没解。现在改成后端分页:首次只拉 INITIAL_LOAD_LIMIT 条,UI 上靠
  //   chat.hasMore + chat.loadEarlier() 按需翻页加载更老的内容。
  const visibleMessages = useMemo(() => {
    return {
      list: chat.messages,
      hiddenCount: 0,
      total: chat.messages.length,
    };
  }, [chat.messages]);

  // Native ghost receives a bounded tail of the loaded conversation. Building
  // from the end keeps the newest turns complete while avoiding oversized IPC
  // payloads during token streaming.
  const ghostHistoryText = useMemo(() => {
    const maxChars = 48_000;
    const chunks: string[] = [];
    let used = 0;
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const message = chat.messages[index];
      if ((message.role !== 'user' && message.role !== 'assistant') || !message.content?.trim()) continue;
      const label = message.role === 'user' ? '你' : 'AgentWithU';
      let chunk = `${label}：\n${message.content.trim()}`;
      const remaining = maxChars - used;
      if (remaining <= 0) break;
      if (chunk.length > remaining) chunk = `…${chunk.slice(chunk.length - remaining + 1)}`;
      chunks.unshift(chunk);
      used += chunk.length + 2;
      if (used >= maxChars) break;
    }
    return chunks.join('\n\n');
  }, [chat.messages]);

  // The ghost window receives only the focused pane's concise latest state.
  // This callback is throttled by App before crossing the Tauri window boundary.
  useEffect(() => {
    if (!isFocused || !sessionId || !onGhostStateChange) return;
    let lastUserIndex = -1;
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      if (chat.messages[index].role === 'user') { lastUserIndex = index; break; }
    }
    const lastUser = lastUserIndex >= 0 ? chat.messages[lastUserIndex] : undefined;
    let lastAssistant;
    for (let index = chat.messages.length - 1; index > lastUserIndex; index -= 1) {
      if (chat.messages[index].role === 'assistant') { lastAssistant = chat.messages[index]; break; }
    }
    const backend = effectiveBackends.find((item) => item.id === activeBackendId);
    onGhostStateChange({
      sessionId,
      sessionTitle: activeSession?.title || activeSession?.name || 'AgentWithU',
      backendLabel: backend?.label || backend?.name || activeBackendId || '',
      question: lastUser?.content || '',
      answer: lastAssistant?.content || '',
      historyText: ghostHistoryText,
      isStreaming: chat.isStreaming,
      updatedAt: Date.now(),
    });
  }, [isFocused, sessionId, chat.messages, chat.isStreaming, activeSession, activeBackendId, effectiveBackends, ghostHistoryText, onGhostStateChange]);

  // ── 自动滚到底部 ──
  useLayoutEffect(() => {
    const switched = prevSessionRef.current !== sessionId;
    prevSessionRef.current = sessionId;
    if (switched) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    const awaitingHydration = chat.hydratedSessionId !== sessionId;
    if (!autoScrollRef.current && !awaitingHydration) return;
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    else endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [chat.messages, chat.hydratedSessionId, sessionId]);

  // ── 新交互开始时重置跟踪 ──
  useEffect(() => {
    if (chat.isStreaming && !prevStreamingRef.current) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    prevStreamingRef.current = chat.isStreaming;
  }, [chat.isStreaming]);

  // ── 滚动事件:用户向上滚则暂停跟踪 ──
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    if (atBottom) {
      if (!autoScrollRef.current) {
        autoScrollRef.current = true;
        setShowScrollBtn(false);
      }
    } else {
      if (autoScrollRef.current) {
        autoScrollRef.current = false;
        setShowScrollBtn(true);
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    else endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);

  // 空 pane 占位
  if (!sessionId) {
    return (
      <div
        onClick={onFocus}
        style={{
          ...paneRootStyle,
          border: isFocused ? `2px solid ${themeBorderFocused}` : '2px solid var(--theme-border)',
          // 不设 bg:分屏前 chat 区域没这层 wrapper,背景图能直接透到消息气泡那层。
          // 加个实色就等于盖一层遮罩,把用户的壁纸糊死。focus 边框已经够明显了。
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 8,
            color: 'var(--theme-text-muted)',
            fontSize: 13,
            userSelect: 'none',
          }}
        >
          <div style={{ fontSize: 28, opacity: 0.5 }}>＋</div>
          <div>点击侧边栏选择会话</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Pane #{paneId + 1}</div>
        </div>
      </div>
    );
  }

  // ★ Loop 会话：直接把 LoopPanel 作为这个 pane 的内容内嵌渲染（不是浮层，
  //   也没有自由聊天框）—— loop 的全部交互都在面板内（含 By the way 旁路问答），
  //   避免「聊天框 vs 面板」双入口、以及聊天与 loop 主线共用 agent 上下文的污染。
  if (activeSession?.sessionType === 'loop' && loopControlMode !== 'manual') {
    return (
      <div
        onClick={onFocus}
        style={{
          ...paneRootStyle,
          border: isFocused ? `2px solid ${themeBorderFocused}` : '2px solid var(--theme-border)',
          background: 'transparent',
        }}
      >
        <LoopPanel
          sessionId={sessionId}
          embedded
          sessionBackendId={activeBackendId}
          sessionRuntime={{
            model: activeSession?.modelOverride,
            reasoningEffort: activeSession?.reasoningEffort,
          }}
          backends={effectiveBackends}
        />
      </div>
    );
  }

  // 入场动画:只给真正新增的最后一条消息播,切换 session 时全部不播
  const { list: msgList, hiddenCount, total } = visibleMessages;
  const isSameSession = animSessionRef.current === sessionId;
  const prevCount = isSameSession ? animMsgCountRef.current : total;
  animSessionRef.current = sessionId;
  animMsgCountRef.current = total;

  return (
    <div
      onClick={onFocus}
      style={{
        ...paneRootStyle,
        border: isFocused ? `2px solid ${themeBorderFocused}` : '2px solid var(--theme-border)',
        // 同上,透明,不挡背景图
        background: 'transparent',
      }}
    >
      {activeSession?.sessionType === 'loop' && loopControlMode === 'manual' && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', background: '#d2992218', borderBottom: '1px solid #d2992255',
          color: 'var(--theme-text)', fontSize: 12,
        }}>
          <span style={{ color: '#d29922', fontWeight: 700 }}>✋ Manual LOOP · 人工接管中</span>
          <span style={{ color: 'var(--theme-text-muted)' }}>对话、工具调用和文件操作会记录为一轮人工 LOOP。</span>
          <div style={{ flex: 1 }} />
          <button
            disabled={chat.isStreaming || loopSwitchBusy || seqTasks.some((task) => task.status === 'pending')}
            onClick={async () => {
              if (chat.isStreaming || loopSwitchBusy) return;
              setLoopSwitchBusy(true);
              const result = await api.loopRelease(sessionId);
              setLoopSwitchBusy(false);
              if (result.status !== 'ok' && result.message) alert(result.message);
            }}
            style={{
              border: '1px solid #d2992266', borderRadius: 7, padding: '5px 10px',
              background: '#d2992222', color: '#d29922',
              cursor: chat.isStreaming ? 'not-allowed' : 'pointer',
              opacity: (chat.isStreaming || loopSwitchBusy || seqTasks.some((task) => task.status === 'pending')) ? 0.55 : 1, whiteSpace: 'nowrap',
            }}
            title={chat.isStreaming ? '回答结束后才能交还 LOOP' : seqTasks.some((task) => task.status === 'pending') ? '请先执行完或清空序列任务' : '封存人工操作并返回 LOOP 面板'}
          >
            {loopSwitchBusy ? '交还中…' : '↩ 交还 LOOP'}
          </button>
        </div>
      )}
      {/* ---- 消息列表 ---- */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{ height: '100%', overflow: 'auto', padding: '12px 0' }}
        >
          {chat.messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 10,
              }}
            >
              {chat.isLoadingSession ? (
                <>
                  <div style={{
                    width: 24, height: 24,
                    border: '2px solid var(--theme-border, rgba(255,255,255,0.15))',
                    borderTopColor: 'var(--theme-accent, #58a6ff)',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                  <div style={{ fontSize: 12, color: 'var(--theme-text-muted, #8c959f)' }}>
                    加载会话中…
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--theme-text-muted, #8c959f)' }}>
                    {activeSession?.title || `Pane #${paneId + 1}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text-muted, #8c959f)' }}>
                    Ctrl+V 粘贴图片 · 输入消息开始
                  </div>
                </>
              )}
            </div>
          )}

          {/* 顶部「正在刷新」细条:加载完成前/有缓存先铺底的场景,给用户一个
              「不是卡死,后台在拉」的视觉反馈 */}
          {chat.isLoadingSession && chat.messages.length > 0 && (
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8, padding: '6px 12px', fontSize: 11,
                color: 'var(--theme-text-muted, #8c959f)',
              }}
            >
              <span style={{
                width: 12, height: 12,
                border: '2px solid var(--theme-border, rgba(255,255,255,0.15))',
                borderTopColor: 'var(--theme-accent, #58a6ff)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
              <span>加载历史中…</span>
            </div>
          )}

          {chat.hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px' }}>
              <button
                onClick={() => chat.loadEarlier()}
                disabled={chat.loadingEarlier}
                style={{
                  padding: '6px 16px',
                  borderRadius: 16,
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  background: 'var(--theme-bg-secondary, #f6f8fa)',
                  color: 'var(--theme-text-muted, #656d76)',
                  fontSize: 12,
                  cursor: chat.loadingEarlier ? 'wait' : 'pointer',
                  opacity: chat.loadingEarlier ? 0.6 : 1,
                }}
              >
                {chat.loadingEarlier
                  ? '加载中…'
                  : `↑ 加载更早的消息 (剩余 ${Math.max(0, chat.messagesTotal - chat.messages.filter((m) => !m.streaming).length)} 条)`}
              </button>
            </div>
          )}

          {msgList.map((msg, idx) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              fontSize={config.fontSize}
              renderMarkdown={config.renderMarkdown}
              animateIn={isSameSession && hiddenCount + idx >= prevCount}
              sessionId={sessionId}
              canBranch={activeSession?.sessionType !== 'loop'}
              ttsVoice={config.ttsVoice}
              ttsRate={config.ttsRate}
            />
          ))}

          {/* 已发出但首个 delta 还没到 —— 在消息流里给个占位气泡,
              否则只看底部「生成中」chip,容易以为后端没收到。 */}
          {chat.isStreaming && !chat.messages.some((m: any) => m.role === 'assistant' && m.streaming) && (
            <PendingAssistantBubble />
          )}

          {/* ★ 行内权限确认组件 */}
          {chat.pendingPermission && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
                padding: '4px 16px',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: 'var(--theme-accent, #7aa2f7)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  color: '#fff',
                  fontWeight: 700,
                  marginRight: 8,
                  marginTop: 2,
                }}
              >
                A
              </div>
              <div
                style={{
                  maxWidth: '80%',
                  minWidth: 280,
                  borderRadius: '12px 12px 12px 4px',
                  background: 'var(--theme-message-bg, #f6f8fa)',
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  overflow: 'hidden',
                }}
              >
                <PermissionGate
                  request={chat.pendingPermission}
                  onDismiss={chat.clearPermission}
                  onSkipRest={() => setSkipPermissions(true)}
                />
              </div>
            </div>
          )}

          {/* 底部占位符 */}
          <div ref={endRef} />
        </div>

        {/* ★ 跟踪暂停时的浮动提示按钮 */}
        {showScrollBtn && (
          <div
            style={{
              position: 'absolute',
              bottom: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 50,
            }}
          >
            <button
              onClick={scrollToBottom}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 20,
                border: '1px solid var(--theme-border, rgba(0,0,0,0.18))',
                background: 'var(--theme-bg-tertiary, #242536)',
                color: 'var(--theme-text, #e2e3ea)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
                whiteSpace: 'nowrap',
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              跟踪最新
            </button>
          </div>
        )}
      </div>

      {/* ---- 全局工具栏(输入框正上方,被 App 从顶栏挪下来,避免那一排太挤) ----
           目录同步已重做为侧栏「🗂 文件」视图(本地 ⇄ 远端目录树),此处不再放入口。
           移动端隐藏分屏布局按钮(单屏无意义,省下这一排)。 */}
      {onCycleLayout && !isMobile && (
        <div style={{
          display: 'flex',
          gap: 6,
          padding: '4px 10px 0',
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={onCycleLayout}
            title="分屏布局 (1×1 / 1×2 / 2×2)"
            style={paneToolBtnStyle}
          >
            ▦ {layoutLabel || ''}
          </button>
        </div>
      )}

      {/* ---- 有待发任务时显示 slim 队列条；输入框无需显式切换模式 ---- */}
      {sessionId && seqTasks.some((t) => t.status === 'pending') && (
        <SeqTaskPanel
          sessionId={sessionId}
          tasks={seqTasks}
          chainActive={seqChainActive}
          isStreaming={chat.isStreaming}
          onSendNext={dispatchNext}
        />
      )}

      {/* ---- 输入栏 ---- */}
      <ChatInput
        onSend={handleUserSend}
        onAbort={chat.abort}
        isStreaming={chat.isStreaming}
        backends={effectiveBackends}
        activeBackendId={activeBackendId}
        sessionId={sessionId || undefined}
        workingDir={activeSession?.workingDir || undefined}
        skipPermissions={skipPermissions}
        onSkipPermissionsChange={handleSkipPermissionsChange}
        isMobile={isMobile}
        onQueueTask={handleQueueTask}
        seqCount={seqTasks.filter((t) => t.status === 'pending').length}
        onCompact={handleCompact}
        fontSize={config.fontSize}
        onAdjustFontSize={onAdjustFontSize}
        isFocused={isFocused}
        execKey={activeSession?.execKey}
        execMode={activeSession?.execMode}
        sessionRuntime={{
          model: activeSession?.modelOverride,
          reasoningEffort: activeSession?.reasoningEffort,
        }}
        onSessionRuntimeChange={handleSessionRuntimeChange}
      />

      {/* ---- By the way 旁路问答：浮动入口 + 抽屉 ---- */}
      {sessionId && (
        <>
          <button
            onClick={() => setByTheWayOpen(true)}
            title="By the way · 旁路问答（独立上下文，不污染主对话）"
            style={byTheWayFab}
          >💬</button>
          <ByTheWayDrawer sessionId={sessionId} open={byTheWayOpen} onClose={() => setByTheWayOpen(false)}
            backends={effectiveBackends}
            onSendToChat={(text) => { if (!isStreamingRef.current) doSendRef.current(text); }} />
        </>
      )}

    </div>
  );
};
// isMobile 当前未在 pane 内特殊处理(响应式由内部子组件自己处理),保留 prop 备用

const paneRootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
  position: 'relative',   // ★ 供 by-the-way 抽屉 overlay 定位
};

const byTheWayFab: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 12,
  zIndex: 20,
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)',
  color: 'var(--theme-text)',
  fontSize: 15,
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
};

const paneToolBtnStyle: React.CSSProperties = {
  padding: '3px 9px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
  background: 'var(--theme-bg, rgba(255,255,255,0.06))',
  color: 'var(--theme-text-muted, #aaa)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
};

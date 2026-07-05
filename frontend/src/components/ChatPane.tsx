import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { api } from '../api';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { PermissionGate } from './PermissionGate';
import { LoopPanel } from './LoopPanel';
import { SeqTaskPanel } from './SeqTaskPanel';
import type { SeqTaskT } from './SeqTaskPanel';
import { ByTheWayDrawer } from './ByTheWayDrawer';
import { GitPanel } from './GitPanel';
import { useChat } from '../hooks/useChat';
import type { AppConfig } from '../hooks/useConfig';

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
  onAdjustFontSize,
  layoutLabel,
  onCycleLayout,
  onOpenSync,
}) => {
  // ── pane 自己的 session 详情(workingDir / backendId / skip / sandbox) ──
  const [activeSession, setActiveSession] = useState<any | null>(null);
  // 权限 state: 初值从 session 读,变化时持久化
  const [skipPermissions, setSkipPermissions] = useState(true);
  // Git 面板
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
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

  // 后端 ID:从 session 拿,fallback 到 backends[0]
  const activeBackendId = activeSession?.backendId || backends[0]?.id || '';

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
    backends,
    skipPermissions,
    handleQuickNewSession,
    handleClearContext,
  );

  // ── 向 App 上报流式状态,用于侧边栏指示灯 ──
  useEffect(() => {
    if (!sessionId) return;
    onStreamingChange?.(sessionId, chat.isStreaming);
  }, [sessionId, chat.isStreaming, onStreamingChange]);

  // ── 序列任务队列 + by-the-way（普通 session 侧挂状态）──
  const [seqTasks, setSeqTasks] = useState<SeqTaskT[]>([]);
  const [seqAuto, setSeqAuto] = useState(false);
  const [seqMode, setSeqMode] = useState(false);   // 输入框「序列模式」：回车排入队列而非直接发送
  const [byTheWayOpen, setByTheWayOpen] = useState(false);
  const dispatchingRef = useRef(false);
  // ★ auto 连发的「链激活」标志：派发队列任务 / auto 从关→开 时激活；
  //   用户手插一条消息会让它失效（接管），从而不触发后续自动连发。
  const seqChainRef = useRef(false);
  const prevAutoRef = useRef(false);
  // state 镜像，仅供面板显示「连发中 / 已暂停」；逻辑判定一律读 ref（避免闭包过期）
  const [seqChainActive, setSeqChainActive] = useState(false);
  const setChain = useCallback((v: boolean) => { seqChainRef.current = v; setSeqChainActive(v); }, []);

  useEffect(() => {
    if (!sessionId) { setSeqTasks([]); setSeqAuto(false); return; }
    api.seqtaskGet(sessionId).then((r) => {
      if (r.status === 'ok') { setSeqTasks(r.seqTasks || []); setSeqAuto(!!r.seqAuto); }
    });
    return api.onSeqtaskUpdated((data) => {
      if (data.sessionId !== sessionId) return;
      setSeqTasks(data.seqTasks || []);
      setSeqAuto(!!data.seqAuto);
    });
  }, [sessionId]);

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

  const dispatchNext = useCallback(async () => {
    if (!sessionId || dispatchingRef.current || isStreamingRef.current) return;
    setChain(true);   // 主动派发即激活连发链（▶按钮也走这里，可续上被打断的链）
    dispatchingRef.current = true;
    try {
      const r = await api.seqtaskTakeNext(sessionId);
      if (r.status === 'ok' && r.task) {
        const imgs = r.task.images && r.task.images.length ? r.task.images : undefined;
        const text = r.task.text || '';
        // 以 / 开头的条目当作斜杠命令处理（/compact、/clear 等可排进队列）；
        // 其余走原始发送，绕过命令拦截。
        // ★ 通过 ref 调用，始终拿到最新的函数引用，不受闭包陈旧影响
        if (text.trim().startsWith('/')) sendMessageRef.current(text, imgs);
        else doSendRef.current(text, imgs);
      }
    } finally {
      dispatchingRef.current = false;
    }
  }, [sessionId]); // ★ 不再依赖 chat 对象，dispatchNext 稳定不变

  // auto 关→开 时激活连发链（关掉则失活）。auto 已是开的情况下加载/收到同步
  //   不算「关→开」，链保持失活，需用户点 ▶ 或手动重新开关来启动 —— 避免刷新即自动猛发。
  useEffect(() => {
    const was = prevAutoRef.current;
    prevAutoRef.current = seqAuto;
    if (seqAuto && !was) setChain(true);
    if (!seqAuto) setChain(false);
  }, [seqAuto]);

  // 用户手动发消息（ChatInput 来的）即接管，断开连发链：这条答完不会自动发下一条。
  const handleUserSend = useCallback((content: string, images?: any[]) => {
    setChain(false);
    return sendMessageRef.current(content, images);
  }, []); // ★ 通过 ref 调用，无需依赖 chat

  // 序列模式：输入框回车把内容排入队列（不进对话）。auto 开时会自动开始连发。
  const handleQueueTask = useCallback((content: string, images?: any[]) => {
    if (!sessionId) return;
    const text = (content || '').trim();
    if (!text && !(images && images.length)) return;
    api.seqtaskAdd(sessionId, text, images && images.length ? images : undefined);
  }, [sessionId]);

  // 自动连发：链激活 + auto 开 + 非流式 + 有待发任务 → 发下一条（一条答完 effect 再触发下一条）
  // ★ 通过 isStreamingRef 读取最新流式状态，避免 chat.isStreaming 闭包陈旧
  // ★ v2: 移除 setTimeout，直接调用 dispatchNext。dispatchNext 内部的 await
  //    会自然让出控制权给 React 处理 pending 的 setSeqTasks 更新，避免 80ms
  //    延迟在某些时序下导致 setMessages(用户消息) 被后续流式更新覆盖。
  useEffect(() => {
    if (!seqAuto || isStreamingRef.current || !seqChainRef.current) return;
    if (!seqTasks.some((t) => t.status === 'pending')) return;
    dispatchNext();
  }, [seqAuto, seqTasks, dispatchNext]); // ★ 移除 chat.isStreaming，改读 ref

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

  // ── 自动滚到底部 ──
  useEffect(() => {
    const switched = prevSessionRef.current !== sessionId;
    prevSessionRef.current = sessionId;
    if (switched) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    if (!autoScrollRef.current) return;
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: switched ? 'instant' : 'smooth' });
    });
  }, [chat.messages, sessionId]);

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
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
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
  if (activeSession?.sessionType === 'loop') {
    return (
      <div
        onClick={onFocus}
        style={{
          ...paneRootStyle,
          border: isFocused ? `2px solid ${themeBorderFocused}` : '2px solid var(--theme-border)',
          background: 'transparent',
        }}
      >
        <LoopPanel sessionId={sessionId} embedded />
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

      {/* ---- 序列任务队列：仅在「序列模式」或队列非空时显示的一条 slim 条 ---- */}
      {sessionId && (seqMode || seqTasks.some((t) => t.status === 'pending')) && (
        <SeqTaskPanel
          sessionId={sessionId}
          tasks={seqTasks}
          auto={seqAuto}
          chainActive={seqChainActive}
          isStreaming={chat.isStreaming}
          seqMode={seqMode}
          onSendNext={dispatchNext}
        />
      )}

      {/* ---- 输入栏 ---- */}
      <ChatInput
        onSend={handleUserSend}
        onAbort={chat.abort}
        isStreaming={chat.isStreaming}
        backends={backends}
        activeBackendId={activeBackendId}
        sessionId={sessionId || undefined}
        workingDir={activeSession?.workingDir || undefined}
        skipPermissions={skipPermissions}
        onSkipPermissionsChange={handleSkipPermissionsChange}
        isMobile={isMobile}
        seqMode={seqMode}
        onToggleSeqMode={() => setSeqMode((v) => !v)}
        onQueueTask={handleQueueTask}
        seqCount={seqTasks.filter((t) => t.status === 'pending').length}
        onCompact={handleCompact}
        fontSize={config.fontSize}
        onAdjustFontSize={onAdjustFontSize}
        isFocused={isFocused}
        execKey={activeSession?.execKey}
        execMode={activeSession?.execMode}
        onOpenGitPanel={() => setGitPanelOpen(true)}
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
            backends={backends}
            onSendToChat={(text) => { if (!isStreamingRef.current) doSendRef.current(text); }} />
        </>
      )}

      {/* ---- Git 操作面板 ---- */}
      {sessionId && activeSession?.workingDir && (
        <GitPanel
          workingDir={activeSession.workingDir}
          execKey={activeSession.execKey}
          execLabel={activeSession.execLabel}
          execMode={activeSession.execMode}
          open={gitPanelOpen}
          onClose={() => setGitPanelOpen(false)}
        />
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

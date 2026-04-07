import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { MessageBubble } from './components/MessageBubble';
import { ChatInput } from './components/ChatInput';
import { Settings } from './components/Settings';
import { BackendManager } from './components/BackendManager';
import { RepoPanel } from './components/RepoPanel';
import { PermissionGate } from './components/PermissionGate';
import { ScratchPad } from './components/ScratchPad';
import { useChat } from './hooks/useChat';
import { useConfig } from './hooks/useConfig';
import { themes } from './hooks/useConfig';
import { messagesToMarkdown, messagesToJson } from './utils/markdown';
import { hljsLightCss, hljsDarkCss } from './utils/hljsThemes';

function hexToRgba(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return color;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha.toFixed(2)})`;
}

export const App: React.FC = () => {
  const [backends, setBackends] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<any | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backendManagerOpen, setBackendManagerOpen] = useState(false);
  const [repoPanelOpen, setRepoPanelOpen] = useState(false);
  const [repoPanelEditing, setRepoPanelEditing] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(true);  // ★ 权限模式开关
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());  // ★ Per-session streaming state
  const [completedSessions, setCompletedSessions] = useState<Set<string>>(() => {
    // ★ 持久化：从 localStorage 恢复未确认的完成通知
    try {
      const saved = localStorage.getItem('agent-with-u:completed-sessions');
      return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);  // ★ null = connecting
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [scratchPadOpen, setScratchPadOpen] = useState(false);
  const [scratchPadWidth, setScratchPadWidth] = useState(360);
  const scratchDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(6);  // ★ 默认显示最近几条（3 轮对话）
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);          // ★ 用 ref 避免 onScroll 闭包捕获旧值
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevStreamingRef = useRef(false);
  const animSessionRef = useRef<string | null>(null); // 记录上次渲染时的 sessionId
  const animMsgCountRef = useRef(0);                  // 记录上次渲染时的消息数
  const initialCheckDoneRef = useRef(false);          // ★ 防止 NewSessionDialog 重复弹出

  const { config, updateConfig, resetConfig, reloadConfig } = useConfig();

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string, durationMs = 4000) => {
    setToast({ type, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  // ★ completedSessions 持久化到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem('agent-with-u:completed-sessions', JSON.stringify([...completedSessions]));
    } catch {}
  }, [completedSessions]);

  /* ---- 后端连接状态 ---- */
  useEffect(() => {
    // Set initial state after wsReady resolves
    const unsub = api.onConnectionStatus((connected) => setBackendConnected(connected));
    return unsub;
  }, []);

  // ★ Ctrl+Shift+N → 便签本
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        setScratchPadOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /* ---- 连接后加载初始数据（处理 WS 未就绪导致首次加载为空的问题） ---- */
  useEffect(() => {
    if (backendConnected !== true) return;

    api.getBackends().then(setBackends);
    api.listSessions().then((list) => {
      setSessions(list);
      // 仅在没有活跃 session 时执行初始选择，避免重连时打断用户操作
      setActiveSessionId((current) => {
        if (current) return current;
        if (list.length > 0) return list[0].id;
        // 没有任何 session，打开新建对话框
        setNewSessionDialogOpen((open) => { if (!open) return true; return open; });
        return null;
      });
    });
    reloadConfig();
  }, [backendConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 切换 session 时刷新侧边栏列表 ---- */
  useEffect(() => {
    if (!activeSessionId || backendConnected !== true) return;
    api.listSessions().then(setSessions);
  }, [activeSessionId, backendConnected]);

  /* ---- 加载当前 session 详情（含 backendId） ---- */
  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }
    setVisibleCount(6);  // ★ 切换 session 时重置为只显示最近几条
    api.loadSession(activeSessionId).then((session) => {
      setActiveSession(session);
      // ★ 从 session 加载 skipPermissions 状态
      if (session?.skipPermissions !== undefined) {
        setSkipPermissions(session.skipPermissions);
      }
    });
  }, [activeSessionId]);

  // Phase 2: 每 Session 独立的模型配置
  const activeBackendId = activeSession?.backendId || backends[0]?.id || '';

  // /new 命令：复用当前 workingDir + backendId，免弹窗静默建 session
  const handleQuickNewSession = useCallback(async () => {
    const workingDir = activeSession?.workingDir || '.';
    const bId = activeBackendId;
    const session = await api.createSession(workingDir, bId);
    setActiveSessionId(session.id);
    const sessionList = await api.listSessions();
    setSessions(sessionList);
    window.dispatchEvent(new CustomEvent('session-created'));
  }, [activeSession?.workingDir, activeBackendId]);

  const chat = useChat(activeSessionId || '', activeBackendId, backends, skipPermissions, handleQuickNewSession);

  // ── 性能：稳定化传给子组件的回调，避免 ChatInput/MessageList 因父 state 变化而整体重渲染 ──
  const handleSkipPermissionsChange = useCallback((enabled: boolean) => {
    setSkipPermissions(enabled);
    if (activeSessionId) {
      api.executeCommand({
        command: 'set_skip_permissions',
        sessionId: activeSessionId,
        backendId: activeBackendId,
        args: { enabled },
      });
    }
  }, [activeSessionId, activeBackendId]);

  const handleCompact = useCallback(() => {
    chat.sendMessage('/compact');
  }, [chat.sendMessage]);

  // ── 性能：便签本拖拽 handler，onMouseDown 每次渲染都会重新生成，改为 ref 方案 ──
  const scratchPadWidthRef = useRef(scratchPadWidth);
  scratchPadWidthRef.current = scratchPadWidth; // 每次渲染同步，保证拖拽读到最新值
  const handleScratchDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    scratchDragRef.current = { startX: e.clientX, startW: scratchPadWidthRef.current };
    const onMove = (ev: MouseEvent) => {
      if (!scratchDragRef.current) return;
      const delta = scratchDragRef.current.startX - ev.clientX;
      const next = Math.max(260, Math.min(700, scratchDragRef.current.startW + delta));
      setScratchPadWidth(next);
    };
    const onUp = () => {
      scratchDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ── 性能：可见消息列表，流式时 slice 代价高，memo 避免每帧都创建新数组 ──
  const visibleMessages = useMemo(() => {
    const total = chat.messages.length;
    const effectiveVisible = Math.max(visibleCount, chat.isStreaming ? total : visibleCount);
    const hiddenCount = Math.max(0, total - effectiveVisible);
    return { list: hiddenCount > 0 ? chat.messages.slice(hiddenCount) : chat.messages, hiddenCount, total };
  }, [chat.messages, visibleCount, chat.isStreaming]);

  // ★ 活跃 session 的流状态同步（开始/结束）
  useEffect(() => {
    if (activeSessionId) {
      setStreamingSessions((prev) => {
        const next = new Set(prev);
        if (chat.isStreaming) {
          next.add(activeSessionId);
        } else {
          next.delete(activeSessionId);
        }
        return next;
      });
    }
  }, [chat.isStreaming, activeSessionId]);

  // ★ 全局监听所有 session 的 done/error
  // 修正两个 bug：
  //   1. 后台 session 绿点不消失：从 streamingSessions 移除
  //   2. 僵尸 streamingSessions 状态：清理用于 UI 显示的状态
  // 注意：不再清理全局流式状态（useStreamState），因为 useChat hook 需要它来恢复消息
  useEffect(() => {
    const unsub = api.onStreamDelta((delta: any) => {
      const sid: string | undefined = delta.sessionId;
      if (!sid) return;
      if (delta.type === 'done' || delta.type === 'error') {
        // 无论哪个 session，都从 streaming 中移除
        setStreamingSessions((prev) => {
          if (!prev.has(sid)) return prev;
          const next = new Set(prev);
          next.delete(sid);
          return next;
        });
        // 如果完成的是后台 session（非当前活跃），标记为"已完成待查看"
        if (delta.type === 'done' && sid !== activeSessionIdRef.current) {
          setCompletedSessions((prev) => {
            const next = new Set(prev);
            next.add(sid);
            return next;
          });
        }
      }
    });
    return unsub;
  }, [activeSessionIdRef]);

  /* ---- 自动滚到底部 ---- */
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    const switched = prevSessionRef.current !== activeSessionId;
    prevSessionRef.current = activeSessionId;
    // 切换 session 时始终滚到底并重置跟踪状态
    if (switched) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    if (!autoScrollRef.current) return;
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: switched ? 'instant' : 'smooth' });
    });
  }, [chat.messages, activeSessionId]);

  // ★ 每次新交互开始（streaming 启动）时重置跟踪
  useEffect(() => {
    if (chat.isStreaming && !prevStreamingRef.current) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    prevStreamingRef.current = chat.isStreaming;
  }, [chat.isStreaming]);

  // ★ 滚动事件：用户向上滚 → 暂停跟踪；回到底部 → 恢复跟踪
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

  // ★ 点击"跟踪最新"按钮
  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  /* ---- 新建会话 ---- */
  const handleNewSession = useCallback(() => {
    // Open dialog to select working directory first
    setNewSessionDialogOpen(true);
  }, []);

  const handleCreateSession = useCallback(async (workingDir: string, backendId: string) => {
    const session = await api.createSession(workingDir, backendId);
    // ★ Set session first, then close dialog in next render cycle to avoid visual tearing
    setActiveSessionId(session.id);
    // ★ Directly refresh session list to ensure new session appears
    const sessionList = await api.listSessions();
    setSessions(sessionList);
    // Use requestAnimationFrame to ensure visual update after state change
    requestAnimationFrame(() => {
      setNewSessionDialogOpen(false);
    });
    // ★ Also dispatch event for Sidebar to refresh (redundant but safe)
    window.dispatchEvent(new CustomEvent('session-created'));
  }, []);


  /* ---- 导出聊天记录 ---- */
  const handleExportChat = useCallback(() => {
    if (chat.messages.length === 0) return;

    const text =
      config.exportFormat === 'markdown'
        ? messagesToMarkdown(chat.messages)
        : messagesToJson(chat.messages);

    const ext = config.exportFormat === 'markdown' ? 'md' : 'json';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [chat.messages, config.exportFormat]);

  /* ---- 数据导出 ---- */
  const handleExportData = useCallback(async () => {
    const targetPath = await api.selectExportPath();
    if (!targetPath) return;

    const result = await api.exportData(targetPath);
    if (result.status === 'ok') {
      showToast('success', `导出成功 → ${targetPath}`);
    } else {
      showToast('error', `导出失败：${result.message}`);
    }
  }, [showToast]);

  /* ---- 数据导入 ---- */
  const handleImportData = useCallback(async () => {
    const confirmed = window.confirm(
      '⚠️ 警告：导入将覆盖所有现有的会话和后端配置！\n\n确定要继续吗？'
    );
    if (!confirmed) return;

    const sourcePath = await api.selectImportPath();
    if (!sourcePath) return;

    setIsImporting(true);
    showToast('info', '导入中，请稍候…', 60000);
    try {
      const result = await api.importData(sourcePath);
      if (result.status === 'ok') {
        showToast('success', `导入成功：${result.sessions || 0} 个会话，${result.backends || 0} 个后端配置`);
        const [sessionList, backendList] = await Promise.all([api.listSessions(), api.getBackends()]);
        setSessions(sessionList);
        setBackends(backendList);
      } else {
        showToast('error', `导入失败：${result.message}`);
      }
    } catch (e: any) {
      showToast('error', `导入异常：${e?.message ?? e}`);
    } finally {
      setIsImporting(false);
    }
  }, [showToast]);

  /* ---- Backend Manager ---- */
  const handleSaveBackend = useCallback(async (config: any) => {
    await api.saveBackend(config);
    // Refresh backend list
    const list = await api.getBackends();
    setBackends(list);
    // Also refresh sessions to update backend references
    const sessionList = await api.listSessions();
    setSessions(sessionList);
  }, []);

  const handleDeleteBackend = useCallback(async (id: string, dependentSessions: any[] = [], targetBackendId?: string) => {
    // If there are dependent sessions and a target backend is specified, migrate them
    if (dependentSessions.length > 0 && targetBackendId) {
      let newActiveId: string | null = null;
      // Migrate all dependent sessions to the target backend
      for (const session of dependentSessions) {
        const result = await api.migrateSession(session.id, targetBackendId);
        // ★ 如果迁移的是当前活跃 session，记住新 session ID
        if (session.id === activeSessionId && result?.newSessionId) {
          newActiveId = result.newSessionId;
        }
      }
      // Refresh sessions after migration
      const sessionList = await api.listSessions();
      setSessions(sessionList);
      // ★ 直接用迁移返回的 newSessionId 切换，避免匹配逻辑错误
      if (newActiveId) {
        setActiveSessionId(newActiveId);
      }
    }

    await api.deleteBackend(id);
    // Refresh backend list
    const list = await api.getBackends();
    setBackends(list);
  }, [backends, activeSessionId]);

  const theme = themes[config.theme] || themes.dark;
  const isLightTheme = config.theme === 'light' || config.theme === 'classic';
  const hljsCss = isLightTheme ? hljsLightCss : hljsDarkCss;

  const hasBg = !!config.bgImage;
  const ua = config.uiOpacity ?? 1;  // panel alpha

  // 首次连接中（null = 尚未收到任何连接状态回调）
  if (backendConnected === null) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: theme.bg, color: theme.textMuted, gap: 16,
        fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{
          width: 32, height: 32, border: `3px solid ${theme.border}`,
          borderTopColor: theme.accent, borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ fontSize: 14 }}>正在连接后端...</span>
      </div>
    );
  }

  return (
    <div style={{
      ...rootStyle,
      background: hasBg ? 'transparent' : theme.bg,
      color: theme.text,
      // ★ CSS Variables for theme colors - child components can use these
      '--theme-bg': ua < 1 ? hexToRgba(theme.bg, ua) : theme.bg,
      '--theme-bg-secondary': ua < 1 ? hexToRgba(theme.bgSecondary, ua) : theme.bgSecondary,
      '--theme-bg-tertiary': ua < 1 ? hexToRgba(theme.bgTertiary, ua) : theme.bgTertiary,
      '--theme-border': theme.border,
      '--theme-text': theme.text,
      '--theme-text-muted': theme.textMuted,
      '--theme-accent': theme.accent,
      '--theme-accent-hover': theme.accentHover,
      '--theme-accent-bg': theme.accentBg,
      '--theme-message-bg': ua < 1 ? hexToRgba(theme.messageBg, ua) : theme.messageBg,
      '--theme-user-message-bg': ua < 1 ? hexToRgba(theme.userMessageBg, ua) : theme.userMessageBg,
      '--theme-user-bubble-bg': theme.userBubbleBg,
      '--theme-user-bubble-border': theme.userBubbleBorder,
      '--theme-code-bg': ua < 1 ? hexToRgba(theme.codeBg, ua) : theme.codeBg,
      '--theme-input-bg': ua < 1 ? hexToRgba(theme.inputBg, ua) : theme.inputBg,
      '--theme-sidebar-bg': ua < 1 ? hexToRgba(theme.sidebarBg, ua) : theme.sidebarBg,
    } as React.CSSProperties}>
      {/* ★ 背景图层：图片本身控制透明度，面板背景保持实色 */}
      {hasBg && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none',
          backgroundImage: `url(${config.bgImage})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          opacity: config.bgOpacity,
        }} />
      )}
      {/* ★ highlight.js theme - 随主题切换 */}
      <style>{hljsCss}</style>
      {/* ★ Markdown 内容样式 + 全局动画 */}
      <style>{`
        @keyframes dialogSlideIn {
          from { opacity: 0; transform: perspective(900px) rotateX(-14deg) scale(0.96) translateY(-8px); }
          to   { opacity: 1; transform: perspective(900px) rotateX(0deg)   scale(1)    translateY(0); }
        }
        /* ── Markdown 内容 ── */
        .md-content { line-height: 1.6; }
        .md-content p { margin: 6px 0; }
        .md-content h1,.md-content h2,.md-content h3,
        .md-content h4,.md-content h5,.md-content h6 {
          color: var(--theme-text); font-weight: 600; margin: 14px 0 4px;
        }
        .md-content h1 { font-size: 1.2em; font-weight: 700; }
        .md-content h2 { font-size: 1.12em; }
        .md-content h3 { font-size: 1.05em; }
        .md-content h4 { font-size: 1em; }
        .md-content ul, .md-content ol { padding-left: 22px; margin: 4px 0; }
        .md-content li { margin-bottom: 3px; }
        .md-content a.md-link { color: var(--theme-accent); text-decoration: underline; }
        .md-content hr.md-hr { border: none; border-top: 1px solid var(--theme-border); margin: 12px 0; }
        /* 行内代码 */
        .md-content code.md-code-inline {
          background: var(--theme-code-bg); color: var(--theme-text);
          padding: 1px 5px; border-radius: 4px; font-size: 0.88em; font-family: monospace;
        }
        /* 代码块 */
        .md-content pre.md-pre {
          background: var(--theme-code-bg); border: 1px solid var(--theme-border);
          border-radius: 8px; padding: 12px 16px; overflow-x: auto;
          font-size: 13px; line-height: 1.6; margin: 8px 0;
        }
        .md-content pre.md-pre code.hljs {
          background: transparent; padding: 0; font-family: monospace;
          font-size: inherit; display: block;
        }
        .md-content .md-code-lang {
          font-size: 11px; color: var(--theme-text-muted);
          margin-bottom: 4px; font-family: sans-serif;
        }
        /* 引用块 */
        .md-content blockquote.md-blockquote {
          border-left: 3px solid var(--theme-accent); margin: 8px 0;
          padding: 4px 12px; color: var(--theme-text-muted);
        }
        .md-content blockquote.md-blockquote p { margin: 0; }
        /* 表格 */
        .md-table-wrap { overflow-x: auto; margin: 8px 0; }
        .md-table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
        .md-table th, .md-table td {
          border: 1px solid var(--theme-border); padding: 6px 12px; text-align: left;
        }
        .md-table th { background: var(--theme-bg-secondary); font-weight: 600; }
        .md-table tr:nth-child(even) td { background: var(--theme-bg-secondary); }
        /* 任务列表 */
        .md-content li input[type="checkbox"] { margin-right: 6px; vertical-align: middle; }
      `}</style>

      <Sidebar
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          setActiveSessionId(id);
          // ★ 切换到该 session 即视为已查看，自动清除完成通知气泡
          setCompletedSessions((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }}
        onAcknowledgeSession={(id) => {
          setCompletedSessions((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }}
        onNewSession={handleNewSession}
        onDeleteSession={(id) => {
          if (id === activeSessionId) setActiveSessionId(null);
        }}
        streamingSessions={streamingSessions}
        completedSessions={completedSessions}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* ---- 顶部栏 ---- */}
        <div style={headerStyle}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>AgentWithU</span>
          {/* ★ Backend connection indicator */}
          {backendConnected === false && (
            <span
              style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
                background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                color: '#ef4444',
              }}
              title="Python backend not running. Sessions and data import/export will not work. Run: python -m src.ws_main"
            >
              ⚠ backend offline
            </span>
          )}
          {/* ★ 显示当前工作目录 — 点击复制完整路径 */}
          <CopyablePath path={activeSession?.workingDir} />
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)' }}>
            {formatBackendLabel(backends.find((b: any) => b.id === activeBackendId))}
          </span>
          <div style={{ flex: 1 }} />
          {/* 日志查看器按钮 */}
          <button
            onClick={() => api.openLogViewer()}
            style={logBtnStyle}
            title="View real-time logs in external window"
          >
            📋 Logs
          </button>
          <button
            onClick={() => setRepoPanelOpen(!repoPanelOpen)}
            style={{ ...settingsBtnStyle, ...(repoPanelOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}) }}
            title="Repo — Skills & Prompts"
          >
            📦
          </button>
          <button
            onClick={() => setScratchPadOpen(v => !v)}
            style={{ ...settingsBtnStyle, ...(scratchPadOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}) }}
            title="便签本 (Ctrl+Shift+N)"
          >
            📌
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            style={settingsBtnStyle}
            title="Settings"
          >
            ⚙
          </button>
        </div>

        {/* ---- Repo 面板（展开区域）---- */}
        <div style={{
          maxHeight: repoPanelOpen ? (repoPanelEditing ? 'calc(100vh - 160px)' : 400) : 0,
          overflow: repoPanelEditing ? 'auto' : 'hidden',
          transition: repoPanelEditing ? 'none' : 'max-height 0.3s cubic-bezier(0.22,0.61,0.36,1)',
        }}>
          <RepoPanel
            open={repoPanelOpen}
            workingDir={activeSession?.workingDir || ''}
            onClose={() => setRepoPanelOpen(false)}
            onEditingChange={setRepoPanelEditing}
          />
        </div>

        {/* ---- 消息列表 ---- */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={scrollContainerRef} onScroll={handleScroll} style={{ height: '100%', overflow: 'auto', padding: '16px 0' }}>
          {chat.messages.length === 0 && (
            <div
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100%', gap: 8,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--theme-text-muted, #8c959f)' }}>
                AgentWithU
              </div>
              <div style={{ fontSize: 14, color: 'var(--theme-text-muted, #8c959f)' }}>
                Paste screenshots with Ctrl+V, switch models, save sessions.
              </div>
            </div>
          )}
          {(() => {
            // 只给真正新增的最后一条消息播入场动画，切换 session 时全部不播
            // 注意：ref mutation 不能放 useMemo/useEffect 里，保留 IIFE 仅做动画判断
            const { list: msgList, hiddenCount, total } = visibleMessages;
            const isSameSession = animSessionRef.current === activeSessionId;
            const prevCount = isSameSession ? animMsgCountRef.current : total;
            animSessionRef.current = activeSessionId;
            animMsgCountRef.current = total;

            return (
              <>
                {hiddenCount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px' }}>
                    <button
                      onClick={() => setVisibleCount(total)}
                      style={{
                        padding: '6px 16px',
                        borderRadius: 16,
                        border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                        background: 'var(--theme-bg-secondary, #f6f8fa)',
                        color: 'var(--theme-text-muted, #656d76)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      ↑ {hiddenCount} earlier messages
                    </button>
                  </div>
                )}
                {msgList.map((msg, idx) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    fontSize={config.fontSize}
                    renderMarkdown={config.renderMarkdown}
                    animateIn={isSameSession && (hiddenCount + idx) >= prevCount}
                  />
                ))}
                {/* ★ 行内权限确认组件 */}
                {chat.pendingPermission && (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'flex-start',
                    padding: '4px 16px',
                  }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--theme-accent, #7aa2f7)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, color: '#fff', fontWeight: 700, marginRight: 8, marginTop: 2,
                    }}>A</div>
                    <div style={{
                      maxWidth: '80%',
                      minWidth: 280,
                      borderRadius: '12px 12px 12px 4px',
                      background: 'var(--theme-message-bg, #f6f8fa)',
                      border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                      overflow: 'hidden',
                    }}>
                      <PermissionGate
                        request={chat.pendingPermission}
                        onDismiss={chat.clearPermission}
                        onSkipRest={() => setSkipPermissions(true)}
                      />
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {/* 底部占位符 */}
          <div ref={endRef} />
        </div>

        {/* ★ 跟踪暂停时的浮动提示按钮 */}
        {showScrollBtn && (
          <div style={{
            position: 'absolute', bottom: 12, left: '50%',
            transform: 'translateX(-50%)', zIndex: 50,
          }}>
            <button
              onClick={scrollToBottom}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px',
                borderRadius: 20,
                border: '1px solid var(--theme-border, rgba(0,0,0,0.18))',
                background: 'var(--theme-bg-tertiary, #242536)',
                color: 'var(--theme-text, #e2e3ea)',
                fontSize: 12, fontWeight: 500,
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
                whiteSpace: 'nowrap',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              跟踪最新
            </button>
          </div>
        )}
        </div>

        {/* ---- 输入栏 ---- */}
        <ChatInput
          onSend={chat.sendMessage}
          onAbort={chat.abort}
          isStreaming={chat.isStreaming}
          backends={backends}
          activeBackendId={activeBackendId}
          sessionId={activeSessionId || undefined}
          workingDir={activeSession?.workingDir || undefined}
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={handleSkipPermissionsChange}
          onCompact={handleCompact}
        />
      </div>

      {/* ---- 便签本：右侧列（共屏）---- */}
      {scratchPadOpen && (
        <>
          {/* 拖动分割线 */}
          <div
            onMouseDown={handleScratchDragStart}
            style={{
              width: 4, flexShrink: 0, cursor: 'col-resize',
              background: 'var(--theme-border, rgba(255,255,255,0.1))',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-accent, #7aa2f7)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--theme-border, rgba(255,255,255,0.1))')}
          />
          {/* 便签本面板 */}
          <div style={{ width: scratchPadWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <ScratchPad visible={true} onClose={() => setScratchPadOpen(false)} />
          </div>
        </>
      )}

      {/* ---- Settings 弹窗 ---- */}
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        onConfigChange={updateConfig}
        onExportChat={handleExportChat}
        onResetConfig={resetConfig}
        onOpenBackendManager={() => {
          setSettingsOpen(false);
          setBackendManagerOpen(true);
        }}
        onExportData={handleExportData}
        onImportData={handleImportData}
      />

      {/* ---- Backend Manager ---- */}
      <BackendManager
        isOpen={backendManagerOpen}
        onClose={() => setBackendManagerOpen(false)}
        backends={backends}
        sessions={sessions}
        onSaveBackend={handleSaveBackend}
        onDeleteBackend={handleDeleteBackend}
      />

      {/* 便签本已移到主布局右侧列 */}

      {/* ---- New Session Dialog: Select working directory first ---- */}
      {newSessionDialogOpen && (
        <NewSessionDialog
          backends={backends}
          onClose={() => {
            // ★ User manually closed - mark as done to prevent re-opening
            setNewSessionDialogOpen(false);
            initialCheckDoneRef.current = true;
          }}
          onCreate={handleCreateSession}
        />
      )}

      {/* ---- 导入 loading 遮罩 ---- */}
      {isImporting && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--theme-bg-secondary, #21262d)',
            border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
            borderRadius: 10, padding: '24px 36px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          }}>
            <div style={{ fontSize: 26 }}>⏳</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text, #e6edf3)' }}>导入中，请稍候…</div>
          </div>
        </div>
      )}

      {/* ---- Toast 通知 ---- */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{
            position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
            maxWidth: 380, padding: '12px 18px',
            borderRadius: 8, cursor: 'pointer',
            fontSize: 14, fontWeight: 500,
            boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            animation: 'toastIn 0.2s ease',
            background: toast.type === 'success'
              ? 'rgba(34,197,94,0.18)'
              : toast.type === 'error'
                ? 'rgba(239,68,68,0.18)'
                : 'rgba(99,102,241,0.18)',
            border: `1px solid ${
              toast.type === 'success' ? 'rgba(34,197,94,0.4)'
              : toast.type === 'error' ? 'rgba(239,68,68,0.4)'
              : 'rgba(99,102,241,0.4)'
            }`,
            color: toast.type === 'success' ? '#4ade80'
              : toast.type === 'error' ? '#f87171'
              : '#a5b4fc',
          }}
        >
          <span style={{ flexShrink: 0, fontSize: 16 }}>
            {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}
          </span>
          <span style={{ lineHeight: 1.5 }}>{toast.message}</span>
        </div>
      )}
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }`}</style>
    </div>
  );
};

/* ---- 根样式 ---- */
const rootStyle: React.CSSProperties = {
  display: 'flex',
  height: '100vh',
  background: 'var(--theme-bg, #ffffff)',
  color: 'var(--theme-text, #1f2328)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const headerStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  background: 'var(--theme-bg, #ffffff)',
};

const settingsBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 18,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  transition: 'color 0.15s',
};

const migrateBtnStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 10px',
  borderRadius: 6,
  transition: 'all 0.15s',
  marginRight: 8,
};

const logBtnStyle: React.CSSProperties = {
  background: 'var(--theme-success-bg, #2da44e1a)',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  color: 'var(--theme-success, #2da44e)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 10px',
  borderRadius: 6,
  transition: 'all 0.15s',
  marginRight: 8,
  fontWeight: 500,
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 12,
  padding: 24,
  width: '90%',
  maxWidth: 480,
  boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
};

const dialogTitleStyle: React.CSSProperties = {
  margin: '0 0 8px 0',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--theme-text, #1f2328)',
};

const dialogDescStyle: React.CSSProperties = {
  margin: '0 0 20px 0',
  fontSize: 13,
  color: 'var(--theme-text-muted, #656d76)',
  lineHeight: 1.5,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--theme-text, #1f2328)',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 6,
  color: 'var(--theme-text, #1f2328)',
  fontSize: 13,
  outline: 'none',
};

const dialogActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
  marginTop: 20,
};

/* ---- New Session Dialog: Select working directory first ---- */
const selectWrapperStyle: React.CSSProperties = {
  position: 'relative',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--theme-bg-tertiary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const confirmBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--theme-accent, #0969da)',
  border: 'none',
  color: '#fff',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

/* ★ 可点击复制的路径组件 */
const CopyablePath: React.FC<{ path?: string }> = ({ path }) => {
  const [copied, setCopied] = useState(false);
  const fullPath = path || '';

  const handleClick = useCallback(() => {
    if (!fullPath) return;
    navigator.clipboard.writeText(fullPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [fullPath]);

  return (
    <span
      style={{
        ...workingDirStyle,
        cursor: fullPath ? 'pointer' : 'default',
        position: 'relative',
        userSelect: 'none',
      }}
      title={fullPath || 'Not set'}
      onClick={handleClick}
    >
      {copied ? '✓ Copied!' : formatWorkingDir(path)}
    </span>
  );
};

/* ★ Working Directory Display Style */
const workingDirStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--theme-success, #2da44e)',
  background: 'var(--theme-success-bg, #2da44e1a)',
  padding: '2px 8px',
  borderRadius: 4,
  fontFamily: 'monospace',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  transition: 'background 0.15s',
};

/* Format working directory for display */
function formatWorkingDir(dir: string | undefined): string {
  if (!dir) return 'Not set';
  if (dir === '.') return '(current dir)';
  // Show last 2-3 segments of the path
  const parts = dir.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return dir;
  return '.../' + parts.slice(-3).join('/');
}

/* Format backend label to show actual model name */
function formatBackendLabel(backend: any): string {
  if (!backend) return 'No backend';
  const label = backend.label || '';
  const model = backend.model;

  // If model is specified, show it alongside the label
  if (model && model !== 'default' && model !== 'sonnet') {
    return `${label} · ${model}`;
  }

  // For claude-code without explicit model, show "auto" to indicate
  // it uses the model from claude-code config
  if (label.includes('Claude Code') || label.includes('Agent SDK')) {
    return `${label} · auto`;
  }

  return label;
}

/* ---- New Session Dialog: Select working directory first ---- */
interface NewSessionDialogProps {
  backends: any[];
  onClose: () => void;
  onCreate: (workingDir: string, backendId: string) => void;
}

const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  backends,
  onClose,
  onCreate,
}) => {
  const [workingDir, setWorkingDir] = useState('.');
  const [selectedBackendId, setSelectedBackendId] = useState(
    backends[0]?.id || 'claude-agent-sdk-default'
  );

  const handleCreate = useCallback(async () => {
    await onCreate(workingDir, selectedBackendId);
  }, [workingDir, selectedBackendId, onCreate]);

  const handleBrowse = useCallback(async () => {
    // Use system native directory picker
    const path = await api.selectDirectory(workingDir !== '.' ? workingDir : undefined);
    if (path) {
      setWorkingDir(path);
    }
  }, [workingDir]);

  return (
    <div
      style={overlayStyle}
    >
      <div
        style={{
          ...dialogStyle,
          willChange: 'transform',
          animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={dialogTitleStyle}>New Session</h3>
        <p style={dialogDescStyle}>
          Each session is tied to a working directory. Claude will operate within this directory,
          with full access to read, edit, and run commands here.
        </p>

        <div style={formGroupStyle}>
          <label style={labelStyle}>Working Directory:</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              style={inputStyle}
              placeholder="e.g., ./my-project or C:\Users\...\project"
            />
            <button onClick={handleBrowse} style={browseBtnStyle} title="Select directory with file picker">
              📁 Browse
            </button>
          </div>
          <span style={helpTextStyle}>
            The directory where Claude will read/write files and run commands
          </span>
        </div>

        <div style={formGroupStyle}>
          <label style={labelStyle}>Model:</label>
          <div style={selectWrapperStyle}>
            <select
              value={selectedBackendId}
              onChange={(e) => setSelectedBackendId(e.target.value)}
              style={selectStyle}
            >
              {backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={dialogActionsStyle}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleCreate} style={confirmBtnStyle}>
            Create Session
          </button>
        </div>
      </div>
    </div>
  );
};

const formGroupStyle: React.CSSProperties = {
  marginBottom: 16,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 12px',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 8,
  color: 'var(--theme-text, #1f2328)',
  fontSize: 13,
  fontFamily: 'monospace',
  outline: 'none',
};

const browseBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--theme-success-bg, #2da44e1a)',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  color: 'var(--theme-success, #2da44e)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const helpTextStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 6,
  fontSize: 11,
  color: 'var(--theme-text-muted, #8c959f)',
};

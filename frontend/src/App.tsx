import React, { useState, useCallback, useEffect, useRef } from 'react';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { MessageBubble } from './components/MessageBubble';
import { ChatInput } from './components/ChatInput';
import { Settings } from './components/Settings';
import { BackendManager } from './components/BackendManager';
import { PermissionGate } from './components/PermissionGate';
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
  const [migrateDialogOpen, setMigrateDialogOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(true);  // ★ 权限模式开关
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());  // ★ Per-session streaming state
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);  // ★ null = connecting
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(6);  // ★ 默认显示最近几条（3轮对话）
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★ Track if initial session check has been done to prevent re-opening dialog
  const initialCheckDoneRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const { config, updateConfig, resetConfig } = useConfig();

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string, durationMs = 4000) => {
    setToast({ type, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  /* ---- 后端连接状态 ---- */
  useEffect(() => {
    // Set initial state after wsReady resolves
    const unsub = api.onConnectionStatus((connected) => setBackendConnected(connected));
    return unsub;
  }, []);

  /* ---- 加载 backends ---- */
  useEffect(() => {
    api.getBackends().then((list) => {
      setBackends(list);
    });
  }, []);

  /* ---- 加载 sessions ---- */
  useEffect(() => {
    api.listSessions().then((list) => {
      setSessions(list);
    });
  }, [activeSessionId]);  // 当 activeSessionId 变化时刷新

  /* ---- 初始化 session ---- */
  useEffect(() => {
    // ★ Skip if already checked or session is already active
    if (initialCheckDoneRef.current || activeSessionId) return;
    initialCheckDoneRef.current = true;

    // ★ 只用一次初始化，避免重复触发
    const initSession = async () => {
      const sessions = await api.listSessions();
      if (sessions.length > 0) {
        setActiveSessionId(sessions[0].id);
      } else if (!newSessionDialogOpen) {
        // ★ Only open dialog if not already open (prevents re-opening after user closes)
        setNewSessionDialogOpen(true);
      }
    };
    initSession();
  }, [activeSessionId, newSessionDialogOpen]);

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

  // ★ skipPermissions 现在是 session 级别的设置，完全由 session 控制
  // 不再从 backend 同步默认值，避免覆盖用户设置

  const chat = useChat(activeSessionId || '', activeBackendId, backends, skipPermissions);

  // ★ Sync per-session streaming state
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

  /* ---- 自动滚到底部 ---- */
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    const switched = prevSessionRef.current !== activeSessionId;
    prevSessionRef.current = activeSessionId;
    // 等待 DOM 布局完成后再滚动，避免发送消息后滚动不到底
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: switched ? 'instant' : 'smooth' });
    });
  }, [chat.messages, activeSessionId]);

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

  /* ---- Phase 3: 切换 Session 的模型（跨 Session 支持） ---- */
  const handleMigrateSession = useCallback(async (targetBackendId: string) => {
    if (!activeSessionId) return;
    const result = await api.migrateSession(activeSessionId, targetBackendId);
    if (result?.status === 'ok') {
      setActiveSessionId(result.newSessionId);
      setMigrateDialogOpen(false);
    }
  }, [activeSessionId]);

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
  const isLightTheme = config.theme === 'light';
  const hljsCss = isLightTheme ? hljsLightCss : hljsDarkCss;

  const hasBg = !!config.bgImage;
  const ua = config.uiOpacity ?? 1;  // panel alpha

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
          from { opacity: 0; transform: scale(0.95) translateY(-10px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
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
        onSelectSession={setActiveSessionId}
        onNewSession={handleNewSession}
        onDeleteSession={(id) => {
          if (id === activeSessionId) setActiveSessionId(null);
        }}
        streamingSessions={streamingSessions}
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
          {/* Phase 3: 跨 Session 按钮 */}
          <button
            onClick={() => setMigrateDialogOpen(true)}
            style={migrateBtnStyle}
            title="Migrate to different model"
          >
            Migrate
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            style={settingsBtnStyle}
            title="Settings"
          >
            ⚙
          </button>
        </div>

        {/* ---- 消息列表 ---- */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 0' }}>
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
            const total = chat.messages.length;
            // ★ 流式时自动扩展可见数量，确保新消息不被隐藏
            const effectiveVisible = Math.max(visibleCount, chat.isStreaming ? total : visibleCount);
            const hiddenCount = Math.max(0, total - effectiveVisible);
            const visibleMessages = hiddenCount > 0 ? chat.messages.slice(hiddenCount) : chat.messages;
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
                {visibleMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    fontSize={config.fontSize}
                    renderMarkdown={config.renderMarkdown}
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
          <div ref={endRef} />
        </div>

        {/* ---- 输入栏 ---- */}
        <ChatInput
          onSend={chat.sendMessage}
          onAbort={chat.abort}
          isStreaming={chat.isStreaming}
          backends={backends}
          activeBackendId={activeBackendId}
          sessionId={activeSessionId || undefined}
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={(enabled) => {
            setSkipPermissions(enabled);
            // ★ 保存到 session
            if (activeSessionId) {
              api.executeCommand({
                command: 'set_skip_permissions',
                sessionId: activeSessionId,
                backendId: activeBackendId,
                args: { enabled },
              });
            }
          }}
          onCompact={() => chat.sendMessage('/clear')}
        />
      </div>

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

      {/* ---- Phase 3: Migrate Dialog ---- */}
      {migrateDialogOpen && (
        <MigrateDialog
          currentBackendId={activeBackendId}
          backends={backends}
          onClose={() => setMigrateDialogOpen(false)}
          onMigrate={handleMigrateSession}
        />
      )}

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

/* ---- Phase 3: Migrate Dialog Component ---- */
interface MigrateDialogProps {
  currentBackendId: string;
  backends: any[];
  onClose: () => void;
  onMigrate: (targetBackendId: string) => void;
}

const MigrateDialog: React.FC<MigrateDialogProps> = ({
  currentBackendId,
  backends,
  onClose,
  onMigrate,
}) => {
  const [selectedBackendId, setSelectedBackendId] = useState(currentBackendId);

  const handleConfirm = useCallback(() => {
    if (selectedBackendId && selectedBackendId !== currentBackendId) {
      onMigrate(selectedBackendId);
    } else {
      onClose();
    }
  }, [selectedBackendId, currentBackendId, onMigrate, onClose]);

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        style={{
          ...dialogStyle,
          willChange: 'transform',
          animation: 'dialogSlideIn 0.15s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={dialogTitleStyle}>Migrate Session to Different Model</h3>
        <p style={dialogDescStyle}>
          This creates a new session with the selected model, carrying over all message history.
          The new model will see the full conversation and can continue seamlessly.
        </p>
        <div style={selectContainerStyle}>
          <label style={labelStyle}>Target Model:</label>
          <div style={selectWrapperStyle}>
            <select
              value={selectedBackendId}
              onChange={(e) => setSelectedBackendId(e.target.value)}
              style={selectStyle}
            >
              {backends.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} {b.id === currentBackendId ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={dialogActionsStyle}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleConfirm} style={confirmBtnStyle}>
            Migrate & Create New Session
          </button>
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  willChange: 'opacity',
};

const dialogStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  borderRadius: 12,
  padding: 24,
  maxWidth: 480,
  width: '90%',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
};

const dialogTitleStyle: React.CSSProperties = {
  margin: '0 0 8px 0',
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--theme-text, #1f2328)',
};

const dialogDescStyle: React.CSSProperties = {
  margin: '0 0 20px 0',
  fontSize: 13,
  color: 'var(--theme-text-muted, #656d76)',
  lineHeight: 1.5,
};

const selectContainerStyle: React.CSSProperties = {
  marginBottom: 20,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  color: 'var(--theme-text, #1f2328)',
  marginBottom: 8,
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 8,
  color: 'var(--theme-text, #1f2328)',
  fontSize: 14,
  outline: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  appearance: 'none',
};

const dialogActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
};

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
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        style={{
          ...dialogStyle,
          willChange: 'transform',
          animation: 'dialogSlideIn 0.15s ease-out',
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

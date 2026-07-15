import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { api, isTauri, getExecutors, onExecStatus, getHomeExecKey, type ExecutorInfo } from './api';
import {
  HOTKEY_CHANGED_EVENT,
  readScreenshotHotkey,
} from './utils/hotkey';
import {
  HACKER_CAPTURE_EVENT,
  HACKER_MODE_CHANGED_EVENT,
  readHackerMode,
  type HackerModeConfig,
} from './utils/hackerMode';
import { uuid } from './utils/uuid';
import { Sidebar } from './components/Sidebar';
import { Settings } from './components/Settings';
import { BackendManager } from './components/BackendManager';
import { RepoPanel } from './components/RepoPanel';
import { ScratchPad } from './components/ScratchPad';
import { AssetPanel } from './components/AssetPanel';
import { ServerDirPicker } from './components/ServerDirPicker';
import { LogViewer } from './components/LogViewer';
import { ConnectionPanel } from './components/ConnectionPanel';
import { ManualPanel } from './components/ManualPanel';
import { ChatPane } from './components/ChatPane';
import { LoopPolicyEditor, DEFAULT_POLICY, normalizePolicy } from './components/LoopPolicyEditor';
import type { LoopPolicy } from './components/LoopPolicyEditor';
import { clearSessionHistoryCache } from './hooks/useChat';
import { clearStreamStateForSession } from './hooks/useStreamState';
import { useConfig } from './hooks/useConfig';
import { themes } from './hooks/useConfig';
import { useIsMobile } from './hooks/useIsMobile';
import { hljsLightCss, hljsDarkCss } from './utils/hljsThemes';
import { messagesToMarkdown, messagesToJson } from './utils/markdown';
import type { SmoothGhostState } from './utils/smoothGhost';

function hexToRgba(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return color;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha.toFixed(2)})`;
}

type Layout = '1x1' | '1x2' | '2x2';

const LAYOUT_SLOTS: Record<Layout, number> = { '1x1': 1, '1x2': 2, '2x2': 4 };
const LAYOUT_CYCLE: Layout[] = ['1x1', '1x2', '2x2'];
const LAYOUT_LABEL: Record<Layout, string> = { '1x1': '1×1', '1x2': '1×2', '2x2': '2×2' };

export const App: React.FC = () => {
  const [backends, setBackends] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const sessionRefreshGenerationRef = useRef(0);
  const refreshSessionList = useCallback(async (): Promise<any[]> => {
    const generation = ++sessionRefreshGenerationRef.current;
    try {
      const list = await api.listSessions();
      if (generation === sessionRefreshGenerationRef.current) setSessions(list);
      return list;
    } catch (error) {
      console.warn('[App] failed to refresh sessions', error);
      return [];
    }
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backendManagerOpen, setBackendManagerOpen] = useState(false);
  const [repoPanelOpen, setRepoPanelOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [connPanelOpen, setConnPanelOpen] = useState(false);
  const [manualPanelOpen, setManualPanelOpen] = useState(false);
  const [repoPanelEditing, setRepoPanelEditing] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
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
  const [dataPicker, setDataPicker] = useState<'export' | 'import' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 768,
  );
  // 侧栏宽度可拖拽(localStorage 持久化),规避窄侧栏下文件目录树太挤。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem('awu.sidebarWidth') || '', 10); if (v >= 200 && v <= 640) return v; } catch { /* */ }
    return 260;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const handleSidebarDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.max(200, Math.min(640, startW + (ev.clientX - startX))));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  useEffect(() => { try { localStorage.setItem('awu.sidebarWidth', String(sidebarWidth)); } catch { /* */ } }, [sidebarWidth]);
  const [scratchPadOpen, setScratchPadOpen] = useState(false);
  const [scratchPadWidth, setScratchPadWidth] = useState(360);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const scratchDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialCheckDoneRef = useRef(false);          // ★ 防止 NewSessionDialog 重复弹出

  // ── 分屏布局状态(localStorage 持久化) ────────────────────────────────
  // layout: 当前几宫格;paneSessions: 每个 pane 对应的 sessionId;
  // focusedPaneIdx: 当前焦点 pane,新建 / 侧边栏选中 / 顶栏元数据都跟随它走。
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const saved = localStorage.getItem('agent-with-u:layout');
      if (saved === '1x1' || saved === '1x2' || saved === '2x2') return saved;
    } catch {}
    return '1x1';
  });
  const [paneSessions, setPaneSessions] = useState<(string | null)[]>(() => {
    try {
      const saved = localStorage.getItem('agent-with-u:pane-sessions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) return parsed;
      }
    } catch {}
    return [null, null, null, null];
  });
  const [focusedPaneIdx, setFocusedPaneIdx] = useState(0);

  // 当前焦点 pane 对应的 sessionId(派生,不再是独立 state)
  const activeSessionId = paneSessions[focusedPaneIdx] ?? null;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // 焦点 pane 的 session 详情(顶栏展示 workingDir / backendId 用)
  const [activeSession, setActiveSession] = useState<any | null>(null);

  // 把 sessionId 写入指定 pane(默认焦点 pane)的小工具
  const setSessionInPane = useCallback((id: string | null, paneIdx?: number) => {
    setPaneSessions((prev) => {
      const idx = paneIdx ?? focusedPaneIdx;
      if (prev[idx] === id) return prev;
      const next = [...prev];
      next[idx] = id;
      return next;
    });
  }, [focusedPaneIdx]);

  const { config, updateConfig, resetConfig, reloadConfig } = useConfig();
  const isMobile = useIsMobile();

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

  // ★ layout / paneSessions 持久化到 localStorage
  useEffect(() => {
    try { localStorage.setItem('agent-with-u:layout', layout); } catch {}
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem('agent-with-u:pane-sessions', JSON.stringify(paneSessions)); } catch {}
  }, [paneSessions]);

  // 焦点 pane 索引超出当前布局时,回落到 0,防止顶栏读到隐藏 pane 的 session
  useEffect(() => {
    const slots = LAYOUT_SLOTS[layout];
    if (focusedPaneIdx >= slots) setFocusedPaneIdx(0);
  }, [layout, focusedPaneIdx]);

  /* ---- 后端连接状态 ---- */
  useEffect(() => {
    // Set initial state after wsReady resolves
    const unsub = api.onConnectionStatus((connected) => setBackendConnected(connected));
    return unsub;
  }, []);

  // 执行节点状态只负责连接状态；实际列表由 Sidebar 自己维护，App 仅在
  // 初始化/打开 BackendManager/明确变更后按需同步，避免同一事件双重拉取。
  useEffect(() => {
    const unsub = onExecStatus(() => {
      const anyOnline = getExecutors().some((item) => item.connected);
      // A stale/offline relay selected as home must not hide a healthy local
      // desktop sidecar behind the full-screen "backend offline" state.
      setBackendConnected(anyOnline);
    });
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

  // ★ 全局截图快捷键(仅 Tauri):App 不在前台也能响应。默认 Ctrl+Shift+A,
  //   可在 Settings 改键位 / 禁用。触发时往 window 派发
  //   'awu:screenshot-hotkey' 自定义事件,焦点 pane 的 ChatInput 接收事件
  //   后走它本地的 handleScreenshot 流程(用 isFocused 做选举,避免多 pane
  //   同时反应)。
  const [screenshotHotkey, setScreenshotHotkey] = useState<string>(() => readScreenshotHotkey());
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string; value?: string } | undefined;
      if (detail?.key === 'screenshot') setScreenshotHotkey(detail.value ?? '');
    };
    window.addEventListener(HOTKEY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(HOTKEY_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const accelerator = screenshotHotkey.trim();
    if (!accelerator) return; // 空 = 用户主动禁用
    let unregister: null | (() => Promise<void>) = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-global-shortcut');
        await mod.register(accelerator, (event) => {
          // event 有 pressed/released 两次触发,只取 pressed 那一下
          if (event.state !== 'Pressed') return;
          window.dispatchEvent(new CustomEvent('awu:screenshot-hotkey'));
        });
        if (!cancelled) {
          unregister = async () => { try { await mod.unregister(accelerator); } catch { /* */ } };
        } else {
          try { await mod.unregister(accelerator); } catch { /* */ }
        }
      } catch (e) {
        console.warn('[hotkey] register screenshot shortcut failed:', accelerator, e);
        window.dispatchEvent(new CustomEvent('awu:hotkey-error', {
          detail: { key: 'screenshot', value: accelerator, message: String(e) },
        }));
      }
    })();
    return () => {
      cancelled = true;
      if (unregister) unregister();
    };
  }, [screenshotHotkey]);

  // Smooth 模式：Rust 在系统级监听 Ctrl + 双击鼠标，不激活本窗口。
  // 收到触发后后台截屏，再把一次性图片任务派给最后聚焦的 pane。
  const [hackerMode, setHackerMode] = useState<HackerModeConfig>(() => readHackerMode());
  const ghostSnapshotRef = useRef<SmoothGhostState | null>(null);
  const ghostEmitRef = useRef<null | ((state: SmoothGhostState) => void)>(null);
  const ghostFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bridge the focused ChatPane into the native click-through ghost overlay.
  // Native state is retained before the overlay is first shown, so there is no
  // second WebView startup/ready race on managed Windows machines.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      if (cancelled) return;
      const emitSnapshot = (state: SmoothGhostState) => {
        void invoke('update_smooth_ghost_state', { state }).catch(() => {});
      };
      ghostEmitRef.current = emitSnapshot;
      if (ghostSnapshotRef.current) emitSnapshot(ghostSnapshotRef.current);
    })().catch((error) => console.error('[smooth-ghost] main bridge failed:', error));
    return () => {
      cancelled = true;
      ghostEmitRef.current = null;
      if (ghostFlushTimerRef.current) clearTimeout(ghostFlushTimerRef.current);
    };
  }, []);

  const handleGhostStateChange = useCallback((state: SmoothGhostState) => {
    ghostSnapshotRef.current = state;
    if (ghostFlushTimerRef.current) return;
    ghostFlushTimerRef.current = setTimeout(() => {
      ghostFlushTimerRef.current = null;
      if (ghostSnapshotRef.current) ghostEmitRef.current?.(ghostSnapshotRef.current);
    }, 120);
  }, []);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<HackerModeConfig>).detail;
      if (detail) setHackerMode(detail);
    };
    window.addEventListener(HACKER_MODE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(HACKER_MODE_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenTrigger: undefined | (() => void);
    let unlistenError: undefined | (() => void);
    let cancelled = false;
    (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/event'),
        ]);
        // Listen before enabling the native hook so even an immediate gesture
        // cannot fall into the setup gap.
        unlistenError = await listen<string>('smooth-error', (event) => {
          if (!cancelled) showToast('error', event.payload || 'Smooth 幽灵窗口启动失败', 9000);
        });
        unlistenTrigger = await listen('hacker-trigger', async () => {
          try {
            const image = await invoke<any>('capture_hacker_screenshot', {
              config: {
                mode: hackerMode.captureMode,
                x: hackerMode.x,
                y: hackerMode.y,
                width: hackerMode.width,
                height: hackerMode.height,
              },
            });
            if (cancelled || !image?.base64) return;
            window.dispatchEvent(new CustomEvent(HACKER_CAPTURE_EVENT, {
              detail: { prompt: hackerMode.prompt, image: { id: uuid(), ...image } },
            }));
          } catch (error) {
            console.error('[smooth] capture failed:', error);
            if (!cancelled) showToast('error', `Smooth 截图失败：${String(error)}`, 7000);
          }
        });
        await invoke('configure_hacker_monitor', {
          config: {
            enabled: hackerMode.enabled,
            mouseButton: hackerMode.mouseButton,
            doubleClickMs: hackerMode.doubleClickMs,
            x: hackerMode.x,
            y: hackerMode.y,
            width: hackerMode.width,
            height: hackerMode.height,
          },
        });
      } catch (error) {
        console.error('[smooth] monitor setup failed:', error);
        if (!cancelled && hackerMode.enabled) {
          showToast('error', `Smooth 全局鼠标监听启动失败：${String(error)}`, 9000);
        }
      }
    })();
    return () => {
      cancelled = true;
      unlistenTrigger?.();
      unlistenError?.();
    };
  }, [hackerMode, showToast]);

  /* ---- 连接后加载初始数据（处理 WS 未就绪导致首次加载为空的问题） ---- */
  useEffect(() => {
    if (backendConnected !== true) return;

    api.getBackends().then(setBackends);
    refreshSessionList().then((list) => {
      // 仅在焦点 pane 还没绑 session 时执行初始选择,避免重连打断用户。
      setPaneSessions((prev) => {
        const idx = focusedPaneIdx;
        if (prev[idx]) return prev;
        if (list.length > 0) {
          const next = [...prev];
          next[idx] = list[0].id;
          return next;
        }
        // 没有任何 session，打开新建对话框
        setNewSessionDialogOpen((open) => { if (!open) return true; return open; });
        return prev;
      });
    });
    reloadConfig();
  }, [backendConnected, refreshSessionList]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 多端同步：其它客户端增删改 session 时刷新侧边栏 ---- */
  useEffect(() => {
    if (backendConnected !== true) return;
    return api.onSessionUpdated((data: any) => {
      const t = data?.type;
      if (t !== 'session_created' && t !== 'session_deleted' && t !== 'session_renamed' && t !== 'session_changed') {
        return;
      }
      // 增量事件发生在任何既有列表请求之后；阻止旧请求晚到后覆盖它。
      sessionRefreshGenerationRef.current += 1;
      if (data?.summary?.id) {
        setSessions((prev) => {
          const index = prev.findIndex((session) => session.id === data.summary.id);
          const next = [...prev];
          if (index >= 0) next[index] = { ...next[index], ...data.summary };
          else next.push(data.summary);
          return next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        });
        setActiveSession((prev: any) => (
          prev?.id === data.summary.id ? { ...prev, ...data.summary } : prev
        ));
      } else if (t === 'session_renamed' && data?.sessionId) {
        setSessions((prev) => prev.map((session) => (
          session.id === data.sessionId ? { ...session, title: data.title || session.title } : session
        )));
      } else if (t === 'session_created') {
        // 兼容没有 summary 的旧后端事件。
        refreshSessionList();
      }
      if (t === 'session_deleted') {
        setSessions((prev) => prev.filter((session) => session.id !== data.sessionId));
        // 当前正在查看的 session 被其它客户端删除:把任何 pane 里指向它的位置清掉
        setPaneSessions((prev) => prev.map((s) => (s === data.sessionId ? null : s)));
      }
    });
  }, [backendConnected, refreshSessionList]);

  /* ---- 加载焦点 pane 的 session 详情(用于顶栏 workingDir / backend 展示) ---- */
  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }
    let cancelled = false;
    // 顶栏只用 workingDir / backendId 等元数据，不需要消息正文。
    // 用 limit=1 避免在启动时把整个 session（可能几十兆图片）拉过来——这是启动变慢、
    // "好一会才出东西"的主因之一。ChatPane 会按自己的分页再拉消息。
    api.loadSession(activeSessionId, 1).then((session) => {
      if (cancelled) return;
      setActiveSession(session);
    });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // Phase 2: 每 Session 独立的模型配置(顶栏标签用)
  const activeBackendId = activeSession?.backendId || backends[0]?.id || '';

  // ★ 修复：根据 session 的 execKey 获取对应节点的 backend 列表
  // 多节点环境下，每个节点有独立的 backend 配置，需要按 execKey 区分
  const [activeExecBackends, setActiveExecBackends] = useState<any[]>(backends);
  useEffect(() => {
    let cancelled = false;
    const execKey = activeSession?.execKey;
    const isHomeExec = !execKey || execKey === getHomeExecKey();
    if (isHomeExec) {
      setActiveExecBackends(backends);
      return;
    }
    // 远端节点：按需拉取该节点的 backend 列表
    api.getBackends(execKey).then((list) => {
      if (!cancelled) setActiveExecBackends(list || []);
    });
    return () => { cancelled = true; };
  }, [activeSession?.execKey, backends]);

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

  // ★ ChatPane 把自己的 isStreaming 状态上报到这里聚合,用于侧边栏指示灯。
  //   多个 pane 同时跑各自的 session 时,App 用这个 Set 决定哪些 session 在跑。
  const handleStreamingChange = useCallback((sid: string, streaming: boolean) => {
    setStreamingSessions((prev) => {
      const has = prev.has(sid);
      if (streaming === has) return prev;
      const next = new Set(prev);
      if (streaming) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);

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

  // 自动滚动 / 跟踪最新 / 滚动事件全部下沉到 ChatPane 内部 ——
  // 每个 pane 维护自己的 endRef / scrollContainerRef / autoScrollRef。

  /* ---- 新建会话 ---- */
  const handleNewSession = useCallback(() => {
    // Open dialog to select working directory first
    setNewSessionDialogOpen(true);
  }, []);

  const handleCreateSession = useCallback(async (workingDir: string, backendId: string, sessionType: 'normal' | 'loop' = 'normal', loopPolicy?: any, execKey?: string) => {
    let session;
    try {
      session = await api.createSession(workingDir, backendId, sessionType, execKey);
    } catch (e: any) {
      // ★ 后端抛出错误（如节点 session 数量已达上限）
      showToast('error', e?.message || '创建会话失败');
      return;
    }
    if (!session) {
      showToast('error', '创建会话失败：无法连接到执行节点');
      return;
    }
    // ★ Loop 会话：把建会话时编辑的策略与心智落到 stage 文件
    if (sessionType === 'loop' && loopPolicy) {
      api.loopSetPolicy(session.id, loopPolicy).catch(() => {});
    }
    // ★ Set session first, then close dialog in next render cycle to avoid visual tearing
    // 分屏架构下:把新 session 放进焦点 pane,activeSessionId 自动派生过去。
    setSessionInPane(session.id);
    // ★ Dispatch with session data → Sidebar optimistically inserts it immediately
    window.dispatchEvent(new CustomEvent('session-created', { detail: session }));
    // App 自己只为 BackendManager 保留一份摘要，直接 upsert 即可。
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === session.id);
      const next = [...prev];
      if (index >= 0) next[index] = { ...next[index], ...session };
      else next.push(session);
      return next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });
    requestAnimationFrame(() => {
      setNewSessionDialogOpen(false);
    });
  }, [setSessionInPane]);


  /* ---- 导出聊天记录(导出焦点 pane 的会话) ----
   * 分屏后 App 不再持有 chat.messages,按需从后端拉焦点 session 再导出。
   * 流式中的中间内容没持久化会被忽略——导出本就是「定稿」用途。
   */
  const handleExportChat = useCallback(async () => {
    if (!activeSessionId) {
      showToast('info', '请先选中一个会话');
      return;
    }
    try {
      const session = await api.loadSession(activeSessionId);
      const msgs = session?.messages ?? [];
      if (msgs.length === 0) {
        showToast('info', '当前会话还没有消息可导出');
        return;
      }
      const text =
        config.exportFormat === 'markdown'
          ? messagesToMarkdown(msgs)
          : messagesToJson(msgs);
      const ext = config.exportFormat === 'markdown' ? 'md' : 'json';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      showToast('error', `导出失败:${e?.message ?? e}`);
    }
  }, [activeSessionId, config.exportFormat, showToast]);

  /* ---- 数据导出 ---- */
  const runExport = useCallback(async (targetPath: string) => {
    showToast('info', '导出中，请稍候…', 60000);
    try {
      const result = await api.exportData(targetPath);
      if (result.status === 'ok') {
        showToast('success', `导出成功 → ${targetPath}`);
      } else {
        showToast('error', `导出失败：${result.message}`);
      }
    } catch (e: any) {
      console.error('[export] exportData failed:', e);
      showToast('error', `导出异常：${e?.message ?? e}`);
    }
  }, [showToast]);

  const handleExportData = useCallback(async () => {
    // 浏览器 / 远程 C/S：导出文件落在「服务器」上，用 ServerDirPicker。
    if (!isTauri()) {
      setDataPicker('export');
      return;
    }
    let targetPath: string | null = null;
    try {
      targetPath = await api.selectExportPath();
    } catch (e: any) {
      console.error('[export] selectExportPath failed:', e);
      showToast('error', `打开保存对话框失败：${e?.message ?? e}`);
      return;
    }
    if (!targetPath) return;  // 用户取消
    await runExport(targetPath);
  }, [showToast, runExport]);

  /* ---- 数据导入 ---- */
  const runImport = useCallback(async (sourcePath: string) => {
    setIsImporting(true);
    showToast('info', '导入中，请稍候…', 60000);
    try {
      const result = await api.importData(sourcePath);
      if (result.status === 'ok') {
        const parts = [
          `${result.backends || 0} 个后端`,
          `${result.prompts || 0} 个 Prompt`,
          `${result.skills || 0} 个 Skill`,
        ];
        showToast('success', `导入成功：${parts.join('，')}`);
        const backendList = await api.getBackends();
        setBackends(backendList);
      } else {
        showToast('error', `导入失败：${result.message}`);
      }
    } catch (e: any) {
      console.error('[import] importData failed:', e);
      showToast('error', `导入异常：${e?.message ?? e}`);
    } finally {
      setIsImporting(false);
    }
  }, [showToast]);

  const handleImportData = useCallback(async () => {
    const confirmed = window.confirm(
      '⚠️ 警告：导入将覆盖现有的 Backends 配置 和 Repo（Prompts + Skills）！\n\n' +
      '（会话不会被导入／覆盖。）\n\n确定要继续吗？'
    );
    if (!confirmed) return;

    // 浏览器 / 远程 C/S：导入文件来自「服务器」，用 ServerDirPicker。
    if (!isTauri()) {
      setDataPicker('import');
      return;
    }
    let sourcePath: string | null = null;
    try {
      sourcePath = await api.selectImportPath();
    } catch (e: any) {
      console.error('[import] selectImportPath failed:', e);
      showToast('error', `打开文件对话框失败：${e?.message ?? e}`);
      return;
    }
    if (!sourcePath) return;
    await runImport(sourcePath);
  }, [showToast, runImport]);

  /* ---- Backend Manager ---- */
  const handleSaveBackend = useCallback(async (config: any) => {
    await api.saveBackend(config);
    // Refresh backend list
    const list = await api.getBackends();
    setBackends(list);
    // Also refresh sessions to update backend references
    await refreshSessionList();
  }, [refreshSessionList]);

  const handleDeleteBackend = useCallback(async (id: string, dependentSessions: any[] = [], targetBackendId?: string) => {
    // If there are dependent sessions and a target backend is specified, migrate them
    if (dependentSessions.length > 0 && targetBackendId) {
      // 记录每个旧 session 迁移后对应的新 session id,后面统一替换 paneSessions
      const idMap = new Map<string, string>();
      for (const session of dependentSessions) {
        const result = await api.migrateSession(session.id, targetBackendId);
        if (result?.newSessionId) {
          idMap.set(session.id, result.newSessionId);
        }
      }
      // Refresh sessions after migration
      await refreshSessionList();
      // 把所有 pane 上指向已迁移 session 的位置一并替换为新 session id
      if (idMap.size > 0) {
        setPaneSessions((prev) => prev.map((s) => (s && idMap.has(s) ? idMap.get(s)! : s)));
      }
    }

    await api.deleteBackend(id);
    // Refresh backend list
    const list = await api.getBackends();
    setBackends(list);
  }, [backends, refreshSessionList]);

  const theme = themes[config.theme] || themes.dark;
  const isLightTheme = config.theme === 'light' || config.theme === 'classic';
  const hljsCss = isLightTheme ? hljsLightCss : hljsDarkCss;

  const hasBg = !!config.bgImage;
  const ua = config.uiOpacity ?? 1;  // panel alpha

  // 首次连接中（null = 尚未收到任何连接状态回调）
  // 超过 10 秒仍连接不上，展示诊断提示
  const [connectHint, setConnectHint] = useState(false);
  useEffect(() => {
    if (backendConnected !== null) return;
    const timer = setTimeout(() => setConnectHint(true), 10000);
    return () => clearTimeout(timer);
  }, [backendConnected]);

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
        {connectHint && (
          <div style={{
            fontSize: 12, color: '#888', textAlign: 'center', maxWidth: 420,
            lineHeight: 1.6, marginTop: 8,
            background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '12px 16px',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>连接超时？请检查：</div>
            <div>1. 后端进程是否已启动（<code>python -m src.ws_main</code>）</div>
            <div>2. 端口 44321 是否可达</div>
            <div>3. 浏览器控制台是否有 WebSocket 错误</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-root" style={{
      ...rootStyle,
      background: hasBg ? 'transparent' : theme.bg,
      color: theme.text,
      // ★ CSS Variables for theme colors - child components can use these
      '--theme-bg': ua < 1 ? hexToRgba(theme.bg, ua) : theme.bg,
      '--theme-bg-secondary': ua < 1 ? hexToRgba(theme.bgSecondary, ua) : theme.bgSecondary,
      '--theme-bg-tertiary': ua < 1 ? hexToRgba(theme.bgTertiary, ua) : theme.bgTertiary,
      // 密集数据面板(如 Loop 内嵌面板)需要的"实色底"：即便用户把气泡调得很透,
      // 也保留 ≥0.86 的不透明度,叠在壁纸上仍能看清。配合 backdrop-filter 用。
      '--theme-panel-bg': hexToRgba(theme.bg, Math.max(ua, 0.86)),
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
        /* 移动端用 dvh，规避浏览器地址栏让 100vh 把底部输入框顶出可视区；
           不支持 dvh 的旧 webview 回退到 100vh。inline style 已不设 height。 */
        .app-root { height: 100vh; height: 100dvh; }
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
        /* ── 移动端适配 ── */
        @media (max-width: 768px) {
          .message-bubble-wrapper { max-width: 94% !important; }
          .md-content pre.md-pre { padding: 10px 12px; font-size: 12px; }
          .md-table th, .md-table td { padding: 4px 8px; }
        }
      `}</style>

      {/* ★ 移动端侧栏抽屉的半透明遮罩 */}
      {isMobile && !sidebarCollapsed && (
        <div
          onClick={() => setSidebarCollapsed(true)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1050,
            background: 'rgba(0,0,0,0.45)',
          }}
        />
      )}

      <Sidebar
        isMobile={isMobile}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          // 分屏架构:把选中的 session 放到当前焦点 pane,activeSessionId 自动派生过去
          setSessionInPane(id);
          // ★ 移动端：选中会话后自动收起抽屉
          if (isMobile) setSidebarCollapsed(true);
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
          // session 被删后顺手把它在 streamStates Map 和历史缓存里的数据也
          // 清掉,防止「删而不洗」的内存泄漏。
          clearStreamStateForSession(id);
          clearSessionHistoryCache(id);
          // 任何 pane 里指向已删除 session 的位置都置空
          setPaneSessions((prev) => prev.map((s) => (s === id ? null : s)));
        }}
        streamingSessions={streamingSessions}
        completedSessions={completedSessions}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        width={sidebarWidth}
        activeWorkingDir={activeSession?.workingDir}
        activeExecKey={activeSession?.execKey}
        activeExecLabel={activeSession?.execLabel}
        activeExecMode={activeSession?.execMode}
        activeBackendId={activeBackendId}
      />

      {/* 侧栏宽度拖拽手柄(桌面端展开时) */}
      {!sidebarCollapsed && !isMobile && (
        <div
          onMouseDown={handleSidebarDragStart}
          title="拖拽调整侧栏宽度"
          style={{
            width: 4, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--theme-border, rgba(255,255,255,0.1))', transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--theme-accent, #7aa2f7)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--theme-border, rgba(255,255,255,0.1))')}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* ---- 顶部栏 ---- */}
        <div style={isMobile ? { ...headerStyle, padding: '8px 10px', gap: 6, flexWrap: 'wrap' } : headerStyle}>
          {/* ★ 移动端：唤出侧栏抽屉的汉堡按钮 */}
          {isMobile && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              style={{ ...settingsBtnStyle, fontSize: 20 }}
              title="会话列表"
            >
              ☰
            </button>
          )}
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
          {/* ★ 工作目录与后端标签在移动端隐藏，给按钮腾空间 */}
          {!isMobile && <CopyablePath path={activeSession?.workingDir} />}
          {!isMobile && (
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)' }}>
              {formatBackendLabel(activeExecBackends.find((b: any) => b.id === activeBackendId))}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {hackerMode.enabled && (
            <button
              onClick={() => setSettingsOpen(true)}
              title="Smooth 已开启 · Ctrl+双击截图 · 左 Shift+双击左键显示/隐藏幽灵窗口"
              style={{
                border: '1px solid rgba(34,211,238,.55)', borderRadius: 999,
                padding: '3px 9px', background: 'rgba(6,182,212,.1)',
                color: '#22d3ee', fontSize: 10, fontWeight: 800,
                letterSpacing: 1.2, cursor: 'pointer', boxShadow: '0 0 12px rgba(34,211,238,.16)',
              }}
            >
              ◉ SMOOTH
            </button>
          )}
          {/* Loop 会话的全部交互在 ChatPane 内嵌的 LoopPanel 中进行，顶栏不再放入口 */}
          <button
            onClick={() => setManualPanelOpen(true)}
            style={{ ...settingsBtnStyle, ...(manualPanelOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}) }}
            title="使用手册"
          >
            📖
          </button>
          {/* 日志查看器按钮 */}
          <button
            onClick={() => setLogViewerOpen(true)}
            style={settingsBtnStyle}
            title="后端日志 / Logs"
          >
            📋
          </button>
          {/* 连接目标：本地直连 / 经中继访问远程执行节点 */}
          <button
            onClick={() => setConnPanelOpen(true)}
            style={settingsBtnStyle}
            title="连接目标(本地 / 远程中继)"
          >
            📡
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
            onClick={() => setAssetPanelOpen(v => !v)}
            style={{ ...settingsBtnStyle, ...(assetPanelOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}) }}
            title="素材池 / Asset Pool"
          >
            🗂
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            style={settingsBtnStyle}
            title="Settings"
          >
            ⚙
          </button>
        </div>

        {/* ---- Claude 登录状态提示 ---- */}

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

        {/* ---- 分屏布局:1×1 / 1×2 / 2×2 ---- *
         * 每个 ChatPane 内部独立 useChat,有自己的消息流、滚动、权限气泡和 ChatInput。
         * App 仅负责派发焦点和聚合 streamingSessions(用于侧边栏指示灯)。
         */}
        {(() => {
          const slotCount = LAYOUT_SLOTS[layout];
          const gridCols = layout === '2x2' ? '1fr 1fr' : layout === '1x2' ? '1fr 1fr' : '1fr';
          const gridRows = layout === '2x2' ? '1fr 1fr' : '1fr';
          return (
            <div style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: gridCols,
              gridTemplateRows: gridRows,
              gap: 4,
              overflow: 'hidden',
              minHeight: 0,
              background: 'var(--theme-border)',
            }}>
              {Array.from({ length: slotCount }).map((_, idx) => (
                <ChatPane
                  key={idx}
                  paneId={idx}
                  sessionId={paneSessions[idx]}
                  isFocused={focusedPaneIdx === idx}
                  onFocus={() => setFocusedPaneIdx(idx)}
                  backends={backends}
                  config={config}
                  themeBorderFocused="var(--theme-accent)"
                  isMobile={isMobile}
                  onRequestNewSession={handleNewSession}
                  onSessionDeleted={(sid) => {
                    setPaneSessions((prev) => prev.map((s) => (s === sid ? null : s)));
                  }}
                  onStreamingChange={handleStreamingChange}
                  onGhostStateChange={handleGhostStateChange}
                  onAdjustFontSize={(delta) => updateConfig({ fontSize: Math.max(11, Math.min(28, config.fontSize + delta)) })}
                  layoutLabel={LAYOUT_LABEL[layout]}
                  onCycleLayout={() => setLayout((cur) => LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(cur) + 1) % LAYOUT_CYCLE.length])}
                />
              ))}
            </div>
          );
        })()}
      </div>

      {/* ---- 便签本：桌面端右侧列 / 移动端全屏覆盖 ---- */}
      {scratchPadOpen && (
        isMobile ? (
          <div style={mobilePanelOverlayStyle}>
            <ScratchPad visible={true} onClose={() => setScratchPadOpen(false)} />
          </div>
        ) : (
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
        )
      )}

      {/* ---- 素材池：桌面端右侧列 / 移动端全屏覆盖 ---- */}
      {assetPanelOpen && (
        isMobile ? (
          <div style={mobilePanelOverlayStyle}>
            <AssetPanel visible={true} onClose={() => setAssetPanelOpen(false)} />
          </div>
        ) : (
          <>
            <div style={{
              width: 4, flexShrink: 0,
              background: 'var(--theme-border, rgba(255,255,255,0.1))',
            }} />
            <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <AssetPanel visible={true} onClose={() => setAssetPanelOpen(false)} />
            </div>
          </>
        )
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
          refreshSessionList();
          setBackendManagerOpen(true);
        }}
        onExportData={handleExportData}
        onImportData={handleImportData}
      />

      {/* ---- 后端日志查看器 ---- */}
      <LogViewer isOpen={logViewerOpen} onClose={() => setLogViewerOpen(false)} />

      {/* ---- 连接目标设置 ---- */}
      {connPanelOpen && <ConnectionPanel onClose={() => setConnPanelOpen(false)} />}

      {/* ---- 内置使用手册 ---- */}
      {manualPanelOpen && <ManualPanel onClose={() => setManualPanelOpen(false)} />}

      {/* 目录同步已重做为侧栏「🗂 文件」视图（本地 ⇄ 远端目录树），不再用弹窗。 */}

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

      {/* ---- 数据导入/导出：服务器文件选择器（非桌面端） ---- */}
      {dataPicker === 'export' && (
        <ServerDirPicker
          mode="save"
          saveFilename={`agent-with-u-export-${new Date().toISOString().slice(0, 10)}.tar.gz`}
          onSelect={(p) => { setDataPicker(null); runExport(p); }}
          onCancel={() => setDataPicker(null)}
        />
      )}
      {dataPicker === 'import' && (
        <ServerDirPicker
          mode="open"
          onSelect={(p) => { setDataPicker(null); runImport(p); }}
          onCancel={() => setDataPicker(null)}
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
  background: 'var(--theme-bg, #ffffff)',
  color: 'var(--theme-text, #1f2328)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

// ★ 移动端：便签本/素材池改为全屏覆盖，不挤占聊天区
const mobilePanelOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 900,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--theme-bg, #ffffff)',
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
  onCreate: (workingDir: string, backendId: string, sessionType: 'normal' | 'loop', loopPolicy?: LoopPolicy, execKey?: string) => void;
}

const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  backends,
  onClose,
  onCreate,
}) => {
  // 留空 = 后端自动生成按时间命名的默认目录（放在日志目录同级）
  const [workingDir, setWorkingDir] = useState('');
  const [sessionType, setSessionType] = useState<'normal' | 'loop'>('normal');
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [loopPolicy, setLoopPolicy] = useState<LoopPolicy>(DEFAULT_POLICY);
  const [policyOpen, setPolicyOpen] = useState(false);
  const isAutoDir = !workingDir.trim() || workingDir.trim() === '.';

  // ── 执行节点（session 级模式管理）：默认落在 home;有额外节点时可选 ──
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  const [execKey, setExecKey] = useState<string>(() => getHomeExecKey());
  useEffect(() => onExecStatus(() => setExecutors(getExecutors())), []);
  const isHomeExec = execKey === getHomeExecKey();
  const isLocalExec = execKey === 'local';

  // 选中的执行节点对应的后端列表:home 直接用上层传入,远端则按需拉取。
  const [execBackends, setExecBackends] = useState<any[]>(backends);
  useEffect(() => {
    let cancelled = false;
    if (isHomeExec) { setExecBackends(backends); return; }
    api.getBackends(execKey).then((list) => { if (!cancelled) setExecBackends(list || []); });
    return () => { cancelled = true; };
  }, [execKey, isHomeExec, backends]);

  const [selectedBackendId, setSelectedBackendId] = useState(
    backends[0]?.id || 'claude-agent-sdk-default'
  );
  // 切换执行节点后,若原先选的后端在新节点不存在,回退到新节点的第一个。
  useEffect(() => {
    if (execBackends.length && !execBackends.some((b) => b.id === selectedBackendId)) {
      setSelectedBackendId(execBackends[0].id);
    }
  }, [execBackends]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async () => {
    // 空值交给后端补一个时间戳目录
    await onCreate(workingDir.trim() || '', selectedBackendId, sessionType,
      sessionType === 'loop' ? normalizePolicy(loopPolicy) : undefined, execKey);
  }, [workingDir, selectedBackendId, sessionType, loopPolicy, execKey, onCreate]);

  const handleBrowse = useCallback(async () => {
    // Tauri 桌面端 + 本机节点：用系统原生目录对话框（本机 = 服务器同机）。
    // Tauri 桌面端 + 远端节点 / 浏览器模式：必须浏览「目标执行节点」的文件系统，用 ServerDirPicker。
    if (isTauri() && isLocalExec) {
      const path = await api.selectDirectory(isAutoDir ? undefined : workingDir);
      if (path) setWorkingDir(path);
    } else {
      setDirPickerOpen(true);
    }
  }, [workingDir, isAutoDir, isLocalExec]);

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

        {/* ★ 会话类型：普通 / Loop（可视化迭代任务） */}
        <div style={formGroupStyle}>
          <label style={labelStyle}>会话类型 / Type:</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { v: 'normal', icon: '💬', title: '普通会话', desc: '常规对话工作区' },
              { v: 'loop', icon: '🔁', title: 'Loop 会话', desc: '想法→迭代执行→产出，可视化' },
            ] as const).map((opt) => (
              <button
                key={opt.v}
                onClick={() => setSessionType(opt.v)}
                style={{
                  flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  background: sessionType === opt.v ? 'var(--theme-accent-bg, #0969da1a)' : 'var(--theme-bg-tertiary, #f6f8fa)',
                  border: `1px solid ${sessionType === opt.v ? 'var(--theme-accent, #0969da)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
                  color: 'var(--theme-text, #1f2328)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.icon} {opt.title}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 2 }}>{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ★ Loop 策略与心智：建会话时可编辑（默认即可，按需展开调整） */}
        {sessionType === 'loop' && (
          <div style={formGroupStyle}>
            <button
              onClick={() => setPolicyOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: 'var(--theme-text, #1f2328)', fontSize: 13, fontWeight: 600,
              }}
            >
              <span>{policyOpen ? '▾' : '▸'}</span>
              <span>⚙️ Loop 策略与心智</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text-muted, #656d76)' }}>
                （门槛 / 最大 loop / 风险 / 策略文本，可不改用默认；建后也能随时调）
              </span>
            </button>
            {policyOpen && (
              <div style={{ marginTop: 10 }}>
                <LoopPolicyEditor value={loopPolicy} onChange={setLoopPolicy} />
              </div>
            )}
          </div>
        )}

        {/* ★ 执行节点：本会话在哪台机器上执行(本机自执行 / 远端节点)。
            只有配置了额外执行节点时才出现,单机用户无感(不臃肿)。 */}
        {executors.length > 1 && (
          <div style={formGroupStyle}>
            <label style={labelStyle}>执行节点 / Runs on:</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {executors.map((ex) => {
                const active = ex.key === execKey;
                return (
                  <button
                    key={ex.key}
                    onClick={() => setExecKey(ex.key)}
                    title={ex.connected ? '在线' : '离线 — 该节点暂不可达'}
                    style={{
                      flex: '1 1 auto', minWidth: 120, textAlign: 'left',
                      padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                      background: active ? 'var(--theme-accent-bg, #0969da1a)' : 'var(--theme-bg-tertiary, #f6f8fa)',
                      border: `1px solid ${active ? 'var(--theme-accent, #0969da)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
                      color: 'var(--theme-text, #1f2328)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: ex.connected ? '#22c55e' : '#9ca3af',
                      }} />
                      {ex.mode === 'local' ? ex.label : `🌐 ${ex.label}`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 2 }}>
                      {ex.isHome ? '默认 · 本地直连' : '远端执行节点'}
                    </div>
                  </button>
                );
              })}
            </div>
            <span style={helpTextStyle}>
              会话建好后归属固定。工作目录与模型均取自所选节点。
            </span>
          </div>
        )}

        <div style={formGroupStyle}>
          <label style={labelStyle}>Working Directory:</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              style={inputStyle}
              placeholder="留空 = 自动按时间命名（放在日志目录旁）"
            />
            <button onClick={handleBrowse} style={browseBtnStyle} title="Select directory with file picker">
              📁 Browse
            </button>
          </div>
          <span style={helpTextStyle}>
            {isAutoDir
              ? '留空将自动在 ~/.agent-with-u/workspaces/session-时间戳/ 下新建目录（与日志目录同级）'
              : 'The directory where Claude will read/write files and run commands'}
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
              {execBackends.map((b) => (
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

      {dirPickerOpen && (
        <ServerDirPicker
          execKey={execKey}
          initialPath={isAutoDir ? undefined : workingDir}
          onSelect={(p) => { setWorkingDir(p); setDirPickerOpen(false); }}
          onCancel={() => setDirPickerOpen(false)}
        />
      )}
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

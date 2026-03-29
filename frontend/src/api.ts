/**
 * api.ts: Bridge between React and Python backend via WebSocket.
 *
 * Protocol:
 *   Client → Server: {"id": "r1", "method": "listSessions", "params": [...]}
 *   Server → Client: {"id": "r1", "result": "..."}           // response
 *   Server → Client: {"event": "streamDelta",    "data": "..."} // push
 *   Server → Client: {"event": "sessionUpdated", "data": "..."} // push
 *
 * Tauri mode:  Rust sidecar starts Python backend automatically (release).
 *              In dev, run `python -m src.ws_main` separately.
 * Browser mode: Run `python -m src.ws_main` separately, open localhost.
 * Fallback:   Mock bridge if WebSocket unavailable after timeout.
 */

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;
type PermissionRequestCallback = (data: any) => void;

const WS_PORT_DEFAULT = 44321;
const WS_CONNECT_TIMEOUT_MS = 3000;

let ws: WebSocket | null = null;
let wsReady: Promise<void>;
let useMock = false;

type ConnectionStatusCallback = (connected: boolean) => void;
let connectionStatusCallbacks: ConnectionStatusCallback[] = [];

let reqCounter = 0;
const pending = new Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }>();
let streamCallbacks: StreamDeltaCallback[] = [];
let sessionUpdateCallbacks: SessionUpdateCallback[] = [];
let permissionRequestCallbacks: PermissionRequestCallback[] = [];

function nextId() {
  return `r${++reqCounter}`;
}

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
}

// ── 动态导入 Tauri API（浏览器环境下 graceful fallback）──────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

async function tauriOpenDialog(opts: {
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open(opts as any);
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

async function tauriSaveDialog(opts: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const result = await save(opts as any);
    return result ?? null;
  } catch {
    return null;
  }
}

// ── WebSocket 初始化 + 自动重连 ───────────────────────────────

async function getWsPort(): Promise<number> {
  if (isTauri()) {
    const port = await tauriInvoke<number>('get_ws_port');
    if (port) return port;
  }
  return WS_PORT_DEFAULT;
}

let wsPort = WS_PORT_DEFAULT;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000; // 指数退避：1s → 2s → 4s … 最大 30s
const MAX_RECONNECT_DELAY = 30000;

function scheduleReconnect() {
  if (reconnectTimer !== null) return; // 已有排队，不重复
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect(wsPort);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function handleMessage(e: MessageEvent) {
  try {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg.result ?? null);
    } else if (msg.event === 'streamDelta') {
      const delta = JSON.parse(msg.data);
      streamCallbacks.forEach((cb) => cb(delta));
    } else if (msg.event === 'sessionUpdated') {
      const data = JSON.parse(msg.data);
      sessionUpdateCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'permissionRequest') {
      const data = JSON.parse(msg.data);
      permissionRequestCallbacks.forEach((cb) => cb(data));
    }
  } catch (err) {
    console.error('[api] message parse error:', err);
  }
}

/**
 * 建立一次 WebSocket 连接。
 * onSettled 在首次 open/close/error 时回调一次（用于 wsReady 的 resolve）。
 */
function doConnect(port: number, onSettled?: () => void) {
  const url = `ws://127.0.0.1:${port}`;
  const socket = new WebSocket(url);
  let settled = false;
  const settle = () => { if (!settled) { settled = true; onSettled?.(); } };

  socket.onopen = () => {
    ws = socket;
    useMock = false;
    reconnectDelay = 1000; // 成功后重置退避
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    console.log(`[api] Connected to ${url}`);
    connectionStatusCallbacks.forEach((cb) => cb(true));
    settle();
  };

  // onerror 之后一定会触发 onclose，在 onclose 里统一处理
  socket.onerror = () => settle();

  socket.onmessage = handleMessage;

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      // ★ 连接断开时 reject 所有挂起请求，让调用方能区分连接错误和正常 null 响应
      pending.forEach(({ reject }) => reject(new Error('WebSocket connection lost')));
      pending.clear();
      connectionStatusCallbacks.forEach((cb) => cb(false));
    }
    settle();
    scheduleReconnect(); // 断线后自动重连
  };
}

wsReady = (async () => {
  wsPort = await getWsPort();
  await new Promise<void>((resolve) => {
    // 首次连接超时：不进 mock 模式，继续重试
    const timer = setTimeout(() => {
      console.warn(`[api] Initial connect timeout, will keep retrying…`);
      connectionStatusCallbacks.forEach((cb) => cb(false));
      scheduleReconnect();
      resolve();
    }, WS_CONNECT_TIMEOUT_MS);
    doConnect(wsPort, () => { clearTimeout(timer); resolve(); });
  });
})();

// ── RPC 调用 ─────────────────────────────────────────────────

async function call(method: string, ...params: any[]): Promise<any> {
  await wsReady;
  if (useMock || !ws || ws.readyState !== WebSocket.OPEN) {
    return mockDispatch(method, params);
  }
  try {
    return await new Promise((resolve, reject) => {
      const id = nextId();
      pending.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  } catch (err) {
    // ★ 连接断开导致的 reject，打印警告并返回 null 保持兼容
    console.warn(`[api] call "${method}" failed:`, err);
    return null;
  }
}

async function send(method: string, ...params: any[]): Promise<void> {
  await wsReady;
  if (useMock || !ws || ws.readyState !== WebSocket.OPEN) {
    mockDispatch(method, params);
    return;
  }
  const id = nextId();
  ws.send(JSON.stringify({ id, method, params }));
}

// ── 对话框（Tauri plugin-dialog）────────────────────────────

async function nativeOpenDirectory(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return tauriOpenDialog({ directory: true, multiple: false, defaultPath: initialPath });
  }
  return null;
}

async function nativeSaveFile(defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    return tauriSaveDialog({
      defaultPath,
      // Windows file dialogs don't support multi-part extensions like 'tar.gz';
      // use 'gz' to match compressed archives, plus a catch-all fallback.
      filters: [
        { name: 'Tar Archive (*.tar.gz)', extensions: ['gz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
  }
  return null;
}

async function nativeOpenFile(): Promise<string | null> {
  if (isTauri()) {
    return tauriOpenDialog({
      filters: [
        { name: 'Tar Archive (*.tar.gz)', extensions: ['gz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
  }
  return null;
}

// ═══════════════════════════════════════
//  Exported API（接口与旧版完全相同）
// ═══════════════════════════════════════
export const api = {
  async readClipboardImage(): Promise<any | null> {
    const result = await call('readClipboardImage');
    try { return JSON.parse(result); } catch { return null; }
  },

  async sendMessage(payload: any): Promise<void> {
    await send('sendMessage', JSON.stringify(payload));
  },

  async abortMessage(sessionId: string): Promise<void> {
    await send('abortMessage', sessionId);
  },

  onStreamDelta(callback: StreamDeltaCallback): () => void {
    streamCallbacks.push(callback);
    return () => { streamCallbacks = streamCallbacks.filter((cb) => cb !== callback); };
  },

  onSessionUpdated(callback: SessionUpdateCallback): () => void {
    sessionUpdateCallbacks.push(callback);
    return () => { sessionUpdateCallbacks = sessionUpdateCallbacks.filter((cb) => cb !== callback); };
  },

  async executeCommand(payload: {
    command: string; sessionId: string; backendId: string; args?: any;
  }): Promise<any> {
    const result = await call('executeCommand', JSON.stringify(payload));
    try { return JSON.parse(result); } catch { return null; }
  },

  async listSessions(): Promise<any[]> {
    const result = await call('listSessions');
    try { return JSON.parse(result); } catch { return []; }
  },

  async loadSession(id: string): Promise<any | null> {
    const result = await call('loadSession', id);
    try { return JSON.parse(result); } catch { return null; }
  },

  async deleteSession(id: string): Promise<boolean> {
    return await call('deleteSession', id);
  },

  async getBackends(): Promise<any[]> {
    const result = await call('getBackends');
    try { return JSON.parse(result); } catch { return []; }
  },

  async saveBackend(config: any): Promise<void> {
    await send('saveBackend', JSON.stringify(config));
  },

  async deleteBackend(id: string): Promise<void> {
    await send('deleteBackend', id);
  },

  async selectDirectory(initialPath?: string): Promise<string | null> {
    return nativeOpenDirectory(initialPath);
  },

  async migrateSession(sourceSessionId: string, targetBackendId: string): Promise<any> {
    const result = await call('migrateSession', JSON.stringify({ sourceSessionId, targetBackendId }));
    try { return JSON.parse(result); } catch { return null; }
  },

  async createSession(workingDir: string, backendId: string): Promise<any> {
    const result = await call('createSession', workingDir, backendId);
    try { return JSON.parse(result); } catch { return null; }
  },

  async selectExportPath(): Promise<string | null> {
    return nativeSaveFile('export.tar.gz');
  },

  async selectImportPath(): Promise<string | null> {
    return nativeOpenFile();
  },

  async exportData(targetPath: string): Promise<any> {
    const result = await call('exportData', targetPath);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '导出失败' }; }
  },

  async importData(sourcePath: string): Promise<any> {
    const result = await call('importData', sourcePath);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '导入失败' }; }
  },

  /** Returns true if connected to the real backend, false if in mock mode. */
  isConnected(): boolean {
    return !useMock && ws !== null && ws.readyState === WebSocket.OPEN;
  },

  onConnectionStatus(callback: ConnectionStatusCallback): () => void {
    connectionStatusCallbacks.push(callback);
    return () => { connectionStatusCallbacks = connectionStatusCallbacks.filter((cb) => cb !== callback); };
  },

  async listDirectory(path: string): Promise<{ name: string; path: string; isDir: boolean }[]> {
    const result = await call('listDirectory', path);
    try {
      const data = JSON.parse(result);
      if (Array.isArray(data)) return data;
      return [];
    } catch { return []; }
  },

  async getAppConfig(): Promise<any> {
    const result = await call('getAppConfig');
    try { return JSON.parse(result); } catch { return {}; }
  },

  async setAppConfig(config: any): Promise<any> {
    const result = await call('setAppConfig', JSON.stringify(config));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存配置失败' }; }
  },

  /** 响应后端发出的 permissionRequest，granted=true 继续，false 取消。 */
  async openLoginTerminal(backendId: string): Promise<{ status: string; message?: string }> {
    const result = await call('openLoginTerminal', backendId);
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  async openModelTerminal(backendId: string): Promise<{ status: string; message?: string }> {
    const result = await call('openModelTerminal', backendId);
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  async getClaudeSettings(): Promise<{ model: string }> {
    const result = await call('getClaudeSettings');
    try { return JSON.parse(result); } catch { return { model: '' }; }
  },

  async getMcpServers(): Promise<Record<string, any>> {
    const result = await call('getMcpServers');
    try { return JSON.parse(result) || {}; } catch { return {}; }
  },

  async saveMcpServers(servers: Record<string, any>): Promise<{ status: string; message?: string }> {
    const result = await call('saveMcpServers', JSON.stringify(servers));
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  async grantPermission(sessionId: string, granted: boolean, skipRest: boolean = false): Promise<void> {
    await send('grantPermission', sessionId, granted, skipRest);
  },

  onPermissionRequest(callback: PermissionRequestCallback): () => void {
    permissionRequestCallbacks.push(callback);
    return () => { permissionRequestCallbacks = permissionRequestCallbacks.filter((cb) => cb !== callback); };
  },

  /** 打开外部 cmd 窗口实时刷日志 */
  async openLogViewer(): Promise<void> {
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_log_viewer');
      } catch (e) {
        console.error('Failed to open log viewer:', e);
      }
    }
  },
};

// ═══════════════════════════════════════
//  Mock bridge（WebSocket 不可用时的 fallback）
// ═══════════════════════════════════════

const mockBackends: any[] = [
  { id: 'claude-agent-sdk-default', type: 'claude-agent-sdk', label: 'Claude Code (Agent SDK)', model: 'sonnet', env: {} },
];
let mockAppConfig: any = { fontSize: 14, renderMarkdown: true, exportFormat: 'markdown', theme: 'dark' };

function mockDispatch(method: string, params: any[]): any {
  switch (method) {
    case 'readClipboardImage': return 'null';
    case 'getAppConfig': return JSON.stringify(mockAppConfig);
    case 'setAppConfig':
      mockAppConfig = JSON.parse(params[0]);
      return JSON.stringify({ status: 'ok' });
    case 'sendMessage': {
      const payload = JSON.parse(params[0]);
      const msgId = payload.messageId || 'mock-' + Date.now();
      setTimeout(() => {
        streamCallbacks.forEach((cb) => cb({
          sessionId: payload.sessionId, messageId: msgId, type: 'text_delta',
          text: 'Mock response — WebSocket not connected.\n\nRun: `python -m src.ws_main`\n\nSlash commands work! Try `/help`.',
        }));
        setTimeout(() => {
          streamCallbacks.forEach((cb) => cb({
            sessionId: payload.sessionId, messageId: msgId, type: 'done',
            usage: { inputTokens: 100, outputTokens: 50 },
          }));
        }, 100);
      }, 300);
      return null;
    }
    case 'abortMessage': return null;
    case 'executeCommand': {
      const p = JSON.parse(params[0]);
      if (p.command === 'compact') return JSON.stringify({ status: 'ok', removed: 5, remaining: 6 });
      return JSON.stringify({ status: 'ok' });
    }
    case 'createSession':
      return JSON.stringify({
        id: 'mock-' + Date.now(), title: 'Mock session',
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
        messages: [], backendId: params[1], autoContinue: true,
      });
    case 'listSessions': return '[]';
    case 'loadSession': return 'null';
    case 'deleteSession': return true;
    case 'getBackends': return JSON.stringify(mockBackends);
    case 'saveBackend': {
      const cfg = JSON.parse(params[0]);
      const idx = mockBackends.findIndex((b) => b.id === cfg.id);
      if (idx >= 0) mockBackends[idx] = cfg; else mockBackends.push(cfg);
      return null;
    }
    case 'deleteBackend': {
      const idx = mockBackends.findIndex((b) => b.id === params[0]);
      if (idx >= 0) mockBackends.splice(idx, 1);
      return null;
    }
    default: return null;
  }
}

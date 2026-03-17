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

const WS_PORT_DEFAULT = 44321;
const WS_CONNECT_TIMEOUT_MS = 3000;

let ws: WebSocket | null = null;
let wsReady: Promise<void>;
let useMock = false;

type ConnectionStatusCallback = (connected: boolean) => void;
let connectionStatusCallbacks: ConnectionStatusCallback[] = [];

let reqCounter = 0;
const pending = new Map<string, (result: any) => void>();
let streamCallbacks: StreamDeltaCallback[] = [];
let sessionUpdateCallbacks: SessionUpdateCallback[] = [];

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

// ── WebSocket 初始化 ──────────────────────────────────────────

async function getWsPort(): Promise<number> {
  if (isTauri()) {
    const port = await tauriInvoke<number>('get_ws_port');
    if (port) return port;
  }
  return WS_PORT_DEFAULT;
}

wsReady = (async () => {
  const port = await getWsPort();
  return new Promise<void>((resolve) => {
    const url = `ws://127.0.0.1:${port}`;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.warn(`[api] WebSocket timeout (${url}), using mock bridge`);
        useMock = true;
        connectionStatusCallbacks.forEach((cb) => cb(false));
        resolve();
      }
    }, WS_CONNECT_TIMEOUT_MS);

    const socket = new WebSocket(url);

    socket.onopen = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        ws = socket;
        console.log(`[api] Connected to ${url}`);
        connectionStatusCallbacks.forEach((cb) => cb(true));
        resolve();
      }
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.warn(`[api] WebSocket error (${url}), using mock bridge`);
        useMock = true;
        connectionStatusCallbacks.forEach((cb) => cb(false));
        resolve();
      }
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id)!;
          pending.delete(msg.id);
          cb(msg.result ?? null);
        } else if (msg.event === 'streamDelta') {
          const delta = JSON.parse(msg.data);
          streamCallbacks.forEach((cb) => cb(delta));
        } else if (msg.event === 'sessionUpdated') {
          const data = JSON.parse(msg.data);
          sessionUpdateCallbacks.forEach((cb) => cb(data));
        }
      } catch (err) {
        console.error('[api] message parse error:', err);
      }
    };

    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        connectionStatusCallbacks.forEach((cb) => cb(false));
      }
    };
  });
})();

// ── RPC 调用 ─────────────────────────────────────────────────

async function call(method: string, ...params: any[]): Promise<any> {
  await wsReady;
  if (useMock || !ws || ws.readyState !== WebSocket.OPEN) {
    return mockDispatch(method, params);
  }
  return new Promise((resolve) => {
    const id = nextId();
    pending.set(id, resolve);
    ws!.send(JSON.stringify({ id, method, params }));
  });
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

  async abortMessage(backendId: string): Promise<void> {
    await send('abortMessage', backendId);
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

  async getAppConfig(): Promise<any> {
    const result = await call('getAppConfig');
    try { return JSON.parse(result); } catch { return {}; }
  },

  async setAppConfig(config: any): Promise<any> {
    const result = await call('setAppConfig', JSON.stringify(config));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存配置失败' }; }
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

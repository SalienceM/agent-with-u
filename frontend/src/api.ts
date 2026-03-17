/**
 * api.ts: Bridge between React and Python backend via WebSocket.
 *
 * Protocol:
 *   Client → Server: {"id": "r1", "method": "listSessions", "params": [...]}
 *   Server → Client: {"id": "r1", "result": "..."}           // response
 *   Server → Client: {"event": "streamDelta",    "data": "..."} // push
 *   Server → Client: {"event": "sessionUpdated", "data": "..."} // push
 *
 * In Tauri: Rust sidecar starts Python backend automatically.
 * In dev:   Run `python -m src.ws_main` separately.
 * Fallback: Mock bridge if WebSocket unavailable after timeout.
 */

import { invoke } from '@tauri-apps/api/core';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;

const WS_PORT_DEFAULT = 44321;
const WS_CONNECT_TIMEOUT_MS = 3000;

let ws: WebSocket | null = null;
let wsReady: Promise<void>;
let useMock = false;

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

async function getWsPort(): Promise<number> {
  if (isTauri()) {
    try {
      return await invoke<number>('get_ws_port');
    } catch {
      return WS_PORT_DEFAULT;
    }
  }
  return WS_PORT_DEFAULT;
}

// ── WebSocket 初始化 ──────────────────────────────────────────

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
        resolve();
      }
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.warn(`[api] WebSocket error (${url}), using mock bridge`);
        useMock = true;
        resolve();
      }
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
          // Response to a request
          const resolve = pending.get(msg.id)!;
          pending.delete(msg.id);
          resolve(msg.result ?? null);
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
        console.warn('[api] WebSocket closed');
      }
    };
  });
})();

// ── RPC 调用 ─────────────────────────────────────────────────

async function call(method: string, ...params: any[]): Promise<any> {
  await wsReady;
  if (useMock) {
    return mockDispatch(method, params);
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[api] WebSocket not open, falling back to mock');
    return mockDispatch(method, params);
  }
  return new Promise((resolve) => {
    const id = nextId();
    pending.set(id, resolve);
    ws!.send(JSON.stringify({ id, method, params }));
  });
}

// fire-and-forget (sendMessage / abortMessage)
async function send(method: string, ...params: any[]): Promise<void> {
  await wsReady;
  if (useMock) {
    mockDispatch(method, params);
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    const id = nextId();
    // No pending entry: we don't wait for a response
    ws.send(JSON.stringify({ id, method, params }));
  }
}

// ── 对话框（Tauri plugin-dialog / 浏览器 fallback）──────────

async function nativeOpenDirectory(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const result = await dialogOpen({
        directory: true,
        multiple: false,
        defaultPath: initialPath,
      });
      return typeof result === 'string' ? result : null;
    } catch {
      return null;
    }
  }
  return null; // 浏览器环境无法选目录
}

async function nativeSaveFile(defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const result = await dialogSave({
        defaultPath,
        filters: [{ name: 'Tar 归档', extensions: ['tar.gz'] }],
      });
      return result ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function nativeOpenFile(): Promise<string | null> {
  if (isTauri()) {
    try {
      const result = await dialogOpen({
        multiple: false,
        filters: [{ name: 'Tar 归档', extensions: ['tar.gz'] }],
      });
      return typeof result === 'string' ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ═══════════════════════════════════════
//  Exported API（接口与旧版完全相同）
// ═══════════════════════════════════════
export const api = {
  async readClipboardImage(): Promise<any | null> {
    const result = await call('readClipboardImage');
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  async sendMessage(payload: any): Promise<void> {
    await send('sendMessage', JSON.stringify(payload));
  },

  async abortMessage(backendId: string): Promise<void> {
    await send('abortMessage', backendId);
  },

  onStreamDelta(callback: StreamDeltaCallback): () => void {
    streamCallbacks.push(callback);
    return () => {
      streamCallbacks = streamCallbacks.filter((cb) => cb !== callback);
    };
  },

  onSessionUpdated(callback: SessionUpdateCallback): () => void {
    sessionUpdateCallbacks.push(callback);
    return () => {
      sessionUpdateCallbacks = sessionUpdateCallbacks.filter((cb) => cb !== callback);
    };
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
    case 'readClipboardImage':
      return 'null';
    case 'getAppConfig':
      return JSON.stringify(mockAppConfig);
    case 'setAppConfig':
      mockAppConfig = JSON.parse(params[0]);
      return JSON.stringify({ status: 'ok' });
    case 'sendMessage': {
      const payload = JSON.parse(params[0]);
      const msgId = payload.messageId || 'mock-' + Date.now();
      setTimeout(() => {
        streamCallbacks.forEach((cb) =>
          cb({
            sessionId: payload.sessionId, messageId: msgId, type: 'text_delta',
            text: 'Mock response — WebSocket not connected. Run `python -m src.ws_main`.\n\nSlash commands work! Try `/help`.',
          })
        );
        setTimeout(() => {
          streamCallbacks.forEach((cb) =>
            cb({ sessionId: payload.sessionId, messageId: msgId, type: 'done', usage: { inputTokens: 100, outputTokens: 50 } })
          );
        }, 100);
      }, 300);
      return null;
    }
    case 'abortMessage':
      return null;
    case 'executeCommand': {
      const p = JSON.parse(params[0]);
      if (p.command === 'compact') return JSON.stringify({ status: 'ok', removed: 5, remaining: 6 });
      return JSON.stringify({ status: 'ok' });
    }
    case 'createSession':
      return JSON.stringify({
        id: 'mock-session-' + Date.now(), title: 'Mock session',
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
        messages: [], backendId: params[1], autoContinue: true,
      });
    case 'listSessions':
      return '[]';
    case 'loadSession':
      return 'null';
    case 'deleteSession':
      return true;
    case 'getBackends':
      return JSON.stringify(mockBackends);
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
    default:
      return null;
  }
}

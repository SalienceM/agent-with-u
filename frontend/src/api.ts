/**
 * api.ts: Bridge between React and Python backend.
 *
 * Supports two modes:
 * - WebSocket mode (Tauri): Python backend runs as WebSocket server
 * - QWebChannel mode (Qt): Qt host exposes Python objects via QWebChannel
 *
 * Protocol (WebSocket):
 *   Client → Server: {"id": "r1", "method": "listSessions", "params": [...]}
 *   Server → Client: {"id": "r1", "result": "..."}           // response
 *   Server → Client: {"event": "streamDelta",    "data": "..."} // push
 *   Server → Client: {"event": "sessionUpdated", "data": "..."} // push
 *
 * Protocol (QWebChannel):
 *   Client calls: bridge.methodName(...params)
 *   Server responds via Slot decorator return value
 */

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;
type PermissionRequestCallback = (data: any) => void;

export interface SkillInfo {
  name: string;
  content: string;               // SKILL.md 完整内容
  isGlobal: boolean;             // 是否已全局激活（~/.claude/skills/）
  isProject: boolean;            // 是否已在当前工作目录激活
  projectActivations: string[];  // 所有已激活的工作目录列表
  description?: string;          // frontmatter description 字段
  isDefault?: boolean;           // ★ 默认档：新建 session 时自动绑定
  hasCallPy?: boolean;           // 是否有 call.py（python-script 类型）
  hasSecrets?: boolean;          // 是否已保存凭据
  hasSecretsSchema?: boolean;    // 是否有 secrets.schema.json
  manifest?: Record<string, any> | null;  // manifest.json 内容（插件包）
  backend?: string;
  type?: string;
  inputSchema?: Record<string, any>;
}

// QWebChannel support for Qt mode
let bridge: any = null;
let useQWebChannel = false;

// Check if QWebChannel is available (Qt mode)
function initQWebChannel() {
  if (typeof QWebChannel !== 'undefined') {
    new QWebChannel((channel: any) => {
      bridge = channel.objects.bridge;
      useQWebChannel = true;
      console.log('[api] Using QWebChannel mode');
    });
  }
}

// Initialize QWebChannel immediately (if available)
initQWebChannel();

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

type SttStreamTextCallback = (data: { text: string; isFinal: boolean }) => void;
let sttStreamCallbacks: SttStreamTextCallback[] = [];

type SttStreamEndCallback = (data: { reason: string }) => void;
let sttStreamEndCallbacks: SttStreamEndCallback[] = [];

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
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open(opts as any);
  return typeof result === 'string' ? result : null;
}

async function tauriSaveDialog(opts: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const result = await save(opts as any);
  return result ?? null;
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
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 25000; // 每 25 秒发送一次心跳 ping

function scheduleReconnect() {
  if (reconnectTimer !== null) return; // 已有排队，不重复
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect(wsPort);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function handleMessage(e: MessageEvent) {
  if (typeof e.data !== 'string') return;
  try {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error !== undefined) {
        reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      } else {
        resolve(msg.result ?? null);
      }
    } else if (msg.event === 'streamDelta') {
      const delta = JSON.parse(msg.data);
      streamCallbacks.forEach((cb) => cb(delta));
    } else if (msg.event === 'sessionUpdated') {
      const data = JSON.parse(msg.data);
      sessionUpdateCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'permissionRequest') {
      const data = JSON.parse(msg.data);
      permissionRequestCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamText') {
      const data = JSON.parse(msg.data);
      sttStreamCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamEnd') {
      const data = JSON.parse(msg.data);
      sttStreamEndCallbacks.forEach((cb) => cb(data));
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
    // ★ 启动心跳定时器：定期发送 RPC ping 保持连接活跃
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const id = nextId();
        // fire-and-forget ping，不注册 pending（丢失也无所谓）
        try { ws.send(JSON.stringify({ id, method: 'ping', params: [] })); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    settle();
  };

  // onerror 之后一定会触发 onclose，在 onclose 里统一处理
  socket.onerror = () => settle();

  socket.onmessage = handleMessage;

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      // ★ 停止心跳
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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
  // QWebChannel mode (Qt) - direct method call
  if (useQWebChannel && bridge && bridge[method]) {
    try {
      const result = bridge[method](...params);
      console.log(`[api] ${method} (QWebChannel) ->`, result);
      return result;
    } catch (e: any) {
      console.error(`[api] ${method} QWebChannel call failed:`, e);
      return null;
    }
  }

  // WebSocket mode
  await wsReady;
  if (useMock || !ws || ws.readyState !== WebSocket.OPEN) {
    const mockResult = mockDispatch(method, params);
    console.log(`[api] ${method} -> mock:`, mockResult);
    return mockResult;
  }
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const mockResult = mockDispatch(method, params);
      console.log(`[api] ${method} (late check) -> mock:`, mockResult);
      return mockResult;
    }
    return await new Promise((resolve, reject) => {
      const id = nextId();
      pending.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  } catch (err) {
    console.warn(`[api] call "${method}" failed:`, err);
    return null;
  }
}

async function send(method: string, ...params: any[]): Promise<void> {
  // QWebChannel mode - no async send, just call
  if (useQWebChannel && bridge && bridge[method]) {
    try {
      bridge[method](...params);
    } catch (e: any) {
      console.error(`[api] ${method} QWebChannel send failed:`, e);
    }
    return;
  }

  // WebSocket mode
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

// Tauri v2 + GTK/XDG 在 defaultPath 是纯文件名时有时不弹出对话框。
// 这里把文件名 join 到下载目录再传入，避免调用失败。
async function resolveDefaultSavePath(filename?: string): Promise<string | undefined> {
  if (!filename) return undefined;
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path');
    const dir = await downloadDir();
    return await join(dir, filename);
  } catch (e) {
    console.warn('[api] resolveDefaultSavePath fallback:', e);
    return filename;
  }
}

async function nativeSaveFile(defaultFilename?: string): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('文件对话框仅在桌面应用中可用');
  }
  const defaultPath = await resolveDefaultSavePath(defaultFilename);
  return tauriSaveDialog({
    defaultPath,
    // 注意：Tauri 的 filters.extensions 只支持单段扩展，写 'tar.gz' 会被拆错。
    // 保留一个通配 filter 以防平台校验严格。
    filters: [
      { name: 'Tar Archive', extensions: ['gz', 'tgz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
}

async function nativeOpenFile(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('文件对话框仅在桌面应用中可用');
  }
  return tauriOpenDialog({
    filters: [
      { name: 'Tar Archive', extensions: ['gz', 'tgz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
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

  async renameSession(sessionId: string, newTitle: string): Promise<{ status: string; message?: string }> {
    const result = await call('renameSession', sessionId, newTitle);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updateSessionConstraints(sessionId: string, constraints: string | { constraints: string }): Promise<{ status: string; message?: string }> {
    const payload = JSON.stringify(constraints);
    const result = await call('updateSessionConstraints', sessionId, payload);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
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

  /** 清空 session 消息历史和 agent session ID，但保留 session 本身（目录/能力不变）。 */
  async clearSessionContext(sessionId: string): Promise<void> {
    await call('clearSessionContext', sessionId);
  },

  async selectExportPath(): Promise<string | null> {
    return nativeSaveFile('export.tar.gz');
  },

  async selectImportPath(): Promise<string | null> {
    return nativeOpenFile();
  },

  async exportData(targetPath: string): Promise<any> {
    const result = await call('exportData', targetPath);
    if (result == null) {
      return { status: 'error', message: 'backend 无响应（exportData 返回为空）' };
    }
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: `返回值解析失败: ${String(result).slice(0, 120)}` }; }
  },

  async importData(sourcePath: string): Promise<any> {
    const result = await call('importData', sourcePath);
    if (result == null) {
      return { status: 'error', message: 'backend 无响应（importData 返回为空）' };
    }
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: `返回值解析失败: ${String(result).slice(0, 120)}` }; }
  },

  /** Returns true if connected to the real backend, false if in mock mode. */
  isConnected(): boolean {
    return !useMock && ws !== null && ws.readyState === WebSocket.OPEN;
  },

  onConnectionStatus(callback: ConnectionStatusCallback): () => void {
    connectionStatusCallbacks.push(callback);
    return () => { connectionStatusCallbacks = connectionStatusCallbacks.filter((cb) => cb !== callback); };
  },

  async listDirectory(path: string, workingDir?: string): Promise<{ name: string; path: string; isDir: boolean }[]> {
    const result = await call('listDirectory', path, workingDir || '');
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

  // ── Prompt 模板库 ─────────────────────────────────────────────────────
  async listPrompts(): Promise<any[]> {
    const result = await call('listPrompts');
    try { return JSON.parse(result) || []; } catch { return []; }
  },

  async savePrompt(name: string, content: string, icon: string = '📝'): Promise<{ status: string; message?: string }> {
    const result = await call('savePrompt', name, content, icon);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deletePrompt(name: string): Promise<{ status: string; message?: string }> {
    const result = await call('deletePrompt', name);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async renamePrompt(oldName: string, newName: string, content: string): Promise<{ status: string; message?: string }> {
    const result = await call('renamePrompt', oldName, newName, content);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updatePromptIcon(name: string, icon: string): Promise<{ status: string; message?: string }> {
    const result = await call('updatePromptIcon', name, icon);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updateSessionAbilities(sessionId: string, abilities: { skills: string[]; prompts: string[] }): Promise<{ status: string; message?: string }> {
    const result = await call('updateSessionAbilities', sessionId, JSON.stringify(abilities));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async setPromptDefault(name: string, isDefault: boolean): Promise<{ status: string; message?: string }> {
    const result = await call('setPromptDefault', name, isDefault);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async setSkillDefault(name: string, isDefault: boolean): Promise<{ status: string; message?: string }> {
    const result = await call('setSkillDefault', name, isDefault);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async getDefaultAbilities(): Promise<{ skills: string[]; prompts: string[] }> {
    const result = await call('getDefaultAbilities');
    try { return JSON.parse(result) || { skills: [], prompts: [] }; }
    catch { return { skills: [], prompts: [] }; }
  },

  // ── Skill 孵化库 ──────────────────────────────────────────────────────
  async listSkills(workingDir: string = ''): Promise<SkillInfo[]> {
    const result = await call('listSkills', workingDir);
    try { return JSON.parse(result) || []; } catch { return []; }
  },

  async saveSkill(name: string, content: string): Promise<{ status: string; message?: string }> {
    const result = await call('saveSkill', name, content);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deleteSkill(name: string): Promise<{ status: string; message?: string }> {
    const result = await call('deleteSkill', name);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async activateSkill(name: string, scope: 'global' | 'project', workingDir: string = ''): Promise<{ status: string; message?: string }> {
    const result = await call('activateSkill', name, scope, workingDir);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deactivateSkill(name: string, scope: 'global' | 'project', workingDir: string = ''): Promise<{ status: string; message?: string }> {
    const result = await call('deactivateSkill', name, scope, workingDir);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async renameSkill(oldName: string, newName: string, newContent: string): Promise<{ status: string; message?: string }> {
    const result = await call('renameSkill', oldName, newName, newContent);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  // ── 插件包安装 ────────────────────────────────────────────────────────
  async installSkillPackage(pkgPath: string, pkgBase64: string = ''): Promise<{ status: string; manifest?: any; message?: string }> {
    const result = await call('installSkillPackage', pkgPath, pkgBase64);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  // ── Secrets 管理（凭据不传 LLM）────────────────────────────────────────
  async getSkillSecretsSchema(name: string): Promise<{ fields: Array<{ key: string; label: string; type: 'text' | 'password' | 'textarea'; required?: boolean; placeholder?: string }> } | null> {
    const result = await call('getSkillSecretsSchema', name);
    try { return result ? JSON.parse(result) : null; } catch { return null; }
  },

  async setSkillSecrets(name: string, secrets: Record<string, string>): Promise<{ status: string; message?: string }> {
    const result = await call('setSkillSecrets', name, JSON.stringify(secrets));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async getSkillSecretsPresence(name: string): Promise<string[]> {
    const result = await call('getSkillSecretsPresence', name);
    try { return result ? JSON.parse(result) : []; } catch { return []; }
  },

  async grantPermission(sessionId: string, granted: boolean, skipRest: boolean = false): Promise<void> {
    await send('grantPermission', sessionId, granted, skipRest);
  },

  onPermissionRequest(callback: PermissionRequestCallback): () => void {
    permissionRequestCallbacks.push(callback);
    return () => { permissionRequestCallbacks = permissionRequestCallbacks.filter((cb) => cb !== callback); };
  },

  /** 获取应用版本号（格式 YY.MM.DD，由 build_all.bat 构建时写入）。 */
  async getAppVersion(): Promise<string> {
    const result = await call('getAppVersion');
    return typeof result === 'string' && result ? result : '0.0.0-dev';
  },

  // ── STT 语音转文字 ──────────────────────────────────────────

  async sttCheckLocal(): Promise<{ installed: boolean }> {
    const r = await call('sttCheckLocal');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { installed: false }; }
  },

  async sttInstallLocal(): Promise<{ ok: boolean; output?: string }> {
    const r = await call('sttInstallLocal');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, output: 'parse error' }; }
  },

  async getSttConfig(): Promise<any> {
    const r = await call('getSttConfig');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return {}; }
  },

  async saveSttConfig(config: any): Promise<boolean> {
    const r = await call('saveSttConfig', JSON.stringify(config));
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return !!d?.ok;
    } catch { return false; }
  },

  async sttTranscribe(audioBase64: string, configOverride?: any): Promise<{ ok: boolean; text?: string; error?: string }> {
    const r = await call('sttTranscribe', audioBase64, JSON.stringify(configOverride || {}));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async sttRefine(text: string, sessionId?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const r = await call('sttRefine', text, sessionId || '');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async sttStreamStart(configOverride?: any): Promise<{ ok: boolean; error?: string }> {
    const r = await call('sttStreamStart', JSON.stringify(configOverride || {}));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  sttStreamAudioBinary(pcmBuffer: ArrayBuffer): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pcmBuffer);
    }
  },

  async sttStreamStop(): Promise<{ ok: boolean; text?: string; error?: string }> {
    const r = await call('sttStreamStop');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  onSttStreamText(cb: SttStreamTextCallback): () => void {
    sttStreamCallbacks.push(cb);
    return () => { sttStreamCallbacks = sttStreamCallbacks.filter((c) => c !== cb); };
  },

  onSttStreamEnd(cb: SttStreamEndCallback): () => void {
    sttStreamEndCallbacks.push(cb);
    return () => { sttStreamEndCallbacks = sttStreamEndCallbacks.filter((c) => c !== cb); };
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
    case 'clearSessionContext': return JSON.stringify({ success: true });
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
    case 'renameSession': return JSON.stringify({ status: 'ok' });
    case 'listPrompts': return JSON.stringify([]);
    case 'savePrompt': return JSON.stringify({ status: 'ok' });
    case 'deletePrompt': return JSON.stringify({ status: 'ok' });
    case 'renamePrompt': return JSON.stringify({ status: 'ok' });
    case 'updatePromptIcon': return JSON.stringify({ status: 'ok' });
    case 'updateSessionAbilities': return JSON.stringify({ status: 'ok' });
    case 'updateSessionConstraints': return JSON.stringify({ status: 'ok' });
    case 'setPromptDefault': return JSON.stringify({ status: 'ok' });
    case 'setSkillDefault': return JSON.stringify({ status: 'ok' });
    case 'getDefaultAbilities': return JSON.stringify({ skills: [], prompts: [] });
    case 'getAppVersion': return '0.0.0-dev';
    case 'sttCheckLocal': return JSON.stringify({ installed: false });
    case 'sttInstallLocal': return JSON.stringify({ ok: false, output: 'mock mode' });
    case 'getSttConfig': return JSON.stringify({ mode: 'api', language: 'zh', localModel: 'base', apiBaseUrl: '', apiKey: '', apiModel: 'whisper-1' });
    case 'saveSttConfig': return JSON.stringify({ ok: true });
    case 'sttTranscribe': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'sttRefine': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'sttStreamStart': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'sttStreamStop': return JSON.stringify({ ok: false, error: 'mock mode' });
    default: return null;
  }
}

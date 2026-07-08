/**
 * api.ts: Bridge between React and the Python backend over WebSocket.
 *
 * Protocol:
 *   Client → Server: {"id": "r1", "method": "listSessions", "params": [...]}
 *   Server → Client: {"id": "r1", "result": "..."}           // response
 *   Server → Client: {"event": "streamDelta",    "data": "..."} // push
 *   Server → Client: {"event": "sessionUpdated", "data": "..."} // push
 */

import type { GitDetectResult, GitStatusResult, GitDiffResult, GitCommitResult, GitLogResult, GitBranchesResult, GitPushPullResult, GitStashListResult } from './types/git';

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;
type PermissionRequestCallback = (data: any) => void;
type AssetChangedCallback = (stats: any) => void;

/** 已连接到本执行节点的一个 UI 客户端的展示信息。 */
export interface ConnectedClient {
  identity: string;       // Remote-User / token:xxx / "local" / "relay"
  identity_src: string;   // "loopback" | "forward-auth" | "token" | "relay" | "none"
  peer: string;           // "ip:port"，可能为空字符串
  via: 'local' | 'relay'; // 直连本机 sidecar，还是经中继来
  since: string;          // ISO timestamp（UTC）
}
type ClientsChangedCallback = (clients: ConnectedClient[]) => void;

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

const WS_PORT_DEFAULT = 44321;
const WS_CONNECT_TIMEOUT_MS = 3000;

let useMock = false;

type ConnectionStatusCallback = (connected: boolean) => void;
let connectionStatusCallbacks: ConnectionStatusCallback[] = [];

let reqCounter = 0;
const pending = new Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }>();
let streamCallbacks: StreamDeltaCallback[] = [];
let sessionUpdateCallbacks: SessionUpdateCallback[] = [];
let permissionRequestCallbacks: PermissionRequestCallback[] = [];
let assetChangedCallbacks: AssetChangedCallback[] = [];
let clientsChangedCallbacks: ClientsChangedCallback[] = [];

type SttStreamTextCallback = (data: { text: string; isFinal: boolean }) => void;
let sttStreamCallbacks: SttStreamTextCallback[] = [];

// ── 可视化 Loop 集成 ──────────────────────────────────────────
type LoopUpdatedCallback = (state: any) => void;
let loopUpdatedCallbacks: LoopUpdatedCallback[] = [];
type LoopProgressCallback = (data: { sessionId: string; seq: number; subStage: string; text: string }) => void;
let loopProgressCallbacks: LoopProgressCallback[] = [];
type LoopAsideDeltaCallback = (data: { sessionId: string; turnId: string; text: string }) => void;
let loopAsideDeltaCallbacks: LoopAsideDeltaCallback[] = [];

// ── 普通 session 侧挂：序列任务 + by-the-way ──────────────────
type SeqtaskUpdatedCallback = (data: { sessionId: string; seqTasks: any[]; seqAuto: boolean }) => void;
let seqtaskUpdatedCallbacks: SeqtaskUpdatedCallback[] = [];
type ChatAsideDeltaCallback = (data: { sessionId: string; turnId: string; text: string }) => void;
let chatAsideDeltaCallbacks: ChatAsideDeltaCallback[] = [];
type ChatAsideUpdatedCallback = (data: { sessionId: string; asides: any[]; asideBackendId?: string }) => void;
let chatAsideUpdatedCallbacks: ChatAsideUpdatedCallback[] = [];

type SttStreamEndCallback = (data: { reason: string }) => void;
let sttStreamEndCallbacks: SttStreamEndCallback[] = [];

// ── Git commit message 流式事件 ───────────────────────────────────
type GitCommitMsgDeltaCallback = (data: { workingDir: string; text: string }) => void;
type GitCommitMsgReadyCallback = (data: { workingDir: string; message: string; error?: string }) => void;
let gitCommitMsgDeltaCallbacks: GitCommitMsgDeltaCallback[] = [];
let gitCommitMsgReadyCallbacks: GitCommitMsgReadyCallback[] = [];

// ── 自动 AI commit 结果事件 ─────────────────────────────────────
type AutoCommitResultCallback = (data: {
  sessionId: string; trigger: string; status: string;
  message?: string; committed?: boolean; pushed?: boolean;
  files?: number; error?: string;
}) => void;
let autoCommitResultCallbacks: AutoCommitResultCallback[] = [];

function nextId() {
  return `r${++reqCounter}`;
}

export function isTauri(): boolean {
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

// ── 连接目标（C–C/S）：本地直连，或经中继 S 访问远程执行节点 ──────────
export type ConnectionTarget =
  | { mode: 'local' }
  | { mode: 'relay'; url: string; token: string; deviceId: string; deviceName?: string };

const CONN_TARGET_KEY = 'awu.connectionTarget';

function loadConnectionTarget(): ConnectionTarget {
  try {
    const raw = localStorage.getItem(CONN_TARGET_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && t.mode === 'relay' && t.url && t.deviceId) return t as ConnectionTarget;
    }
  } catch { /* ignore */ }
  return { mode: 'local' };
}

let connectionTarget: ConnectionTarget = loadConnectionTarget();

export function getConnectionTarget(): ConnectionTarget {
  return connectionTarget;
}

// ── 执行节点（session 级模式管理）─────────────────────────────────────
// 一个执行节点就是一个连接目标(ExecTarget == ConnectionTarget)。home 节点由
// connectionTarget 决定(本机 / 某中继);额外节点存在 execRoster 里。每个 session
// 归属一个节点,新建时选定、之后固定。
export type ExecTarget = ConnectionTarget;

/** 供 UI 展示的执行节点摘要。 */
export interface ExecutorInfo {
  key: string;          // 稳定键:'local' | `relay:<deviceId>`
  label: string;        // 人类可读名
  mode: 'local' | 'relay';
  isHome: boolean;      // 是否为当前 home(新建会话的默认落点)
  connected: boolean;   // 连接是否在线
}

/** 临时连一次中继、拉取在线执行节点列表，然后关闭。 */
export function listRelayDevices(
  url: string, token: string,
): Promise<{ id: string; name: string }[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    let sock: WebSocket;
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    try {
      sock = new WebSocket(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('bad relay url'));
      return;
    }
    const timer = setTimeout(
      () => finish(() => { try { sock.close(); } catch { /* */ } reject(new Error('连接中继超时')); }),
      8000,
    );
    sock.onopen = () => { try { sock.send(JSON.stringify({ t: 'list', token })); } catch { /* */ } };
    sock.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string);
        if (m.t === 'devices') {
          finish(() => { clearTimeout(timer); try { sock.close(); } catch { /* */ } resolve(m.devices || []); });
        } else if (m.t === 'error') {
          finish(() => { clearTimeout(timer); try { sock.close(); } catch { /* */ } reject(new Error(m.message || '中继拒绝')); });
        }
      } catch { /* ignore */ }
    };
    sock.onerror = () => finish(() => { clearTimeout(timer); reject(new Error('无法连接中继')); });
    sock.onclose = () => finish(() => { clearTimeout(timer); reject(new Error('中继连接已关闭')); });
  });
}

/**
 * 解析 WebSocket 连接地址，区分三种部署形态：
 *   - Tauri 桌面：连本机 sidecar，ws://127.0.0.1:<port>
 *   - Vite dev：前端 dev server 与后端分离，连 ws://127.0.0.1:44321
 *   - 生产 Web（反代后）：连 wss?://<当前host>/ws，由反代转发到后端
 */
async function getWsUrl(): Promise<string> {
  if (connectionTarget.mode === 'relay') {
    return connectionTarget.url;
  }
  if (isTauri()) {
    const port = await getWsPort();
    return `ws://127.0.0.1:${port}`;
  }
  if (import.meta.env.DEV) {
    return `ws://127.0.0.1:${WS_PORT_DEFAULT}`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/**
 * 解析 HTTP API（素材服务 / Skill 回调）的基地址。
 * Tauri / dev 直连本机端口；生产 Web 用相对路径，由反代转发。
 */
export function httpApiBase(httpPort: number): string {
  if (isTauri() || import.meta.env.DEV) {
    return `http://127.0.0.1:${httpPort}`;
  }
  return ''; // 相对当前 origin，反代把 /api/ 转发到后端
}

const INITIAL_RECONNECT_DELAY = 300; // 启动/断线后首次重试更快，后端一就绪就尽快连上（少白屏）
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL_MS = 25000; // 每 25 秒发送一次心跳 ping

// id → 该请求挂在哪条连接上(连接断开时只 reject 属于它的挂起请求,不误伤别的节点)
const pendingConn = new Map<string, string>();

function handleMessage(e: MessageEvent) {
  if (typeof e.data !== 'string') return;
  try {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      pendingConn.delete(msg.id);
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
    } else if (msg.event === 'assetChanged') {
      const data = msg.data ? JSON.parse(msg.data) : {};
      assetChangedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'clientsChanged') {
      const data: ConnectedClient[] = msg.data ? JSON.parse(msg.data) : [];
      clientsChangedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'loopUpdated') {
      const data = JSON.parse(msg.data);
      loopUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'loopProgress') {
      const data = JSON.parse(msg.data);
      loopProgressCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'loopAsideDelta') {
      const data = JSON.parse(msg.data);
      loopAsideDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'seqtaskUpdated') {
      const data = JSON.parse(msg.data);
      seqtaskUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'chatAsideDelta') {
      const data = JSON.parse(msg.data);
      chatAsideDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'chatAsideUpdated') {
      const data = JSON.parse(msg.data);
      chatAsideUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamText') {
      const data = JSON.parse(msg.data);
      sttStreamCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamEnd') {
      const data = JSON.parse(msg.data);
      sttStreamEndCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'gitCommitMsgDelta') {
      const data = JSON.parse(msg.data);
      gitCommitMsgDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'gitCommitMsgReady') {
      const data = JSON.parse(msg.data);
      gitCommitMsgReadyCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'autoCommitResult') {
      const data = JSON.parse(msg.data);
      autoCommitResultCallbacks.forEach((cb) => cb(data));
    }
  } catch (err) {
    console.error('[api] message parse error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  连接池（session 级执行节点）
//
//  原本「本 UI 连接到哪台执行节点」是系统级的单一连接——整窗口所有 session 都
//  跑在同一台节点上。现在改成 session 级：
//    · home 节点 = connectionTarget（本机 / 某中继节点）：新建会话的默认落点,
//      也是 App 启动时判定「后端是否就绪」的那条连接(行为保持不变)。
//    · 额外节点 = execRoster（用户额外加入的中继节点）,与 home 同时在线。
//  每条连接 = 一个 Conn;session→节点的归属记在 sessionExec 里,按 sessionId 把
//  RPC 路由到对应连接。会话物理上就存在于它所在的节点——「它从哪条连接列出来」
//  即它的归属,所以后端无需任何改动。roster 为空时只有一条 home 连接,完全等价
//  于改造前的单连接行为(向后兼容)。
// ═══════════════════════════════════════════════════════════════════

function execTargetKey(t: ExecTarget): string {
  return t.mode === 'local' ? 'local' : `relay:${t.deviceId}`;
}

function execLabelOf(t: ExecTarget): string {
  if (t.mode === 'local') return '🏠 本机';
  return (t.deviceName && t.deviceName.trim()) || t.deviceId || '远端节点';
}

/** 单条到某执行节点的连接：自管握手 / 心跳 / 指数退避重连。 */
class Conn {
  readonly key: string;
  target: ExecTarget;
  isHome: boolean;
  ws: WebSocket | null = null;
  ready: Promise<void>;
  private settleReady: () => void = () => {};
  private settled = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(key: string, target: ExecTarget, isHome: boolean) {
    this.key = key;
    this.target = target;
    this.isHome = isHome;
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = () => { if (!this.settled) { this.settled = true; resolve(); } };
    });
  }

  get label(): string { return execLabelOf(this.target); }
  get isOpen(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  private async resolveUrl(): Promise<string> {
    // 本机节点的地址解析沿用原逻辑(tauri sidecar / dev / 反代);中继节点用自带 url。
    return this.target.mode === 'relay' ? this.target.url : getWsUrl();
  }

  connect(): void {
    if (this.disposed) return;
    this.resolveUrl().then((url) => this.doConnect(url));
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    const old = this.ws;
    this.ws = null;
    if (old) { try { old.close(); } catch { /* */ } }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.resolveUrl().then((url) => this.doConnect(url));
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private doConnect(url: string): void {
    if (this.disposed) return;
    const socket = new WebSocket(url);
    let wasCurrent = false;
    const target = this.target;
    let relayHandshake = target.mode === 'relay';

    const finishConnect = () => {
      this.ws = socket;
      wasCurrent = true;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      console.log(`[api] Connected to ${url} (${this.key})`);
      if (this.isHome) {
        useMock = false;
        connectionStatusCallbacks.forEach((cb) => cb(true));
      }
      notifyExecStatus();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.isOpen) {
          const id = nextId();
          try { this.ws!.send(JSON.stringify({ id, method: 'ping', params: [] })); } catch { /* */ }
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.settleReady();
    };

    socket.onopen = () => {
      if (relayHandshake && target.mode === 'relay') {
        try {
          socket.send(JSON.stringify({ t: 'hello', token: target.token, deviceId: target.deviceId }));
        } catch { /* */ }
      } else {
        finishConnect();
      }
    };

    socket.onerror = () => this.settleReady();

    socket.onmessage = (e) => {
      if (relayHandshake) {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          if (m.t === 'ready') { relayHandshake = false; finishConnect(); }
          else if (m.t === 'error') {
            console.error('[api] relay rejected:', m.message);
            try { socket.close(); } catch { /* */ }
          }
        } catch { /* ignore non-handshake frames */ }
        return;
      }
      handleMessage(e);
    };

    socket.onclose = () => {
      if (wasCurrent && this.ws === socket) {
        this.ws = null;
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        // 只 reject 挂在本连接上的请求,别的节点的请求不受影响。
        pending.forEach((p, id) => {
          if (pendingConn.get(id) === this.key) {
            p.reject(new Error('WebSocket connection lost'));
            pending.delete(id);
            pendingConn.delete(id);
          }
        });
        if (this.isHome) connectionStatusCallbacks.forEach((cb) => cb(false));
      } else if (!wasCurrent && this.isHome) {
        // home 从未握手成功(例如首次就 502)：通知 UI 进入未连接,避免启动页卡死。
        connectionStatusCallbacks.forEach((cb) => cb(false));
      }
      notifyExecStatus();
      this.settleReady();
      this.scheduleReconnect();
    };
  }

  /** 发起一次 RPC。home 离线时回落 mock(保持旧行为);其它节点离线则丢弃返回 null。 */
  async request(method: string, params: any[]): Promise<any> {
    await this.ready;
    if (!this.isOpen) {
      if (this.isHome) return mockDispatch(method, params);
      console.warn(`[api] exec node ${this.key} offline, "${method}" dropped`);
      return null;
    }
    return await new Promise((resolve, reject) => {
      const id = nextId();
      pending.set(id, { resolve, reject });
      pendingConn.set(id, this.key);
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        pendingConn.delete(id);
        reject(e as Error);
      }
    });
  }

  /** fire-and-forget。 */
  async sendRaw(method: string, params: any[]): Promise<void> {
    await this.ready;
    if (!this.isOpen) {
      if (this.isHome) mockDispatch(method, params);
      return;
    }
    const id = nextId();
    try { this.ws!.send(JSON.stringify({ id, method, params })); } catch { /* */ }
  }
}

// ── 池 + 路由 ────────────────────────────────────────────────────────
const pool = new Map<string, Conn>();
let homeConn!: Conn;  // initPool() 在模块加载时立即赋值
const sessionExec = new Map<string, string>();   // sessionId → conn.key
let execStatusCallbacks: (() => void)[] = [];

function notifyExecStatus(): void { execStatusCallbacks.forEach((cb) => cb()); }

const SESSION_EXEC_KEY = 'awu.sessionExec';
function loadSessionExec(): void {
  try {
    const raw = localStorage.getItem(SESSION_EXEC_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') for (const k of Object.keys(o)) sessionExec.set(k, o[k]); }
  } catch { /* */ }
}
function persistSessionExec(): void {
  try { localStorage.setItem(SESSION_EXEC_KEY, JSON.stringify(Object.fromEntries(sessionExec))); } catch { /* */ }
}

const EXEC_ROSTER_KEY = 'awu.execRoster';
function loadExecRoster(): ExecTarget[] {
  try {
    const raw = localStorage.getItem(EXEC_ROSTER_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((t: any) => t && t.mode === 'relay' && t.url && t.deviceId);
    }
  } catch { /* */ }
  return [];
}
function saveExecRoster(list: ExecTarget[]): void {
  try { localStorage.setItem(EXEC_ROSTER_KEY, JSON.stringify(list)); } catch { /* */ }
}

function ensureConn(target: ExecTarget, isHome: boolean): Conn {
  const key = execTargetKey(target);
  let c = pool.get(key);
  if (!c) {
    c = new Conn(key, target, isHome);
    pool.set(key, c);
    c.connect();
  } else if (isHome) {
    c.isHome = true;
    c.target = target;
  }
  return c;
}

function initPool(): void {
  loadSessionExec();
  homeConn = ensureConn(connectionTarget, true);
  // 本机始终作为一个可选执行节点存在(默认是远端时也能在新建会话里选回本机)。
  if (homeConn.key !== 'local') ensureConn({ mode: 'local' }, false);
  for (const t of loadExecRoster()) {
    if (execTargetKey(t) !== homeConn.key) ensureConn(t, false);
  }
}

// 大多数会话级 RPC 第一个参数就是 sessionId;少数把 sessionId 藏在 JSON 载荷里。
const JSON_SESSION_METHODS: Record<string, string> = {
  sendMessage: 'sessionId',
  executeCommand: 'sessionId',
  migrateSession: 'sourceSessionId',
};
function extractSessionId(method: string, params: any[]): string | null {
  const field = JSON_SESSION_METHODS[method];
  if (field) {
    try { const o = JSON.parse(params[0]); if (o && typeof o[field] === 'string') return o[field]; } catch { /* */ }
    return null;
  }
  if (method === 'sttRefine') return typeof params[1] === 'string' && params[1] ? params[1] : null;
  // 约定:第一个参数若是已知会话 id,就路由到它的归属节点。session id 是 UUID,
  // 不会和别的字符串参数撞,因此无需逐一枚举几十个会话级方法。
  const p0 = params[0];
  if (typeof p0 === 'string' && sessionExec.has(p0)) return p0;
  return null;
}

function routeConn(method: string, params: any[]): Conn {
  const sid = extractSessionId(method, params);
  if (sid) {
    const key = sessionExec.get(sid);
    if (key) { const c = pool.get(key); if (c) return c; }
  }
  return homeConn;
}

/** 切换 home 执行节点（本地直连 / 中继远程），持久化并立即重连。 */
export async function setConnectionTarget(t: ConnectionTarget): Promise<void> {
  connectionTarget = t;
  try { localStorage.setItem(CONN_TARGET_KEY, JSON.stringify(t)); } catch { /* */ }
  const newKey = execTargetKey(t);
  if (homeConn && homeConn.key === newKey) {
    homeConn.isHome = true;
    homeConn.target = t;
    connectionStatusCallbacks.forEach((cb) => cb(homeConn.isOpen));
    return;
  }
  const oldHome = homeConn;
  let next = pool.get(newKey);
  if (!next) {
    next = new Conn(newKey, t, true);
    pool.set(newKey, next);
    next.connect();
  } else {
    next.isHome = true;
    next.target = t;
  }
  homeConn = next;
  if (oldHome && oldHome.key !== newKey) {
    oldHome.isHome = false;
    // 切换「默认节点」不再是破坏性动作:旧默认保留为普通可分配节点(继续在线、
    // 仍可在新建会话里选)。远端的话并入 roster,刷新后依旧在。本机始终保留。
    if (oldHome.target.mode === 'relay') {
      const list = loadExecRoster();
      if (!list.some((rt) => execTargetKey(rt) === oldHome.key)) { list.push(oldHome.target); saveExecRoster(list); }
    }
  }
  // 本机始终作为可选执行节点存在。
  if (newKey !== 'local' && !pool.has('local')) ensureConn({ mode: 'local' }, false);
  connectionStatusCallbacks.forEach((cb) => cb(homeConn.isOpen));
  notifyExecStatus();
}

// ── 执行节点列表（统一模型：本机 + 远端节点，某个为默认）──────────────────
/** 所有执行节点的展示摘要。本机(local)永远在列；按 本机→默认→其余 排序。 */
export function getExecutors(): ExecutorInfo[] {
  const out: ExecutorInfo[] = [];
  const seen = new Set<string>();
  const push = (c: Conn) => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    out.push({ key: c.key, label: c.label, mode: c.target.mode, isHome: c.isHome, connected: c.isOpen });
  };
  for (const c of pool.values()) push(c);
  // 本机始终可见(即便当前没连上,比如桌面纯客户端角色)。
  if (!seen.has('local')) {
    out.push({ key: 'local', label: execLabelOf({ mode: 'local' }), mode: 'local', isHome: false, connected: false });
  }
  out.sort((a, b) => {
    if (a.key === 'local') return -1;
    if (b.key === 'local') return 1;
    if (a.isHome !== b.isHome) return a.isHome ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/** 取某节点的完整连接目标(供「设为默认」用)。 */
export function getExecTarget(key: string): ExecTarget | null {
  const c = pool.get(key);
  if (c) return c.target;
  if (key === 'local') return { mode: 'local' };
  return loadExecRoster().find((t) => execTargetKey(t) === key) || null;
}

/** 添加一个远端中继执行节点（与本机/默认同时在线，可在新建会话时选）。 */
export function addExecRoster(t: ExecTarget): void {
  if (t.mode !== 'relay') return;
  const key = execTargetKey(t);
  const list = loadExecRoster();
  if (!list.some((x) => execTargetKey(x) === key)) { list.push(t); saveExecRoster(list); }
  ensureConn(t, false);
  notifyExecStatus();
}

/** 移除一个远端节点。本机与当前默认节点不可移除。 */
export function removeExecRoster(key: string): void {
  if (key === 'local') return;                       // 本机不可移除
  if (homeConn && key === homeConn.key) return;      // 当前默认节点不可移除
  saveExecRoster(loadExecRoster().filter((x) => execTargetKey(x) !== key));
  const c = pool.get(key);
  if (c) { pool.delete(key); c.dispose(); }
  notifyExecStatus();
}

/** 当前默认节点(新建会话的默认落点)的 key。 */
export function getHomeExecKey(): string { return homeConn ? homeConn.key : 'local'; }

/** 订阅执行节点在线状态变化（增删 / 上下线）。 */
export function onExecStatus(cb: () => void): () => void {
  execStatusCallbacks.push(cb);
  return () => { execStatusCallbacks = execStatusCallbacks.filter((x) => x !== cb); };
}

// ── 桌面端本机角色（仅 Tauri）：执行节点 / 纯客户端 ──────────────────────
// executor：本机运行执行节点 sidecar，可选发布到中继。
// client：  只作 UI，不在本机运行执行节点，经中继连接其它执行节点。
// 由 Rust 在启动时读取（决定是否 spawn sidecar），改动需重启应用生效。
export interface DesktopConfig {
  mode: 'executor' | 'client';
  relayUrl: string;
  relayToken: string;
  deviceName: string;
}

export async function getDesktopConfig(): Promise<DesktopConfig | null> {
  if (!isTauri()) return null;
  return tauriInvoke<DesktopConfig>('get_desktop_config');
}

export async function setDesktopConfig(config: DesktopConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke('set_desktop_config', { config });
}

// 模块加载即建立连接池（home + roster）。首次连接超时仍回调一次未连接状态,
// 让启动页不会无限卡在「正在连接后端...」。
initPool();
(() => {
  const timer = setTimeout(() => {
    if (!homeConn.isOpen) {
      console.warn(`[api] Initial connect timeout, will keep retrying…`);
      connectionStatusCallbacks.forEach((cb) => cb(false));
    }
  }, WS_CONNECT_TIMEOUT_MS);
  homeConn.ready.then(() => clearTimeout(timer));
})();

// ── RPC 调用（按 session 归属路由到对应执行节点）──────────────────────

async function call(method: string, ...params: any[]): Promise<any> {
  await homeConn.ready;
  try {
    return await routeConn(method, params).request(method, params);
  } catch (err) {
    console.warn(`[api] call "${method}" failed:`, err);
    return null;
  }
}

async function send(method: string, ...params: any[]): Promise<void> {
  await homeConn.ready;
  await routeConn(method, params).sendRaw(method, params);
}

/** 指定执行节点发起 RPC（用于按 workingDir 操作、无 sessionId 可路由的场景，如目录同步）。 */
function connByKey(execKey?: string): Conn {
  return (execKey && pool.get(execKey)) || homeConn;
}
async function callOn(execKey: string | undefined, method: string, ...params: any[]): Promise<any> {
  await homeConn.ready;
  try {
    return await connByKey(execKey).request(method, params);
  } catch (err) {
    console.warn(`[api] callOn "${method}" failed:`, err);
    return null;
  }
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
    // Tauri 桌面端:先读**本机**剪贴板。
    // 关键在客户端模式 —— 此时 WS bridge 指向远端执行节点,走 bridge 会
    // 读远端剪贴板,本地截图取不回来。本机读优先,失败再回落到 bridge
    // (覆盖 Wayland / 无 X server / arboard 取不到的边角情况)。
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke<null | {
          base64: string;
          mime_type: string;
          width: number;
          height: number;
          size: number;
        }>('read_local_clipboard_image');
        if (r && r.base64) {
          const { uuid } = await import('./utils/uuid');
          return { id: uuid(), ...r };
        }
        // 本机剪贴板里就是没图,直接返回 null —— 不要再去远端找,
        // 否则会拿到远端机器的剪贴板误判成新截图。
        return null;
      } catch (e) {
        console.warn('[clipboard] local read failed, falling back to bridge:', e);
        // 落到下面的 bridge 调用
      }
    }
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

  /**
   * 列出所有执行节点上的 session 并合并:每条 session 带上它的归属节点
   * (execKey / execLabel / execMode / execIsHome),并刷新 sessionId→节点 路由表。
   * roster 为空时即等价于「只列 home 的 session」(向后兼容)。
   */
  async listSessions(): Promise<any[]> {
    const conns = Array.from(pool.values());
    const results = await Promise.all(conns.map(async (c) => {
      try {
        const r = await c.request('listSessions', []);
        const list = JSON.parse(r) || [];
        return { c, list: Array.isArray(list) ? list : [] };
      } catch { return { c, list: [] as any[] }; }
    }));
    const merged: any[] = [];
    for (const { c, list } of results) {
      for (const s of list) {
        if (s && s.id) {
          sessionExec.set(s.id, c.key);
          merged.push({ ...s, execKey: c.key, execLabel: c.label, execMode: c.target.mode, execIsHome: c.isHome });
        }
      }
    }
    persistSessionExec();
    return merged;
  },

  /**
   * 加载 session。limit 可选:
   *   - undefined / 0: 返回全部消息(向后兼容,小 session OK,大 session 经中继会卡)
   *   - >0          : 只返回最末 limit 条,响应里附 `messagesTotal` + `hasMore`,
   *                   前端可以先渲染最近的,然后按需 loadSessionMessages 拉更老的
   */
  async loadSession(id: string, limit?: number): Promise<any | null> {
    const result = limit !== undefined && limit > 0
      ? await call('loadSession', id, limit)
      : await call('loadSession', id);
    try {
      const s = JSON.parse(result);
      // 注入归属执行节点信息(后端的 session 对象本身没有),供目录同步等按节点路由。
      if (s && s.id) {
        const storedKey = sessionExec.get(s.id);
        // ★ 修复：检查 storedKey 是否与当前 home 节点一致，避免跨环境切换时路由错误
        // 例如：之前在远端直连时记录了 'local'（远端的本地），现在通过中继访问，
        // 连接池中也有 'local'（本机的本地），但 session 实际属于远端节点。
        let key = homeConn.key;
        if (storedKey && pool.has(storedKey)) {
          const storedConn = pool.get(storedKey);
          // 如果 storedKey 是 'local' 但当前 home 不是本地连接，说明是跨环境残留记录
          if (storedKey === 'local' && homeConn.key !== 'local') {
            sessionExec.delete(s.id);
            persistSessionExec();
          } else if (storedConn) {
            key = storedKey;
          }
        } else if (storedKey) {
          sessionExec.delete(s.id);
          persistSessionExec();
        }
        const c = pool.get(key);
        if (c) { s.execKey = c.key; s.execLabel = c.label; s.execMode = c.target.mode; s.execIsHome = c.isHome; }
      }
      return s;
    } catch { return null; }
  },

  /** 翻页加载 session 的更老消息。等价于 messages[offset : offset+limit]。 */
  async loadSessionMessages(id: string, offset: number, limit: number): Promise<{
    messages: any[]; offset: number; limit: number; total: number;
  } | null> {
    const result = await call('loadSessionMessages', id, offset, limit);
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

  /** 列出后端配置;execKey 指定时取该执行节点的后端列表(新建会话选远端时用)。 */
  async getBackends(execKey?: string): Promise<any[]> {
    const conn = (execKey && pool.get(execKey)) || homeConn;
    const result = await conn.request('getBackends', []);
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

  /** 新建会话。execKey 指定它落在哪个执行节点(默认 home);建后归属即固定。 */
  async createSession(workingDir: string, backendId: string, sessionType: 'normal' | 'loop' = 'normal', execKey?: string): Promise<any> {
    const conn = (execKey && pool.get(execKey)) || homeConn;
    const result = await conn.request('createSession', [workingDir, backendId, sessionType]);
    try {
      const s = JSON.parse(result);
      if (s && s.id) {
        sessionExec.set(s.id, conn.key);
        persistSessionExec();
        s.execKey = conn.key;
        s.execLabel = conn.label;
        s.execMode = conn.target.mode;
        s.execIsHome = conn.isHome;
      }
      return s;
    } catch { return null; }
  },

  // ── 可视化 Loop 集成 ────────────────────────────────────────
  async loopGetState(sessionId: string): Promise<any | null> {
    const result = await call('loopGetState', sessionId);
    try { return JSON.parse(result); } catch { return null; }
  },

  async loopSubmitIdea(sessionId: string, prompt: string, images?: any[]): Promise<{ status: string; ideaId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopSubmitIdea', sessionId, prompt, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopRemoveIdea(sessionId: string, ideaId: string): Promise<{ status: string }> {
    const result = await call('loopRemoveIdea', sessionId, ideaId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopSealIdea(sessionId: string, goal: string = ''): Promise<{ status: string; stage?: string; message?: string }> {
    const result = await call('loopSealIdea', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopSetGoal(sessionId: string, goal: string): Promise<{ status: string }> {
    const result = await call('loopSetGoal', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopRefineGoal(sessionId: string, hint: string, images?: any[]): Promise<{ status: string; goal?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopRefineGoal', sessionId, hint, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 设置/更新 loop 策略与心智（建会话时 / 运行时均可）。 */
  async loopSetPolicy(sessionId: string, policy: any): Promise<{ status: string; policy?: any; message?: string }> {
    const result = await call('loopSetPolicy', sessionId, JSON.stringify(policy || {}));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 策略预设库：内置 + 用户自存，可直接选用。 */
  async loopPolicyPresetList(): Promise<{ status: string; presets?: any[] }> {
    const result = await call('loopPolicyPresetList');
    try { return JSON.parse(result); } catch { return { status: 'error', presets: [] }; }
  },
  async loopPolicyPresetSave(name: string, policy: any, presetId: string = ''): Promise<{ status: string; preset?: any; message?: string }> {
    const result = await call('loopPolicyPresetSave', name, JSON.stringify(policy || {}), presetId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async loopPolicyPresetDelete(presetId: string): Promise<{ status: string; message?: string }> {
    const result = await call('loopPolicyPresetDelete', presetId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /** 跨 session 模型能力台账：各 backend 历史表现，供分配参考。 */
  async modelLedgerList(): Promise<{ status: string; models?: any[] }> {
    const result = await call('modelLedgerList');
    try { return JSON.parse(result); } catch { return { status: 'error', models: [] }; }
  },

  /** 关闭意图守卫提示。 */
  async loopDismissIntent(sessionId: string): Promise<{ status: string }> {
    const result = await call('loopDismissIntent', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopRunIteration(sessionId: string): Promise<{ status: string; message?: string }> {
    const result = await call('loopRunIteration', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 停止并删除一次 loop（误触兜底，当作没发生过；消费过的 addon 退回 pending；
   *  restoreFiles=true 且有 git 快照时同时回滚工作目录文件到开跑前）。 */
  async loopDiscard(sessionId: string, seq: number = 0, restoreFiles: boolean = false): Promise<{ status: string; stopping?: boolean; seq?: number; revertedAddons?: number; message?: string }> {
    const result = await call('loopDiscard', sessionId, seq, restoreFiles);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopSetAuto(sessionId: string, on: boolean): Promise<{ status: string; auto?: boolean }> {
    const result = await call('loopSetAuto', sessionId, on);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopAdvanceToOut(sessionId: string): Promise<{ status: string; stage?: string; message?: string }> {
    const result = await call('loopAdvanceToOut', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** loopout 之后开启新一轮（同一工作目录/上下文，轮次 +1）。 */
  async loopContinue(sessionId: string, goal: string = ''): Promise<{ status: string; stage?: string; round?: number; message?: string }> {
    const result = await call('loopContinue', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** By the way 旁路提问：基于当前 loop 状态对话，不污染 loop 主线上下文。 */
  async loopAsk(sessionId: string, question: string, images?: any[]): Promise<{ status: string; turnId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopAsk', sessionId, question, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 执行中补充要求（addon，可带图片）：不影响当前 loop，下一次 loop 的 analysis/prepare 纳入。 */
  async loopAddAddon(sessionId: string, text: string, images?: any[]): Promise<{ status: string; addonId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopAddAddon', sessionId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopRemoveAddon(sessionId: string, addonId: string): Promise<{ status: string }> {
    const result = await call('loopRemoveAddon', sessionId, addonId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /** 编辑一条待纳入的补充（文字 + 图片）。 */
  async loopEditAddon(sessionId: string, addonId: string, text: string, images?: any[]): Promise<{ status: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopEditAddon', sessionId, addonId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  onLoopAsideDelta(cb: LoopAsideDeltaCallback): () => void {
    loopAsideDeltaCallbacks.push(cb);
    return () => { loopAsideDeltaCallbacks = loopAsideDeltaCallbacks.filter((c) => c !== cb); };
  },

  onLoopUpdated(cb: LoopUpdatedCallback): () => void {
    loopUpdatedCallbacks.push(cb);
    return () => { loopUpdatedCallbacks = loopUpdatedCallbacks.filter((c) => c !== cb); };
  },

  onLoopProgress(cb: LoopProgressCallback): () => void {
    loopProgressCallbacks.push(cb);
    return () => { loopProgressCallbacks = loopProgressCallbacks.filter((c) => c !== cb); };
  },

  // ── 序列任务（普通 session）────────────────────────────────
  async seqtaskGet(sessionId: string): Promise<{ status: string; seqTasks: any[]; seqAuto: boolean }> {
    const result = await call('seqtaskGet', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', seqTasks: [], seqAuto: false }; }
  },
  async seqtaskAdd(sessionId: string, text: string, images?: any[]): Promise<{ status: string; seqTasks?: any[]; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('seqtaskAdd', sessionId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async seqtaskEdit(sessionId: string, taskId: string, text: string, images?: any[]): Promise<{ status: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('seqtaskEdit', sessionId, taskId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async seqtaskRemove(sessionId: string, taskId: string): Promise<{ status: string }> {
    const result = await call('seqtaskRemove', sessionId, taskId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async seqtaskReorder(sessionId: string, ids: string[]): Promise<{ status: string }> {
    const result = await call('seqtaskReorder', sessionId, JSON.stringify(ids));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async seqtaskSetAuto(sessionId: string, on: boolean): Promise<{ status: string }> {
    const result = await call('seqtaskSetAuto', sessionId, on);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async seqtaskTakeNext(sessionId: string): Promise<{ status: string; task: any | null }> {
    const result = await call('seqtaskTakeNext', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', task: null }; }
  },
  async seqtaskClear(sessionId: string): Promise<{ status: string }> {
    const result = await call('seqtaskClear', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  onSeqtaskUpdated(cb: SeqtaskUpdatedCallback): () => void {
    seqtaskUpdatedCallbacks.push(cb);
    return () => { seqtaskUpdatedCallbacks = seqtaskUpdatedCallbacks.filter((c) => c !== cb); };
  },

  // ── By the way 旁路问答（普通 session）─────────────────────
  async chatAsk(sessionId: string, question: string, images?: any[]): Promise<{ status: string; turnId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('chatAsk', sessionId, question, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async chatAsideList(sessionId: string): Promise<{ status: string; asides: any[]; asideBackendId?: string }> {
    const result = await call('chatAsideList', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', asides: [] }; }
  },
  async chatAsideSetBackend(sessionId: string, backendId: string): Promise<{ status: string; asideBackendId?: string }> {
    const result = await call('chatAsideSetBackend', sessionId, backendId || '');
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  onChatAsideDelta(cb: ChatAsideDeltaCallback): () => void {
    chatAsideDeltaCallbacks.push(cb);
    return () => { chatAsideDeltaCallbacks = chatAsideDeltaCallbacks.filter((c) => c !== cb); };
  },
  onChatAsideUpdated(cb: ChatAsideUpdatedCallback): () => void {
    chatAsideUpdatedCallbacks.push(cb);
    return () => { chatAsideUpdatedCallbacks = chatAsideUpdatedCallbacks.filter((c) => c !== cb); };
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
    return !useMock && !!homeConn && homeConn.isOpen;
  },

  onConnectionStatus(callback: ConnectionStatusCallback): () => void {
    connectionStatusCallbacks.push(callback);
    return () => { connectionStatusCallbacks = connectionStatusCallbacks.filter((cb) => cb !== callback); };
  },

  async listDirectory(path: string, workingDir?: string, execKey?: string): Promise<{ name: string; path: string; isDir: boolean }[]> {
    // execKey 指定时发到该会话的执行节点(远端目录懒加载逐层浏览);缺省回落 home。
    const result = execKey
      ? await callOn(execKey, 'listDirectory', path, workingDir || '')
      : await call('listDirectory', path, workingDir || '');
    try {
      const data = JSON.parse(result);
      if (Array.isArray(data)) return data;
      return [];
    } catch { return []; }
  },

  /** 服务器侧文件系统浏览起点（home / cwd / 盘符或根）。供 C/S 模式目录选择器使用。
   *  execKey 指定时查询该执行节点；缺省回落 home。
   */
  async getDirRoots(execKey?: string): Promise<{ home: string; cwd: string; roots: string[]; sep: string }> {
    const result = execKey
      ? await callOn(execKey, 'getDirRoots')
      : await call('getDirRoots');
    try {
      return JSON.parse(result);
    } catch {
      return { home: '', cwd: '', roots: ['/'], sep: '/' };
    }
  },

  async getAppConfig(): Promise<any> {
    const result = await call('getAppConfig');
    try { return JSON.parse(result); } catch { return {}; }
  },

  async setAppConfig(config: any): Promise<any> {
    const result = await call('setAppConfig', JSON.stringify(config));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存配置失败' }; }
  },

  // ── Git 集成：所有操作通过 execKey 路由到执行节点 ─────────────

  async gitDetect(workingDir: string, execKey?: string): Promise<GitDetectResult> {
    const result = await callOn(execKey, 'gitDetect', workingDir);
    try { return JSON.parse(result); } catch { return { isRepo: false, branch: '', ahead: 0, behind: 0, remote: '', hasUncommitted: false }; }
  },

  async gitStatus(workingDir: string, execKey?: string): Promise<GitStatusResult> {
    const result = await callOn(execKey, 'gitStatus', workingDir);
    try { return JSON.parse(result); } catch { return { files: [], branch: '', upstream: '', ahead: 0, behind: 0, totalChanges: 0, stagedCount: 0 }; }
  },

  async gitDiff(workingDir: string, path: string = '', staged: boolean = false, execKey?: string): Promise<GitDiffResult> {
    const result = await callOn(execKey, 'gitDiff', workingDir, path, staged);
    try { return JSON.parse(result); } catch { return { diff: '', stat: '', binary: false }; }
  },

  async gitStage(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStage', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitUnstage(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitUnstage', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitDiscard(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string; discarded?: string[]; failed?: string[] }> {
    const result = await callOn(execKey, 'gitDiscard', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitIgnore(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string; ignored?: string[]; failed?: string[] }> {
    const result = await callOn(execKey, 'gitIgnore', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitCommit(workingDir: string, message: string, all: boolean = false, execKey?: string, onlyPaths?: string[]): Promise<GitCommitResult> {
    const result = await callOn(execKey, 'gitCommit', workingDir, message, all, onlyPaths ? JSON.stringify(onlyPaths) : '');
    try { return JSON.parse(result); } catch { return { status: 'error', commitHash: '', filesChanged: 0, insertions: 0, deletions: 0 }; }
  },

  async gitLog(workingDir: string, maxCount: number = 50, offset: number = 0, execKey?: string, since?: string, until?: string): Promise<GitLogResult> {
    const result = await callOn(execKey, 'gitLog', workingDir, maxCount, offset, since || '', until || '');
    try { return JSON.parse(result); } catch { return { commits: [], hasMore: false }; }
  },

  async gitShow(workingDir: string, commitHash: string, execKey?: string): Promise<{ message: string; stat: string; files: { path: string; status: string; added: number; deleted: number }[] }> {
    const result = await callOn(execKey, 'gitShow', workingDir, commitHash);
    try { return JSON.parse(result); } catch { return { message: '', stat: '', files: [] }; }
  },

  async gitCommitFileDiff(workingDir: string, commitHash: string, filePath: string, execKey?: string): Promise<{ diff: string; binary: boolean; error?: string }> {
    const result = await callOn(execKey, 'gitCommitFileDiff', workingDir, commitHash, filePath);
    try { return JSON.parse(result); } catch { return { diff: '', binary: false, error: '解析失败' }; }
  },

  async gitBranches(workingDir: string, execKey?: string): Promise<GitBranchesResult> {
    const result = await callOn(execKey, 'gitBranches', workingDir);
    try { return JSON.parse(result); } catch { return { current: '', local: [], remote: [] }; }
  },

  async gitBranchCreate(workingDir: string, name: string, checkout: boolean = true, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchCreate', workingDir, name, checkout);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitBranchSwitch(workingDir: string, name: string, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchSwitch', workingDir, name);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitBranchDelete(workingDir: string, name: string, force: boolean = false, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchDelete', workingDir, name, force);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitPush(workingDir: string, remote: string = 'origin', branch: string = '', force: boolean = false, execKey?: string): Promise<GitPushPullResult> {
    const result = await callOn(execKey, 'gitPush', workingDir, remote, branch, force);
    try { return JSON.parse(result); } catch { return { status: 'error', output: '' }; }
  },

  async gitPull(workingDir: string, remote: string = 'origin', branch: string = '', rebase: boolean = false, execKey?: string): Promise<GitPushPullResult> {
    const result = await callOn(execKey, 'gitPull', workingDir, remote, branch, rebase);
    try { return JSON.parse(result); } catch { return { status: 'error', output: '' }; }
  },

  async gitStashList(workingDir: string, execKey?: string): Promise<GitStashListResult> {
    const result = await callOn(execKey, 'gitStashList', workingDir);
    try { return JSON.parse(result); } catch { return { stashes: [] }; }
  },

  async gitStashPush(workingDir: string, message: string = '', execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashPush', workingDir, message);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitStashPop(workingDir: string, index: number = 0, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashPop', workingDir, index);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitStashDrop(workingDir: string, index: number = 0, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashDrop', workingDir, index);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitGenerateCommitMessage(workingDir: string, stagedOnly: boolean = true, execKey?: string, backendId?: string, onlyPaths?: string[]): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'gitGenerateCommitMessage', workingDir, stagedOnly, backendId || '', onlyPaths ? JSON.stringify(onlyPaths) : '');
    if (!result) return { status: 'error', message: '与后端连接断开，请确认后端正在运行' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  // ── 自动 AI commit ────────────────────────────────────────────
  async setAutoCommit(sessionId: string, enabled: boolean, push: boolean = false, backendId: string = ''): Promise<{
    status: string; autoCommit?: boolean; autoCommitPush?: boolean; autoCommitBackendId?: string | null;
  }> {
    const result = await call('setAutoCommit', sessionId, enabled, push, backendId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async getAutoCommit(sessionId: string): Promise<{
    autoCommit: boolean; autoCommitPush: boolean; autoCommitBackendId: string | null;
  }> {
    const result = await call('getAutoCommit', sessionId);
    try { return JSON.parse(result); } catch { return { autoCommit: false, autoCommitPush: false, autoCommitBackendId: null }; }
  },

  onAutoCommitResult(cb: AutoCommitResultCallback): () => void {
    autoCommitResultCallbacks.push(cb);
    return () => { autoCommitResultCallbacks = autoCommitResultCallbacks.filter((c) => c !== cb); };
  },

  // ─ Git 事件订阅 ─────────────────────────────────────────────
  onGitCommitMsgDelta(cb: (data: { workingDir: string; text: string }) => void): () => void {
    gitCommitMsgDeltaCallbacks.push(cb);
    return () => { gitCommitMsgDeltaCallbacks = gitCommitMsgDeltaCallbacks.filter((c) => c !== cb); };
  },

  onGitCommitMsgReady(cb: (data: { workingDir: string; message: string; error?: string }) => void): () => void {
    gitCommitMsgReadyCallbacks.push(cb);
    return () => { gitCommitMsgReadyCallbacks = gitCommitMsgReadyCallbacks.filter((c) => c !== cb); };
  },

  // ── 目录同步：远端工作目录 ↔ 本机副本目录 ──────────────────
  // 这些操作的是某个执行节点上的工作目录,而参数是路径(不是 sessionId,无法被
  // 自动路由)。所以显式带上该会话的 execKey,把请求发到它归属的节点;缺省回落
  // home(向后兼容)。
  /** 服务器工作目录清单：relpath → {hash, size}，供客户端做三向增量比对。 */
  async syncManifest(workingDir: string, execKey?: string): Promise<{
    status: string; message?: string; root?: string;
    files?: Record<string, { hash: string; size: number }>;
  }> {
    const result = await callOn(execKey, 'syncManifest', workingDir);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncManifest 无响应' }; }
  },

  async syncReadFile(workingDir: string, rel: string, execKey?: string): Promise<{
    status: string; message?: string; hash?: string; data?: string; tooLarge?: boolean;
  }> {
    const result = await callOn(execKey, 'syncReadFile', workingDir, rel);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncReadFile 无响应' }; }
  },

  async syncWriteFile(workingDir: string, rel: string, dataBase64: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncWriteFile', workingDir, rel, dataBase64);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncWriteFile 无响应' }; }
  },

  async syncDeleteFile(workingDir: string, rel: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncDeleteFile', workingDir, rel);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncDeleteFile 无响应' }; }
  },

  /** 读取同步忽略清单（来自 app-config.syncIgnore）。 */
  async getSyncConfig(): Promise<{ ignore: string[]; defaultIgnore: string[] }> {
    const result = await call('getSyncConfig');
    try { return JSON.parse(result); } catch { return { ignore: [], defaultIgnore: [] }; }
  },

  async setSyncConfig(ignore: string[]): Promise<{ status: string; message?: string }> {
    const result = await call('setSyncConfig', JSON.stringify({ ignore }));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存忽略清单失败' }; }
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
    // STT 流式音频走 home 节点(sttStreamStart 无 sessionId,固定在 home)。
    if (homeConn && homeConn.isOpen) {
      homeConn.ws!.send(pcmBuffer);
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

  // ── 素材中转池（Asset Pool）──────────────────────────────────

  async assetList(limit = 50, offset = 0, tag = ''): Promise<{ items: any[]; stats: any; httpPort: number }> {
    const r = await call('assetList', limit, offset, tag);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return { items: d?.items || [], stats: d?.stats || {}, httpPort: d?.httpPort || 0 };
    } catch { return { items: [], stats: {}, httpPort: 0 }; }
  },

  async assetPush(payload: { base64: string; mime: string; source?: string; tags?: string[]; desc?: string; ttl?: number }): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetPush', JSON.stringify(payload));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetPin(id: string, pinned: boolean): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetPin', id, pinned);
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetUpdateMeta(payload: { id: string; desc?: string; tags?: string[] }): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetUpdateMeta', JSON.stringify(payload));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetDelete(id: string): Promise<{ ok: boolean }> {
    const r = await call('assetDelete', id);
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false }; }
  },

  onAssetChanged(cb: AssetChangedCallback): () => void {
    assetChangedCallbacks.push(cb);
    return () => { assetChangedCallbacks = assetChangedCallbacks.filter((c) => c !== cb); };
  },

  /** 列出当前连接到本执行节点的所有 UI 客户端（本地直连 + 经中继）。 */
  async listConnectedClients(): Promise<ConnectedClient[]> {
    const r = await call('listConnectedClients');
    try {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  },

  /** 订阅「在线 UI 列表」变化事件,接入/断开都会触发。 */
  onClientsChanged(cb: ClientsChangedCallback): () => void {
    clientsChangedCallbacks.push(cb);
    return () => { clientsChangedCallbacks = clientsChangedCallbacks.filter((c) => c !== cb); };
  },

  /** 打开外部 cmd 窗口实时刷日志（仅 Tauri 桌面端可用） */
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

  /** 查询 Claude CLI 登录状态（OAuth 凭证 / API key） */
  async getAuthStatus(): Promise<{
    loggedIn: boolean;
    method: 'oauth' | 'apiKey' | 'none';
    expiresAt: number | null;
    expired: boolean;
    credentialsPath: string;
  }> {
    const r = await call('getAuthStatus');
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return {
        loggedIn: !!d?.loggedIn,
        method: d?.method || 'none',
        expiresAt: d?.expiresAt ?? null,
        expired: !!d?.expired,
        credentialsPath: d?.credentialsPath || '',
      };
    } catch {
      return { loggedIn: false, method: 'none', expiresAt: null, expired: false, credentialsPath: '' };
    }
  },

  /** 按文件名取 skill 生成图片（走数据通道，本地/中继通用） */
  async getSkillImage(filename: string): Promise<{ ok: boolean; mime?: string; base64?: string; error?: string }> {
    const r = await call('getSkillImage', filename);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return d && typeof d === 'object' ? d : { ok: false, error: 'bad response' };
    } catch {
      return { ok: false, error: 'parse error' };
    }
  },

  /** 按 id 取素材池条目（默认缩略图），走数据通道 */
  async getAsset(id: string, thumb = true): Promise<{ ok: boolean; mime?: string; base64?: string; error?: string }> {
    const r = await call('getAsset', id, thumb);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return d && typeof d === 'object' ? d : { ok: false, error: 'bad response' };
    } catch {
      return { ok: false, error: 'parse error' };
    }
  },

  /** 读取后端日志末尾若干行（适用于 CS / WebSocket 架构的应用内日志查看器） */
  async getBackendLogs(maxLines = 500): Promise<{ ok: boolean; lines: string[]; path?: string; error?: string }> {
    const r = await call('getBackendLogs', maxLines);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return { ok: !!d?.ok, lines: d?.lines || [], path: d?.path, error: d?.error };
    } catch {
      return { ok: false, lines: [], error: 'parse error' };
    }
  },
};

// ── Skill 图片：按文件名取一次、缓存为 data URL，供 markdown 渲染按需加载 ──
const skillImageCache = new Map<string, string>();
const skillImageInflight = new Map<string, Promise<string>>();

export function loadSkillImageDataUrl(filename: string): Promise<string> {
  const cached = skillImageCache.get(filename);
  if (cached) return Promise.resolve(cached);
  let p = skillImageInflight.get(filename);
  if (!p) {
    p = (async () => {
      const r = await api.getSkillImage(filename);
      if (!r.ok || !r.base64) throw new Error(r.error || 'load failed');
      const url = `data:${r.mime || 'image/png'};base64,${r.base64}`;
      skillImageCache.set(filename, url);
      return url;
    })();
    skillImageInflight.set(filename, p);
    p.catch(() => { /* keep errors from rejecting unhandled */ })
      .finally(() => skillImageInflight.delete(filename));
  }
  return p;
}

// ── 素材池图片：同样按需取、缓存为 data URL（id+thumb 为键，内容不可变）──
const assetImageCache = new Map<string, string>();
const assetImageInflight = new Map<string, Promise<string>>();

export function loadAssetDataUrl(id: string, thumb = true): Promise<string> {
  const key = (thumb ? 't:' : 'f:') + id;
  const cached = assetImageCache.get(key);
  if (cached) return Promise.resolve(cached);
  let p = assetImageInflight.get(key);
  if (!p) {
    p = (async () => {
      const r = await api.getAsset(id, thumb);
      if (!r.ok || !r.base64) throw new Error(r.error || 'load failed');
      const url = `data:${r.mime || 'image/jpeg'};base64,${r.base64}`;
      assetImageCache.set(key, url);
      return url;
    })();
    assetImageInflight.set(key, p);
    p.catch(() => { /* keep errors from rejecting unhandled */ })
      .finally(() => assetImageInflight.delete(key));
  }
  return p;
}

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
    case 'getSkillImage': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'getAsset': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'getAuthStatus':
      return JSON.stringify({ loggedIn: false, method: 'none', expiresAt: null, expired: false, credentialsPath: '' });
    case 'getBackendLogs':
      return JSON.stringify({ ok: true, lines: ['[mock] backend not connected — run: python -m src.ws_main'] });
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
        sessionType: params[2] || 'normal',
      });
    case 'loopGetState': return 'null';
    case 'loopSubmitIdea': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopRemoveIdea': return JSON.stringify({ status: 'ok' });
    case 'loopSealIdea': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopSetGoal': return JSON.stringify({ status: 'ok' });
    case 'loopRefineGoal': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopSetPolicy': return JSON.stringify({ status: 'ok' });
    case 'loopPolicyPresetList': return JSON.stringify({ status: 'ok', presets: [] });
    case 'loopPolicyPresetSave': return JSON.stringify({ status: 'ok' });
    case 'loopPolicyPresetDelete': return JSON.stringify({ status: 'ok' });
    case 'modelLedgerList': return JSON.stringify({ status: 'ok', models: [] });
    case 'loopDismissIntent': return JSON.stringify({ status: 'ok' });
    case 'loopRunIteration': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopDiscard': return JSON.stringify({ status: 'ok' });
    case 'loopSetAuto': return JSON.stringify({ status: 'ok', auto: !!params[1] });
    case 'loopAdvanceToOut': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopContinue': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopAsk': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopAddAddon': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopRemoveAddon': return JSON.stringify({ status: 'ok' });
    case 'loopEditAddon': return JSON.stringify({ status: 'ok' });
    case 'seqtaskGet': return JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false });
    case 'seqtaskAdd': case 'seqtaskEdit': case 'seqtaskReorder':
    case 'seqtaskClear': return JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false });
    case 'seqtaskRemove': case 'seqtaskSetAuto': return JSON.stringify({ status: 'ok' });
    case 'seqtaskTakeNext': return JSON.stringify({ status: 'ok', task: null });
    case 'chatAsk': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'chatAsideList': return JSON.stringify({ status: 'ok', asides: [], asideBackendId: '' });
    case 'chatAsideSetBackend': return JSON.stringify({ status: 'ok', asideBackendId: params[1] || '' });
    case 'listSessions': return '[]';
    case 'listConnectedClients': return '[]';
    case 'loadSession': return 'null';
    case 'loadSessionMessages': return 'null';
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
    case 'getDirRoots': return JSON.stringify({ home: '', cwd: '', roots: ['/'], sep: '/' });
    case 'assetList': return JSON.stringify({ items: [], stats: { count: 0, pinned: 0, bytes: 0 }, httpPort: 0 });
    case 'assetPush': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetPin': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetUpdateMeta': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetDelete': return JSON.stringify({ ok: false });
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

/**
 * api.ts: Bridge between React and Python backend via QWebChannel.
 */

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;

let bridge: any = null;
let bridgeReady: Promise<void>;
let streamCallbacks: StreamDeltaCallback[] = [];
let sessionUpdateCallbacks: SessionUpdateCallback[] = [];

function callSlot(method: string, ...args: any[]): Promise<any> {
  return new Promise((resolve) => {
    bridge[method](...args, (result: any) => {
      resolve(result);
    });
  });
}

// Initialize QWebChannel connection
bridgeReady = new Promise<void>((resolve) => {
  if ((window as any).qt?.webChannelTransport) {
    new (window as any).QWebChannel(
      (window as any).qt.webChannelTransport,
      (channel: any) => {
        bridge = channel.objects.bridge;

        // Connect streaming signal
        bridge.streamDelta.connect((deltaJson: string) => {
          try {
            const delta = JSON.parse(deltaJson);
            streamCallbacks.forEach((cb) => cb(delta));
          } catch (e) {
            console.error("Failed to parse stream delta:", e);
          }
        });

        // ★ Connect session updated signal
        bridge.sessionUpdated.connect((json: string) => {
          try {
            const data = JSON.parse(json);
            sessionUpdateCallbacks.forEach((cb) => cb(data));
          } catch (e) {
            console.error("Failed to parse session update:", e);
          }
        });

        resolve();
      }
    );
  } else {
    console.warn("QWebChannel not available, using mock bridge");
    bridge = createMockBridge();
    resolve();
  }
});

// Mock backends storage for development
const mockBackends: any[] = [
  {
    id: 'claude-agent-sdk-default',
    type: 'claude-agent-sdk',
    label: 'Claude Code (Agent SDK)',
    model: 'sonnet',
    env: {},
  },
];

// Mock app config storage for development
let mockAppConfig: any = {
  fontSize: 14,
  renderMarkdown: true,
  exportFormat: 'markdown',
  theme: 'dark',
};

function createMockBridge() {
  return {
    readClipboardImage: (cb: any) => cb("null"),
    getAppConfig: (cb: any) => cb(JSON.stringify(mockAppConfig)),
    setAppConfig: (json: string, cb: any) => {
      mockAppConfig = JSON.parse(json);
      cb(JSON.stringify({ status: 'ok' }));
    },
    sendMessage: (json: string) => {
      const payload = JSON.parse(json);
      const msgId = payload.messageId || "mock-" + Date.now();
      setTimeout(() => {
        streamCallbacks.forEach((cb) =>
          cb({
            sessionId: payload.sessionId,
            messageId: msgId,
            type: "text_delta",
            text: "Mock response — QWebChannel not connected. Run with PySide6.\n\nSlash commands work! Try `/help`.",
          })
        );
        setTimeout(() => {
          streamCallbacks.forEach((cb) =>
            cb({
              sessionId: payload.sessionId,
              messageId: msgId,
              type: "done",
              usage: { inputTokens: 100, outputTokens: 50 },
            })
          );
        }, 100);
      }, 300);
    },
    abortMessage: () => {},
    // ★ 新增 mock
    executeCommand: (json: string, cb: any) => {
      const payload = JSON.parse(json);
      if (payload.command === 'compact') {
        cb(JSON.stringify({ status: 'ok', removed: 5, remaining: 6 }));
      } else if (payload.command === 'clear') {
        cb(JSON.stringify({ status: 'ok' }));
      } else {
        cb(JSON.stringify({ status: 'ok' }));
      }
    },
    createSession: (backendId: string, cb: any) =>
      cb(
        JSON.stringify({
          id: "mock-session-" + Date.now(),
          title: "Mock session",
          createdAt: Date.now() / 1000,
          updatedAt: Date.now() / 1000,
          messages: [],
          backendId,
          autoContinue: true,
        })
      ),
    listSessions: (cb: any) => cb("[]"),
    loadSession: (_id: string, cb: any) => cb("null"),
    deleteSession: (_id: string, cb: any) => cb(true),
    getBackends: (cb: any) =>
      cb(
        JSON.stringify([
          {
            id: "claude-agent-sdk-default",
            type: "claude-agent-sdk",
            label: "Claude Code (Agent SDK)",
            model: "sonnet",
          },
        ])
      ),
    saveBackend: (json: string) => {
      const config = JSON.parse(json);
      const idx = mockBackends.findIndex(b => b.id === config.id);
      if (idx >= 0) {
        mockBackends[idx] = config;
      } else {
        mockBackends.push(config);
      }
    },
    deleteBackend: (id: string) => {
      const idx = mockBackends.findIndex(b => b.id === id);
      if (idx >= 0) {
        mockBackends.splice(idx, 1);
      }
    },
  };
}

// ═══════════════════════════════════════
//  Exported API
// ═══════════════════════════════════════
export const api = {
  async readClipboardImage(): Promise<any | null> {
    await bridgeReady;
    const result = await callSlot("readClipboardImage");
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  async sendMessage(payload: any): Promise<void> {
    await bridgeReady;
    bridge.sendMessage(JSON.stringify(payload));
  },

  async abortMessage(backendId: string): Promise<void> {
    await bridgeReady;
    bridge.abortMessage(backendId);
  },

  onStreamDelta(callback: StreamDeltaCallback): () => void {
    streamCallbacks.push(callback);
    return () => {
      streamCallbacks = streamCallbacks.filter((cb) => cb !== callback);
    };
  },

  // ★ 新增：监听 session 更新信号
  onSessionUpdated(callback: SessionUpdateCallback): () => void {
    sessionUpdateCallbacks.push(callback);
    return () => {
      sessionUpdateCallbacks = sessionUpdateCallbacks.filter((cb) => cb !== callback);
    };
  },

  // ★ 新增：执行后端命令
  async executeCommand(payload: {
    command: string;
    sessionId: string;
    backendId: string;
    args?: any;
  }): Promise<any> {
    await bridgeReady;
    const result = await callSlot("executeCommand", JSON.stringify(payload));
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  async listSessions(): Promise<any[]> {
    await bridgeReady;
    const result = await callSlot("listSessions");
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  },

  async loadSession(id: string): Promise<any | null> {
    await bridgeReady;
    const result = await callSlot("loadSession", id);
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  async deleteSession(id: string): Promise<boolean> {
    await bridgeReady;
    return await callSlot("deleteSession", id);
  },

  async getBackends(): Promise<any[]> {
    await bridgeReady;
    const result = await callSlot("getBackends");
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  },

  async saveBackend(config: any): Promise<void> {
    await bridgeReady;
    bridge.saveBackend(JSON.stringify(config));
  },

  async deleteBackend(id: string): Promise<void> {
    await bridgeReady;
    bridge.deleteBackend(id);
  },

  // ═══════════════════════════════════════
  //  ★ 目录选择
  // ═══════════════════════════════════════
  async selectDirectory(initialPath?: string): Promise<string | null> {
    await bridgeReady;
    const result = await callSlot("selectDirectory", initialPath || "");
    try {
      const parsed = JSON.parse(result);
      return parsed.path;
    } catch {
      return null;
    }
  },

  // ═══════════════════════════════════════
  //  ★ Phase 3: 跨 Session 支持
  // ═══════════════════════════════════════
  async migrateSession(sourceSessionId: string, targetBackendId: string): Promise<any> {
    await bridgeReady;
    const result = await callSlot("migrateSession", JSON.stringify({
      sourceSessionId,
      targetBackendId,
    }));
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  // ★ 新增：创建 Session 时必须指定工作目录
  async createSession(workingDir: string, backendId: string): Promise<any> {
    await bridgeReady;
    const result = await callSlot("createSession", workingDir, backendId);
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  },

  // ═══════════════════════════════════════
  //  ★ 数据导入导出
  // ═══════════════════════════════════════
  async selectExportPath(): Promise<string | null> {
    await bridgeReady;
    const result = await callSlot("selectExportPath");
    try {
      const parsed = JSON.parse(result);
      return parsed.path;
    } catch {
      return null;
    }
  },

  async selectImportPath(): Promise<string | null> {
    await bridgeReady;
    const result = await callSlot("selectImportPath");
    try {
      const parsed = JSON.parse(result);
      return parsed.path;
    } catch {
      return null;
    }
  },

  async exportData(targetPath: string): Promise<any> {
    await bridgeReady;
    const result = await callSlot("exportData", targetPath);
    try {
      return JSON.parse(result);
    } catch {
      return { status: "error", message: "导出失败" };
    }
  },

  async importData(sourcePath: string): Promise<any> {
    await bridgeReady;
    const result = await callSlot("importData", sourcePath);
    try {
      return JSON.parse(result);
    } catch {
      return { status: "error", message: "导入失败" };
    }
  },

  // ═══════════════════════════════════════
  //  ★ 应用配置（主题等）
  // ═══════════════════════════════════════
  async getAppConfig(): Promise<any> {
    await bridgeReady;
    const result = await callSlot("getAppConfig");
    try {
      return JSON.parse(result);
    } catch {
      return {};
    }
  },

  async setAppConfig(config: any): Promise<any> {
    await bridgeReady;
    const result = await callSlot("setAppConfig", JSON.stringify(config));
    try {
      return JSON.parse(result);
    } catch {
      return { status: "error", message: "保存配置失败" };
    }
  },
};
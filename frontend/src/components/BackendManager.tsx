import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../api';

// 注入删除按钮 hover 样式（只执行一次）
if (typeof document !== 'undefined' && !document.getElementById('bm-delete-btn-style')) {
  const s = document.createElement('style');
  s.id = 'bm-delete-btn-style';
  s.textContent = '.bm-delete-btn:hover { color: #f85149 !important; }';
  document.head.appendChild(s);
}

// Global variable to store selected target backend for migration
declare global {
  interface Window {
    __targetBackendForMigration?: string;
  }
}

interface BackendConfig {
  id: string;
  type: string;
  label: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  allowedTools?: string[];
  skipPermissions?: boolean;
  env?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  mcpServers?: Record<string, any>;
  pinned?: boolean;  // 固定后端，不可删除
}

const OFFICIAL_BACKEND_ID = 'official-claude';

const DEFAULT_TOOLS = ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write'];
const ALL_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

interface BackendManagerProps {
  isOpen: boolean;
  onClose: () => void;
  backends: BackendConfig[];
  onSaveBackend: (config: BackendConfig) => void;
  onDeleteBackend: (id: string, dependentSessions?: any[], targetBackendId?: string) => void;
  sessions?: any[];
}

function _cleanHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  Object.entries(h).forEach(([k, v]) => { if (k.trim() && v.trim()) out[k.trim()] = v.trim(); });
  return Object.keys(out).length > 0 ? out : undefined;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
};

// MCP Servers editor component
const MCP_PLACEHOLDER = `{
  "puppeteer": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
  },
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}`;

const McpServersEditor: React.FC<{
  mcpServers: Record<string, any> | undefined;
  onChange: (v: Record<string, any> | undefined) => void;
}> = ({ mcpServers, onChange }) => {
  const [text, setText] = React.useState(() =>
    mcpServers && Object.keys(mcpServers).length > 0
      ? JSON.stringify(mcpServers, null, 2)
      : ''
  );
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const handleChange = (val: string) => {
    setText(val);
    if (!val.trim()) {
      setJsonError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(val);
      setJsonError(null);
      onChange(parsed);
    } catch (e: any) {
      setJsonError(e.message);
    }
  };

  return (
    <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
        MCP Servers（可选）
      </label>
      <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 10px 0', lineHeight: 1.6 }}>
        配置 MCP (Model Context Protocol) 工具服务器。
        Claude 会自动使用这些服务器提供的工具（如 Puppeteer 截图、文件系统访问等）。
        留空则不启用 MCP。
      </p>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 4 }}>
          格式：JSON 对象，key 为服务器名称，value 为配置
        </div>
        <textarea
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          style={{
            ...inputStyle,
            height: 140,
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: 12,
            ...(jsonError ? { borderColor: 'rgba(239,68,68,0.6)' } : {}),
          }}
          placeholder={MCP_PLACEHOLDER}
          spellCheck={false}
        />
        {jsonError && (
          <p style={{ fontSize: 11, color: 'rgba(239,68,68,0.9)', margin: '4px 0 0 0' }}>
            JSON 格式错误：{jsonError}
          </p>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.6 }}>
        示例：Puppeteer 截图 → <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>npx -y @modelcontextprotocol/server-puppeteer</code>
      </div>
    </div>
  );
};

export const BackendManager: React.FC<BackendManagerProps> = ({
  isOpen,
  onClose,
  backends,
  onSaveBackend,
  onDeleteBackend,
  sessions = [],
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingBackend, setEditingBackend] = useState<BackendConfig | null>(null);
  const [formData, setFormData] = useState<BackendConfig>({
    id: '',
    type: 'claude-agent-sdk',
    label: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    env: {},
  });
  const [loginLaunching, setLoginLaunching] = useState(false);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [modelLaunching, setModelLaunching] = useState(false);
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [backendToDelete, setBackendToDelete] = useState<BackendConfig | null>(null);
  const [dependentSessions, setDependentSessions] = useState<any[]>([]);

  // MCP tab state
  const [activeTab, setActiveTab] = useState<'backends' | 'mcp'>('backends');
  const [mcpServers, setMcpServers] = useState<Record<string, any>>({});
  const [mcpLoading, setMcpLoading] = useState(false);
  const [isEditingMcp, setIsEditingMcp] = useState(false);
  const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState({ name: '', command: 'npx', args: '', env: '' });
  const [mcpSaveMsg, setMcpSaveMsg] = useState<string | null>(null);

  const handleNewBackend = useCallback(() => {
    setFormData({
      id: `backend-${Date.now()}`,
      type: 'claude-agent-sdk',
      label: '',
      model: '',
      baseUrl: '',
      apiKey: '',
      env: {},
      allowedTools: [...DEFAULT_TOOLS],
    });
    setEditingBackend(null);
    setIsEditing(true);
  }, []);

  const handleEditBackend = useCallback((backend: BackendConfig) => {
    setFormData({ ...backend, env: backend.env || {} });
    setEditingBackend(backend);
    setLoginMsg(null);
    setModelMsg(null);
    setIsEditing(true);
    // 打开官方后端编辑时，读取当前模型
    if (backend.id === OFFICIAL_BACKEND_ID) {
      api.getClaudeSettings().then(s => setCurrentModel(s.model || ''));
    }
  }, []);

  const handleSave = useCallback(() => {
    const saved: BackendConfig = {
      id: formData.id,
      type: formData.type,
      label: formData.label,
    };

    if (formData.pinned) {
      // 固定后端：只保存 env、skipPermissions、allowedTools、mcpServers
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'claude-agent-sdk') {
      // Only env vars + skipPermissions + allowedTools + mcpServers matter
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'claude-code-official') {
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      if (formData.model?.trim()) saved.model = formData.model.trim();
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'openai-compatible') {
      // base_url, api_key, model, extra_headers
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      const headers = _cleanHeaders(formData.extraHeaders);
      if (headers) saved.extraHeaders = headers;
    } else if (formData.type === 'anthropic-api') {
      // api_key, base_url, model, extra_headers
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      const headers = _cleanHeaders(formData.extraHeaders);
      if (headers) saved.extraHeaders = headers;
    } else if (formData.type === 'dashscope-image') {
      // api_key, model, base_url, env (SIZE, NEGATIVE_PROMPT, etc.)
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
    }

    onSaveBackend(saved);
    setIsEditing(false);
    onClose();
  }, [formData, onSaveBackend, onClose]);

  const handleEnvChange = useCallback((key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      env: {
        ...prev.env,
        [key]: value,
      },
    }));
  }, []);

  const handleOpenLoginTerminal = useCallback(async () => {
    setLoginLaunching(true);
    setLoginMsg(null);
    try {
      const res = await api.openLoginTerminal(formData.id);
      if (res.status === 'error') {
        setLoginMsg(res.message || '打开失败');
      } else {
        setLoginMsg('已打开终端，请在终端窗口完成登录后关闭该窗口，再回来使用。');
      }
    } catch (e: any) {
      setLoginMsg(e?.message || '打开失败');
    } finally {
      setLoginLaunching(false);
    }
  }, [formData.id]);

  const handleOpenModelTerminal = useCallback(async () => {
    setModelLaunching(true);
    setModelMsg(null);
    try {
      const res = await api.openModelTerminal(formData.id);
      if (res.status === 'error') {
        setModelMsg(res.message || '打开失败');
      } else {
        setModelMsg('已打开终端，在 claude 中输入 /model <模型名> 切换，重启 AgentWithU 后生效。');
      }
    } catch (e: any) {
      setModelMsg(e?.message || '打开失败');
    } finally {
      setModelLaunching(false);
    }
  }, [formData.id]);

  const handleDeleteClick = useCallback((backend: BackendConfig) => {
    // Find sessions that depend on this backend
    const dependents = sessions.filter(s => s.backendId === backend.id);

    // Always show confirmation dialog (two-step confirmation)
    setDependentSessions(dependents);
    setBackendToDelete(backend);
  }, [sessions]);

  const confirmDeleteBackend = useCallback(() => {
    if (backendToDelete) {
      if (dependentSessions.length > 0) {
        // 有依赖的 session，需要选择目标后端
        const targetBackendId = window.__targetBackendForMigration;
        if (!targetBackendId || targetBackendId === backendToDelete.id) {
          alert('请选择一个有效的目标后端');
          return;
        }
        // Call the original delete handler with migration info
        onDeleteBackend(backendToDelete.id, dependentSessions, targetBackendId);
        window.__targetBackendForMigration = undefined;
      } else {
        // 没有依赖的 session，直接删除
        onDeleteBackend(backendToDelete.id);
      }
      setBackendToDelete(null);
      setDependentSessions([]);
    }
  }, [backendToDelete, dependentSessions, onDeleteBackend]);

  // Load MCP servers when dialog opens
  useEffect(() => {
    if (isOpen) {
      setMcpLoading(true);
      api.getMcpServers().then(servers => {
        setMcpServers(servers);
        setMcpLoading(false);
      }).catch(() => setMcpLoading(false));
    }
  }, [isOpen]);

  const handleNewMcp = useCallback(() => {
    setMcpForm({ name: '', command: 'npx', args: '', env: '' });
    setEditingMcpName(null);
    setIsEditingMcp(true);
  }, []);

  const handleEditMcp = useCallback((name: string, srv: any) => {
    const argsStr = (srv.args || []).join('\n');
    const envStr = Object.entries(srv.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    setMcpForm({ name, command: srv.command || '', args: argsStr, env: envStr });
    setEditingMcpName(name);
    setIsEditingMcp(true);
  }, []);

  const handleSaveMcp = useCallback(async () => {
    if (!mcpForm.name.trim() || !mcpForm.command.trim()) return;
    const args = mcpForm.args.split('\n').map(s => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    mcpForm.env.split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    const srv: any = { command: mcpForm.command.trim() };
    if (args.length > 0) srv.args = args;
    if (Object.keys(env).length > 0) srv.env = env;
    const updated = { ...mcpServers, [mcpForm.name.trim()]: srv };
    const result = await api.saveMcpServers(updated);
    if (result.status === 'ok') {
      setMcpServers(updated);
      setIsEditingMcp(false);
      setMcpSaveMsg('已保存');
      setTimeout(() => setMcpSaveMsg(null), 2000);
    }
  }, [mcpForm, mcpServers]);

  const handleDeleteMcp = useCallback(async (name: string) => {
    const updated = { ...mcpServers };
    delete updated[name];
    const result = await api.saveMcpServers(updated);
    if (result.status === 'ok') {
      setMcpServers(updated);
      setMcpSaveMsg('已删除');
      setTimeout(() => setMcpSaveMsg(null), 2000);
    }
  }, [mcpServers]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--theme-text)' }}>
            {activeTab === 'mcp'
              ? (isEditingMcp ? (editingMcpName ? `编辑 ${editingMcpName}` : '添加 MCP 服务器') : 'MCP 服务器')
              : (editingBackend ? 'Edit Backend' : 'Backend Manager')
            }
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* Tab 导航 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--theme-border)', paddingBottom: 10 }}>
          {(['backends', 'mcp'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setIsEditing(false); setIsEditingMcp(false); }}
              style={{
                padding: '5px 14px', borderRadius: '6px 6px 0 0', fontSize: 13, cursor: 'pointer',
                border: 'none', background: activeTab === tab ? 'rgba(99,102,241,0.2)' : 'transparent',
                color: activeTab === tab ? 'rgba(165,168,255,0.95)' : 'var(--theme-text-muted)',
                fontWeight: activeTab === tab ? 600 : 400, transition: 'all 0.15s',
              }}
            >
              {tab === 'backends' ? '后端' : `MCP 服务器${Object.keys(mcpServers).length > 0 ? ` (${Object.keys(mcpServers).length})` : ''}`}
            </button>
          ))}
        </div>

        {activeTab === 'backends' && (!isEditing ? (
          // Backend 列表视图
          <>
            <div style={{ marginBottom: 16 }}>
              {backends.length === 0 ? (
                <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                  No backends configured
                </div>
              ) : (
                backends.map((backend) => (
                  <div
                    key={backend.id}
                    style={{
                      ...backendItemStyle,
                      ...(backend.pinned ? { borderLeft: '2px solid rgba(99,102,241,0.6)' } : {}),
                    }}
                    onClick={() => handleEditBackend(backend)}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {backend.pinned && <span style={{ fontSize: 10, color: 'rgba(165,168,255,0.8)' }}>📌</span>}
                        {backend.label}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                        {backend.type}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_MODEL && (
                          <span> · {backend.env.ANTHROPIC_MODEL}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_AUTH_TOKEN && (
                          <span> · Auth</span>
                        )}
                        {backend.type === 'claude-code-official' && (
                          <span> · 官方账户{backend.env?.HTTPS_PROXY ? ' · 代理✓' : ' · ⚠️无代理'}</span>
                        )}
                        {(backend.type === 'openai-compatible' || backend.type === 'anthropic-api' || backend.type === 'claude-code-official' || backend.type === 'dashscope-image') && backend.model && (
                          <span> · 🤖{backend.model}</span>
                        )}
                        {backend.baseUrl && (
                          <span> · {backend.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_BASE_URL && (
                          <span> · {backend.env.ANTHROPIC_BASE_URL.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                      </div>
                    </div>
                    {!backend.pinned && (
                      <button
                        className="bm-delete-btn"
                        onClick={(e) => { e.stopPropagation(); handleDeleteClick(backend); }}
                        style={deleteBtnStyle}
                        title="Delete backend"
                      >
                        🗑
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <button onClick={handleNewBackend} style={addBtnStyle}>
              + New Backend
            </button>
          </>
        ) : (
          // 编辑表单
          <>
            {/* 固定后端（官方账户）不显示 ID/Label/Type 字段 */}
            {!formData.pinned && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Backend ID</label>
                  <input
                    type="text"
                    value={formData.id}
                    onChange={(e) => setFormData({ ...formData, id: e.target.value })}
                    style={inputStyle}
                    placeholder="backend-id"
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Label (Display Name)</label>
                  <input
                    type="text"
                    value={formData.label}
                    onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                    style={inputStyle}
                    placeholder="My Custom Backend"
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Type</label>
                  <div style={selectWrapperStyle}>
                    <select
                      value={formData.type}
                      onChange={(e) => {
                        const newType = e.target.value;
                        setFormData({
                          ...formData,
                          type: newType,
                          model: '',
                          baseUrl: '',
                          apiKey: '',
                          env: {},
                          extraHeaders: undefined,
                          skipPermissions: newType === 'claude-agent-sdk' ? true : undefined,
                        });
                      }}
                      style={selectStyle}
                    >
                      <option value="claude-agent-sdk">Claude Agent SDK</option>
                      <option value="openai-compatible">OpenAI Compatible</option>
                      <option value="anthropic-api">Anthropic API</option>
                      <option value="dashscope-image">DashScope 文生图（万象/Wan）</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            {/* ── Claude Agent SDK 专属配置 ── */}
            {formData.type === 'claude-agent-sdk' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Claude Agent SDK 配置</label>

                {/* ANTHROPIC_AUTH_TOKEN：手动填入 */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_AUTH_TOKEN（可选，用于 claude.ai OAuth token）
                  </label>
                  <input
                    type="password"
                    value={formData.env?.ANTHROPIC_AUTH_TOKEN || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_AUTH_TOKEN', e.target.value)}
                    style={inputStyle}
                    placeholder="sk-ant-oat01-...（官方账户 OAuth token）"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                    如需使用官方账户，请运行<code style={{ fontSize: 9 }}>claude login</code>或在终端中输入<code style={{ fontSize: 9 }}>/login</code>。
                  </p>
                </div>

                {/* ANTHROPIC_BASE_URL：代理地址（可选） */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_BASE_URL（代理地址，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.ANTHROPIC_BASE_URL || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_BASE_URL', e.target.value)}
                    style={inputStyle}
                    placeholder="e.g., https://coding.dashscope.aliyuncs.com/apps/anthropic"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_MODEL（来自上下文/知识配置）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.ANTHROPIC_MODEL || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_MODEL', e.target.value)}
                    style={inputStyle}
                    placeholder="e.g., claude-sonnet-4-6（留空由 CLI 自动决定）"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                    模型配置将传递给 Claude Agent SDK，留空时使用默认模型。
                  </p>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTPS_PROXY（代理，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTPS_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="留空不走代理，e.g., http://127.0.0.1:7890"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '3px 0 0 0' }}>
                    填写后 CLI 子进程的所有请求均走此代理（Clash 默认端口 7890）
                  </p>
                </div>

                {/* ── 允许的工具 ── */}
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
                    允许使用的工具
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ALL_TOOLS.map(tool => {
                      const checked = (formData.allowedTools ?? DEFAULT_TOOLS).includes(tool);
                      const isNetwork = tool === 'WebSearch' || tool === 'WebFetch';
                      return (
                        <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          padding: '3px 8px', borderRadius: 4, fontSize: 11,
                          background: checked ? (isNetwork ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${checked ? (isNetwork ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.4)') : 'rgba(255,255,255,0.12)'}`,
                          color: checked ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = formData.allowedTools ?? [...DEFAULT_TOOLS];
                              setFormData({ ...formData, allowedTools: e.target.checked
                                ? [...cur, tool]
                                : cur.filter(t => t !== tool)
                              });
                            }}
                            style={{ accentColor: 'var(--theme-accent)', width: 11, height: 11 }}
                          />
                          {tool}
                          {isNetwork && <span style={{ fontSize: 9, opacity: 0.7 }}>🌐</span>}
                        </label>
                      );
                    })}
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '5px 0 0 0' }}>
                    WebSearch / WebFetch 为网络工具，默认不启用。两个后端均使用 bypassPermissions 模式，无需修改 settings.json。
                  </p>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (bypassPermissions 模式)
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px' }}>
                    启用后 Claude 可直接调用工具，无需逐条确认。
                  </p>
                </div>
              </div>
            )}

            {/* ── Claude Code 官方账户 专属配置 ── */}
            {formData.type === 'claude-code-official' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Claude Code 官方账户配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0', lineHeight: 1.6 }}>
                  凭证自动从 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>~/.claude/.credentials.json</code> 读取（需先运行 <code style={{ fontSize: 10 }}>claude login</code>）。
                  <br />只需配置代理即可使用。
                </p>

                {/* 一键登录卡片 */}
                <div style={{
                  marginBottom: 14, padding: 12, borderRadius: 8,
                  background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(165,168,255,0.95)', marginBottom: 6 }}>
                    🔑 第一步：登录 Claude 账户
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
                    点击下方按钮，将自动打开终端窗口并启动 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>claude</code>
                    {formData.env?.HTTPS_PROXY
                      ? <span>（代理 <code style={{ fontSize: 10 }}>{formData.env.HTTPS_PROXY}</code> 已自动设置）</span>
                      : <span>（若需要代理请先在下方填写 HTTPS_PROXY）</span>
                    }。<br />
                    终端打开后，在提示下方<strong style={{ color: 'rgba(165,168,255,0.95)' }}>输入 <code style={{ fontSize: 10 }}>/login</code> 并按回车</strong>，按指引完成登录即可。
                  </div>
                  <button
                    onClick={handleOpenLoginTerminal}
                    disabled={loginLaunching}
                    style={{
                      fontSize: 12, padding: '7px 16px', borderRadius: 6,
                      border: '1px solid rgba(99,102,241,0.5)',
                      background: loginLaunching ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.35)',
                      color: 'rgba(200,201,255,0.95)', fontWeight: 500,
                      cursor: loginLaunching ? 'wait' : 'pointer',
                    }}
                  >
                    {loginLaunching ? '正在打开终端...' : '📂 一键打开登录终端'}
                  </button>
                  {loginMsg && (
                    <p style={{ fontSize: 11, margin: '8px 0 0 0', lineHeight: 1.5,
                      color: loginMsg.includes('失败') ? 'rgba(239,68,68,0.9)' : 'rgba(34,197,94,0.9)' }}>
                      {loginMsg}
                    </p>
                  )}
                </div>

                {/* 模型状态 + 换模型卡片 */}
                <div style={{
                  marginBottom: 14, padding: 12, borderRadius: 8,
                  background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(110,231,183,0.9)', marginBottom: 6 }}>
                    🤖 当前模型（来自上下文/知识配置）
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--theme-text)', marginBottom: 10, fontFamily: 'monospace' }}>
                    {currentModel ? (
                      <span>{currentModel} <span style={{ color: 'rgba(110,231,183,0.6)', fontSize: 11 }}>(来自 ~/.claude/settings.json)</span></span>
                    ) : (
                      <span style={{ color: 'var(--theme-text-muted)', fontFamily: 'inherit', fontSize: 12 }}>默认（由 CLI 自动决定）</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
                    点击下方按钮打开终端，在 claude 中输入{' '}
                    <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>/model &lt;模型名&gt;</code>{' '}
                    切换，常用：<code style={{ fontSize: 10 }}>claude-opus-4-6</code> / <code style={{ fontSize: 10 }}>claude-sonnet-4-6</code>
                  </div>
                  <button
                    onClick={handleOpenModelTerminal}
                    disabled={modelLaunching}
                    style={{
                      fontSize: 12, padding: '7px 16px', borderRadius: 6,
                      border: '1px solid rgba(16,185,129,0.4)',
                      background: modelLaunching ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.2)',
                      color: 'rgba(110,231,183,0.9)', fontWeight: 500,
                      cursor: modelLaunching ? 'wait' : 'pointer',
                    }}
                  >
                    {modelLaunching ? '正在打开终端...' : '🔀 打开终端换模型'}
                  </button>
                  {modelMsg && (
                    <p style={{ fontSize: 11, margin: '8px 0 0 0', lineHeight: 1.5,
                      color: modelMsg.includes('失败') ? 'rgba(239,68,68,0.9)' : 'rgba(34,197,94,0.9)' }}>
                      {modelMsg}
                    </p>
                  )}
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTPS_PROXY <span style={{ color: 'rgba(239,68,68,0.8)' }}>* 必填（Windows 系统代理自动检测不可靠）</span>
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTPS_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="http://127.0.0.1:7890（Clash 默认端口）"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTP_PROXY（与 HTTPS_PROXY 保持一致即可）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTP_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTP_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="http://127.0.0.1:7890"
                  />
                </div>

                {/* ── 允许的工具（官方账户） ── */}
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
                    允许使用的工具
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ALL_TOOLS.map(tool => {
                      const checked = (formData.allowedTools ?? DEFAULT_TOOLS).includes(tool);
                      const isNetwork = tool === 'WebSearch' || tool === 'WebFetch';
                      return (
                        <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          padding: '3px 8px', borderRadius: 4, fontSize: 11,
                          background: checked ? (isNetwork ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${checked ? (isNetwork ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.4)') : 'rgba(255,255,255,0.12)'}`,
                          color: checked ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = formData.allowedTools ?? [...DEFAULT_TOOLS];
                              setFormData({ ...formData, allowedTools: e.target.checked
                                ? [...cur, tool]
                                : cur.filter(t => t !== tool)
                              });
                            }}
                            style={{ accentColor: 'var(--theme-accent)', width: 11, height: 11 }}
                          />
                          {tool}
                          {isNetwork && <span style={{ fontSize: 9, opacity: 0.7 }}>🌐</span>}
                        </label>
                      );
                    })}
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '5px 0 0 0' }}>
                    官方账户使用 --dangerously-skip-permissions，勾选即生效，无需改 settings.json。
                  </p>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (--dangerously-skip-permissions)
                  </label>
                </div>
              </div>
            )}

            {/* ── MCP Servers 配置（claude-agent-sdk / claude-code-official）── */}
            {(formData.type === 'claude-agent-sdk' || formData.type === 'claude-code-official' || formData.pinned) && (
              <McpServersEditor
                mcpServers={formData.mcpServers}
                onChange={(v) => setFormData((prev) => ({ ...prev, mcpServers: v }))}
              />
            )}

            {/* ── OpenAI Compatible 专属配置 ── */}
            {formData.type === 'openai-compatible' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>OpenAI Compatible 配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0' }}>
                  兼容 OpenAI Chat Completions API 的服务（OpenAI、通义、DeepSeek、Ollama 等）。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Model <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="e.g., gpt-4o / deepseek-chat / qwen-plus"
                  />
                </div>

                <div style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Extra HTTP Headers（可选，每行 Key: Value）
                  </label>
                  <textarea
                    value={Object.entries(formData.extraHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    onChange={(e) => {
                      const headers: Record<string, string> = {};
                      e.target.value.split('\n').forEach(line => {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                          const key = line.slice(0, idx).trim();
                          const val = line.slice(idx + 1).trim();
                          if (key) headers[key] = val;
                        }
                      });
                      setFormData({ ...formData, extraHeaders: headers });
                    }}
                    style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    placeholder={'Authorization: Bearer token\nX-Custom-Header: value'}
                  />
                </div>
              </div>
            )}

            {/* ── Anthropic API 专属配置 ── */}
            {formData.type === 'anthropic-api' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Anthropic API 配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0' }}>
                  直接调用 Anthropic Messages API，不依赖 CLI。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-ant-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Model <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="e.g., claude-sonnet-4-6"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL（代理地址，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="留空使用官方 https://api.anthropic.com"
                  />
                </div>

                <div style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Extra HTTP Headers（可选，每行 Key: Value）
                  </label>
                  <textarea
                    value={Object.entries(formData.extraHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    onChange={(e) => {
                      const headers: Record<string, string> = {};
                      e.target.value.split('\n').forEach(line => {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                          const key = line.slice(0, idx).trim();
                          const val = line.slice(idx + 1).trim();
                          if (key) headers[key] = val;
                        }
                      });
                      setFormData({ ...formData, extraHeaders: headers });
                    }}
                    style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    placeholder={'MM-Group-Id: 123456789\nX-Custom-Header: value'}
                  />
                </div>
              </div>
            )}

            {/* ── DashScope 文生图专属配置 ── */}
            {formData.type === 'dashscope-image' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>DashScope 文生图配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0' }}>
                  阿里云万象（wanx / wan）系列文生图模型，使用异步任务 API。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    模型
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="wanx2.1-t2i-turbo（默认）"
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    可选：wanx2.1-t2i-turbo / wanx2.1-t2i-plus / wanx2.0-t2i-turbo / wan2.1-t2i-turbo
                  </span>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    图片尺寸（SIZE）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.SIZE || ''}
                    onChange={(e) => handleEnvChange('SIZE', e.target.value)}
                    style={inputStyle}
                    placeholder="1024*1024（默认）"
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    常用：1024*1024 / 1280*720 / 720*1280 / 1328*1328 / 2048*2048
                  </span>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    反向提示词（NEGATIVE_PROMPT，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.NEGATIVE_PROMPT || ''}
                    onChange={(e) => handleEnvChange('NEGATIVE_PROMPT', e.target.value)}
                    style={inputStyle}
                    placeholder="blurry, low quality, watermark..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL（可选，覆盖默认 API 地址）
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="留空使用 https://dashscope.aliyuncs.com/api/v1"
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    新加坡节点：https://dashscope-intl.aliyuncs.com/api/v1
                  </span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={handleSave} style={saveBtnStyle}>
                Save
              </button>
              <button onClick={() => setIsEditing(false)} style={cancelBtnStyle}>
                Back
              </button>
            </div>
          </>
        ))}

        {/* MCP 服务器 Tab */}
        {activeTab === 'mcp' && !isEditingMcp && (
          <>
            {mcpLoading ? (
              <div style={{ textAlign: 'center', color: 'var(--theme-text-muted)', padding: 20, fontSize: 13 }}>加载中...</div>
            ) : Object.keys(mcpServers).length === 0 ? (
              <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
                尚未配置 MCP 服务器
                <br />
                <span style={{ fontSize: 11, display: 'block', marginTop: 6 }}>MCP 服务器可为 Claude 提供额外工具，如 GitHub、数据库、浏览器自动化等</span>
              </div>
            ) : (
              Object.entries(mcpServers).map(([name, srv]: [string, any]) => (
                <div
                  key={name}
                  style={{ ...backendItemStyle }}
                  onClick={() => handleEditMcp(name, srv)}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11 }}>🔧</span>{name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', fontFamily: 'monospace' }}>
                      {srv.command} {(srv.args || []).slice(0, 3).join(' ')}{(srv.args?.length ?? 0) > 3 ? ' …' : ''}
                    </div>
                  </div>
                  <button
                    className="bm-delete-btn"
                    onClick={(e) => { e.stopPropagation(); handleDeleteMcp(name); }}
                    style={deleteBtnStyle}
                    title="删除"
                  >🗑</button>
                </div>
              ))
            )}
            <button
              onClick={handleNewMcp}
              style={{ ...addBtnStyle, background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', color: 'rgba(165,168,255,0.9)', marginTop: 8 }}
            >
              + 添加 MCP 服务器
            </button>
            {mcpSaveMsg && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(34,197,94,0.85)', textAlign: 'center' }}>{mcpSaveMsg}</div>
            )}
            <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.7 }}>
              💡 推荐：<code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>@modelcontextprotocol/server-github</code>（GitHub 操作）、
              <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>@modelcontextprotocol/server-puppeteer</code>（浏览器自动化）。
              配置后重启应用生效。
            </div>
          </>
        )}

        {activeTab === 'mcp' && isEditingMcp && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>服务器名称（唯一标识符）</label>
              <input
                type="text"
                value={mcpForm.name}
                onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                style={{ ...inputStyle, ...(editingMcpName !== null ? { opacity: 0.6 } : {}) }}
                placeholder="e.g., github, puppeteer, sqlite"
                readOnly={editingMcpName !== null}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>命令</label>
              <input
                type="text"
                value={mcpForm.command}
                onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                style={inputStyle}
                placeholder="e.g., npx, node, python"
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>参数（每行一个）</label>
              <textarea
                value={mcpForm.args}
                onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                style={{ ...inputStyle, height: 90, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                placeholder={'-y\n@modelcontextprotocol/server-github'}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>环境变量（每行 KEY=VALUE，可选）</label>
              <textarea
                value={mcpForm.env}
                onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })}
                style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                placeholder={'GITHUB_TOKEN=ghp_xxx\nANOTHER_KEY=value'}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={handleSaveMcp}
                disabled={!mcpForm.name.trim() || !mcpForm.command.trim()}
                style={{ ...saveBtnStyle, opacity: (!mcpForm.name.trim() || !mcpForm.command.trim()) ? 0.5 : 1 }}
              >
                Save
              </button>
              <button onClick={() => setIsEditingMcp(false)} style={cancelBtnStyle}>Back</button>
            </div>
          </>
        )}

        {/* 删除确认对话框 - 有依赖的 session 时 */}
        {backendToDelete && dependentSessions.length > 0 && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 'auto', maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
                删除后端将影响 {dependentSessions.length} 个会话
              </h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                后端 <strong style={{ color: 'rgba(255,100,100,0.9)' }}>{backendToDelete.label}</strong> 当前被以下会话引用：
              </p>
              <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 16, background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 12 }}>
                {dependentSessions.slice(0, 8).map((s) => (
                  <div key={s.id} style={{ fontSize: 12, color: 'var(--theme-text)', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ flex: 1 }}>{s.title || s.workingDir}</span>
                    <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{s.messageCount} 条消息</span>
                  </div>
                ))}
                {dependentSessions.length > 8 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', textAlign: 'center', marginTop: 8 }}>
                    还有 {dependentSessions.length - 8} 个会话...
                  </div>
                )}
              </div>

              {/* 选择目标后端 */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 8px 0' }}>
                  请选择目标后端，将这些会话迁移到：
                </p>
                <TargetBackendSelector
                  backends={backends}
                  currentBackendId={backendToDelete.id}
                  onSelected={(id) => {
                    // Store selected target backend for migration
                    window.__targetBackendForMigration = id;
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={confirmDeleteBackend} style={{ ...confirmBtnStyle, flex: 1 }}>
                  迁移并删除
                </button>
                <button onClick={() => { setBackendToDelete(null); setDependentSessions([]); }} style={cancelBtnStyle}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除确认对话框 - 没有依赖的 session 时 */}
        {backendToDelete && dependentSessions.length === 0 && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 'auto', maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
                确认删除后端
              </h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                确定要删除后端 <strong style={{ color: 'rgba(255,100,100,0.9)' }}>{backendToDelete.label}</strong> 吗？
              </p>
              <p style={{ fontSize: 12, color: 'var(--theme-text-muted)', margin: '0 0 16px 0' }}>
                此操作不可撤销。
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={confirmDeleteBackend} style={{ ...confirmBtnStyle, flex: 1 }}>
                  删除
                </button>
                <button onClick={() => { setBackendToDelete(null); setDependentSessions([]); }} style={cancelBtnStyle}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---- styles ---- */
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)', borderRadius: 12,
  padding: 24, width: '90%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px',
};

const backendItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: 12, marginBottom: 8,
  background: 'rgba(255,255,255,0.05)', borderRadius: 8,
  cursor: 'pointer', transition: 'all 0.15s',
};

const deleteBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', fontSize: 15,
  cursor: 'pointer', padding: '4px 8px',
  color: 'var(--theme-text-muted, #656d76)',
  transition: 'color 0.15s',
};

const addBtnStyle: React.CSSProperties = {
  width: '100%', padding: 12, borderRadius: 8,
  background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
  color: 'rgba(34,197,94,0.9)', fontSize: 14, fontWeight: 500,
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--theme-text)',
  display: 'block', marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--theme-bg-tertiary)',
  border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text)', fontSize: 13, outline: 'none', cursor: 'pointer',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  appearance: 'none',
};

const selectWrapperStyle: React.CSSProperties = {
  position: 'relative',
};

const saveBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'rgba(99,102,241,0.8)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', fontSize: 14, cursor: 'pointer',
};

const confirmBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'rgba(239,68,68,0.8)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

/* ---- Target Backend Selector ---- */
interface TargetBackendSelectorProps {
  backends: BackendConfig[];
  currentBackendId: string;
  onSelected: (id: string) => void;
}

const TargetBackendSelector: React.FC<TargetBackendSelectorProps> = ({
  backends,
  currentBackendId,
  onSelected,
}) => {
  const remainingBackends = backends.filter(b => b.id !== currentBackendId);
  const [selectedId, setSelectedId] = useState(remainingBackends[0]?.id || '');

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedId(e.target.value);
    onSelected(e.target.value);
  }, [onSelected]);

  if (remainingBackends.length === 0) {
    return (
      <div style={{ padding: 12, background: 'rgba(239,68,68,0.2)', borderRadius: 6, color: 'rgba(255,100,100,0.9)', fontSize: 13 }}>
        没有其他可用的后端。删除此后端前，请先创建新的后端配置。
      </div>
    );
  }

  return (
    <div style={selectWrapperStyle}>
      <select
        value={selectedId}
        onChange={handleChange}
        style={selectStyle}
      >
        {remainingBackends.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label} ({b.type})
          </option>
        ))}
      </select>
    </div>
  );
};

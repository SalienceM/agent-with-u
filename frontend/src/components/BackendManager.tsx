import React, { useState, useCallback, useRef } from 'react';
import { api } from '../api';

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
}

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
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [backendToDelete, setBackendToDelete] = useState<BackendConfig | null>(null);
  const [dependentSessions, setDependentSessions] = useState<any[]>([]);

  const handleNewBackend = useCallback(() => {
    setFormData({
      id: `backend-${Date.now()}`,
      type: 'claude-agent-sdk',
      label: '',
      model: '',
      baseUrl: '',
      apiKey: '',
      env: {},
    });
    setEditingBackend(null);
    setIsEditing(true);
  }, []);

  const handleEditBackend = useCallback((backend: BackendConfig) => {
    setFormData({ ...backend, env: backend.env || {} });
    setEditingBackend(backend);
    setIsEditing(true);
  }, []);

  const handleSave = useCallback(() => {
    const saved: BackendConfig = {
      id: formData.id,
      type: formData.type,
      label: formData.label,
    };

    if (formData.type === 'claude-agent-sdk') {
      // Only env vars + skipPermissions matter
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      saved.skipPermissions = formData.skipPermissions !== false;
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

  const handleGetOAuthToken = useCallback(async () => {
    setOauthLoading(true);
    setOauthError(null);
    try {
      const result = await api.startOAuthFlow();
      if (result.token) {
        // OAuth token 存入 ANTHROPIC_AUTH_TOKEN，同时设 BASE_URL 为 api.claude.ai
        // （claude.ai OAuth token 必须走 api.claude.ai，否则认证失败）
        setFormData((prev) => ({
          ...prev,
          env: {
            ...prev.env,
            ANTHROPIC_AUTH_TOKEN: result.token!,
            ANTHROPIC_BASE_URL: prev.env?.ANTHROPIC_BASE_URL || 'https://api.claude.ai',
          },
        }));
      } else {
        setOauthError(result.error || '获取失败');
      }
    } catch (e: any) {
      setOauthError(e?.message || '获取失败');
    } finally {
      setOauthLoading(false);
    }
  }, [handleEnvChange]);

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

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--theme-text)' }}>
            {editingBackend ? 'Edit Backend' : 'Backend Manager'}
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {!isEditing ? (
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
                    style={backendItemStyle}
                    onClick={() => handleEditBackend(backend)}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4 }}>
                        {backend.label}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                        {backend.type}
                        {/* Show model info per type */}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_MODEL && (
                          <span> · {backend.env.ANTHROPIC_MODEL}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_AUTH_TOKEN && (
                          <span> · Auth</span>
                        )}
                        {(backend.type === 'openai-compatible' || backend.type === 'anthropic-api') && backend.model && (
                          <span> · {backend.model}</span>
                        )}
                        {backend.baseUrl && (
                          <span> · {backend.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_BASE_URL && (
                          <span> · {backend.env.ANTHROPIC_BASE_URL.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClick(backend);
                      }}
                      style={deleteBtnStyle}
                      title="Delete backend"
                    >
                      🗑
                    </button>
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
                    // Reset type-specific fields when switching types
                    const newType = e.target.value;
                    setFormData({
                      ...formData,
                      type: newType,
                      // Clear type-specific fields on switch
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
                </select>
              </div>
            </div>

            {/* ── Claude Agent SDK 专属配置 ── */}
            {formData.type === 'claude-agent-sdk' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Claude Agent SDK 配置</label>

                {/* ANTHROPIC_AUTH_TOKEN：手动粘贴或浏览器 OAuth 自动填入 */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 11, color: 'var(--theme-text)' }}>ANTHROPIC_AUTH_TOKEN</label>
                    <button
                      onClick={handleGetOAuthToken}
                      disabled={oauthLoading}
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: oauthLoading ? 'wait' : 'pointer',
                        border: '1px solid var(--theme-accent)',
                        background: oauthLoading ? 'var(--theme-bg-tertiary)' : 'var(--theme-accent-bg)',
                        color: 'var(--theme-accent)', fontWeight: 500,
                      }}
                    >
                      {oauthLoading ? '等待浏览器登录...' : '浏览器登录自动填入'}
                    </button>
                  </div>
                  <input
                    type="password"
                    value={formData.env?.ANTHROPIC_AUTH_TOKEN || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_AUTH_TOKEN', e.target.value)}
                    style={inputStyle}
                    placeholder="sk-ant-... 或点击右侧按钮通过浏览器登录获取"
                  />
                  {oauthError && (
                    <p style={{ fontSize: 11, color: 'var(--theme-error, #cf222e)', margin: '4px 0 0 0' }}>
                      {oauthError}
                    </p>
                  )}
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
                    ANTHROPIC_MODEL
                  </label>
                  <input
                    type="text"
                    value={formData.env?.ANTHROPIC_MODEL || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_MODEL', e.target.value)}
                    style={inputStyle}
                    placeholder="e.g., claude-sonnet-4-6（留空由 CLI 自动决定）"
                  />
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

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={handleSave} style={saveBtnStyle}>
                Save
              </button>
              <button onClick={() => setIsEditing(false)} style={cancelBtnStyle}>
                Back
              </button>
            </div>
          </>
        )}

        {/* 删除确认对话框 - 有依赖的 session 时 */}
        {backendToDelete && dependentSessions.length > 0 && (
          <div style={overlayStyle} onClick={() => setBackendToDelete(null)}>
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
          <div style={overlayStyle} onClick={() => setBackendToDelete(null)}>
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
  background: 'none', border: 'none', fontSize: 16,
  cursor: 'pointer', padding: '4px 8px', opacity: 0.6,
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

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
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

import React, { useState, useCallback } from 'react';

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
}

interface BackendManagerProps {
  isOpen: boolean;
  onClose: () => void;
  backends: BackendConfig[];
  onSaveBackend: (config: BackendConfig) => void;
  onDeleteBackend: (id: string, dependentSessions?: any[], targetBackendId?: string) => void;
  sessions?: any[];
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
  const [backendToDelete, setBackendToDelete] = useState<BackendConfig | null>(null);
  const [dependentSessions, setDependentSessions] = useState<any[]>([]);

  const handleNewBackend = useCallback(() => {
    console.log('[BackendManager] handleNewBackend clicked');
    setFormData({
      id: `backend-${Date.now()}`,
      type: 'claude-agent-sdk',
      label: '',
      model: '',
      baseUrl: '',
      apiKey: '',
      env: {
        ANTHROPIC_MODEL: '',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    });
    setEditingBackend(null);
    setIsEditing(true);
    console.log('[BackendManager] isEditing set to true');
  }, []);

  const handleEditBackend = useCallback((backend: BackendConfig) => {
    console.log('[BackendManager] handleEditBackend:', backend);
    setFormData({
      ...backend,
      env: {
        ANTHROPIC_MODEL: backend.env?.ANTHROPIC_MODEL || '',
        ANTHROPIC_BASE_URL: backend.env?.ANTHROPIC_BASE_URL || '',
        ANTHROPIC_AUTH_TOKEN: backend.env?.ANTHROPIC_AUTH_TOKEN || '',
      },
    });
    setEditingBackend(backend);
    setIsEditing(true);
  }, []);

  const handleSave = useCallback(() => {
    // Clean up empty env values
    const cleanedEnv: Record<string, string> = {};
    if (formData.env) {
      Object.entries(formData.env).forEach(([key, value]) => {
        if (value && value.trim()) {
          cleanedEnv[key] = value.trim();
        }
      });
    }

    onSaveBackend({
      ...formData,
      env: Object.keys(cleanedEnv).length > 0 ? cleanedEnv : undefined,
    });
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
                        {backend.model && <span> · Model: {backend.model}</span>}
                        {backend.env?.ANTHROPIC_MODEL && (
                          <span> · Env Model: {backend.env.ANTHROPIC_MODEL}</span>
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
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  style={selectStyle}
                >
                  <option value="claude-agent-sdk">Claude Agent SDK</option>
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="anthropic-api">Anthropic API</option>
                </select>
              </div>
            </div>

            {/* 环境变量配置 */}
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
              <label style={{ ...labelStyle, marginBottom: 8 }}>
                Environment Variables (Per-Backend)
              </label>
              <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0' }}>
                These override global environment variables for this specific backend.
              </p>

              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                  ANTHROPIC_MODEL
                </label>
                <input
                  type="text"
                  value={formData.env?.ANTHROPIC_MODEL || ''}
                  onChange={(e) => handleEnvChange('ANTHROPIC_MODEL', e.target.value)}
                  style={inputStyle}
                  placeholder="e.g., claude-sonnet-4-5-20251022"
                />
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                  ANTHROPIC_BASE_URL
                </label>
                <input
                  type="text"
                  value={formData.env?.ANTHROPIC_BASE_URL || ''}
                  onChange={(e) => handleEnvChange('ANTHROPIC_BASE_URL', e.target.value)}
                  style={inputStyle}
                  placeholder="e.g., https://api.anthropic.com"
                />
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                  ANTHROPIC_AUTH_TOKEN
                </label>
                <input
                  type="password"
                  value={formData.env?.ANTHROPIC_AUTH_TOKEN || ''}
                  onChange={(e) => handleEnvChange('ANTHROPIC_AUTH_TOKEN', e.target.value)}
                  style={inputStyle}
                  placeholder="sk-ant-..."
                />
              </div>
            </div>

            {/* Skip Permissions - 仅 claude-agent-sdk 支持 */}
            {formData.type === 'claude-agent-sdk' && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                  <input
                    type="checkbox"
                    checked={formData.skipPermissions !== false}
                    onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                    style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                  />
                  Skip Permissions (bypassPermissions mode)
                </label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px' }}>
                  启用后 Claude 可直接调用工具，无需逐条确认。
                </p>
              </div>
            )}

            {/* For OpenAI Compatible backends */}
            {formData.type === 'openai-compatible' && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Base URL</label>
                  <input
                    type="text"
                    value={formData.baseUrl}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>API Key</label>
                  <input
                    type="password"
                    value={formData.apiKey}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>
              </>
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

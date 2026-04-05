import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api';

// 注入卡片悬停样式
if (typeof document !== 'undefined' && !document.getElementById('repo-panel-css')) {
  const s = document.createElement('style');
  s.id = 'repo-panel-css';
  s.textContent = `
    .repo-card:hover { border-color: var(--theme-accent, #7aa2f7) !important; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .repo-card:hover .repo-card-actions { opacity: 1 !important; }
    .repo-column-separator { border-right: 1px solid var(--theme-border); }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════
//  Types
// ═══════════════════════════════════════
interface SkillItem {
  id?: string;
  name: string;
  content?: string;
  isGlobal?: boolean;
  isProject?: boolean;
}
interface PromptItem {
  id?: string;
  name: string;
  content: string;
  icon: string;
  createdAt?: number;
  updatedAt?: number;
}
interface Props {
  open: boolean;
  workingDir: string;
  onClose: () => void;
}

// 常用 emoji 列表
const ICONS = ['📝', '🚀', '🎯', '🔧', '💡', '🛡️', '📊', '🎨', '🔬', '📦', '⚡', '🌐', '🤖', '🧩', '📋', '🔑'];

// 解析 SKILL.md frontmatter 中的 backend 字段
function parseSkillBackend(content: string): string {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return '';
  const line = m[1].match(/backend:\s*(.+)/);
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : '';
}

// 更新 SKILL.md frontmatter 中的 backend 字段
function setSkillBackend(content: string, backendId: string): string {
  const fmMatch = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    // 没有 frontmatter，不处理
    return content;
  }
  const fmBody = fmMatch[2];
  const rest = content.slice(fmMatch[0].length);
  const hasBackend = /^backend:\s*.*/m.test(fmBody);

  if (backendId) {
    if (hasBackend) {
      // 替换已有的 backend 行
      const newFmBody = fmBody.split('\n').map(l =>
        /^backend:\s*/.test(l) ? `backend: ${backendId}` : l
      ).join('\n');
      return `${fmMatch[1]}${newFmBody}${fmMatch[3]}${rest}`;
    } else {
      // 在 frontmatter 末尾添加
      return `${fmMatch[1]}${fmBody}\nbackend: ${backendId}${fmMatch[3]}${rest}`;
    }
  } else {
    // 移除 backend 行
    if (hasBackend) {
      const newFmBody = fmBody.split('\n').filter(l => !/^backend:\s*/.test(l)).join('\n');
      return `${fmMatch[1]}${newFmBody}${fmMatch[3]}${rest}`;
    }
    return content;
  }
}

// ═══════════════════════════════════════
//  内置 Skill 类型注册表
// ═══════════════════════════════════════
interface SkillTypePreset {
  id: string;
  icon: string;
  label: string;
  description: string;
  backendType: string;  // 匹配 backend.type
  template: (backendId: string) => { name: string; content: string };
}

const SKILL_TYPE_PRESETS: SkillTypePreset[] = [
  {
    id: 'image-generation',
    icon: '🎨',
    label: '图像生成',
    description: '文生图 / 图生图，支持尺寸和参考图',
    backendType: 'dashscope-image',
    template: (backendId) => ({
      name: 'generate-image',
      content: [
        '---',
        'name: generate-image',
        'description: 仅当用户明确要求画图、生成图像、创建插画时才调用。普通对话、问答、对比分析、写代码等文字类请求绝对不要调用此 Skill。',
        `backend: ${backendId}`,
        'input_schema:',
        '  type: object',
        '  properties:',
        '    prompt:',
        '      type: string',
        '      description: 图片内容的详细描述',
        '  required:',
        '    - prompt',
        '---',
      ].join('\n'),
    }),
  },
  // 未来扩展：语音合成、数据分析等
];

// ═══════════════════════════════════════
//  RepoPanel — Skill + Prompt 仓库面板
// ═══════════════════════════════════════
export const RepoPanel: React.FC<Props> = ({ open, workingDir, onClose }) => {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  // 编辑状态
  const [editingType, setEditingType] = useState<'skill' | 'prompt' | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingContent, setEditingContent] = useState('');
  const [editingIcon, setEditingIcon] = useState('📝');
  const [editingOrigName, setEditingOrigName] = useState<string | null>(null); // null = 新建
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  // Backend Skill：后端列表（用于下拉选择）
  const [backends, setBackends] = useState<{ id: string; label: string; type?: string }[]>([]);
  // 新建 Skill 时的类型选择
  const [showSkillTypeSelector, setShowSkillTypeSelector] = useState(false);
  // 删除二次确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'skill' | 'prompt'; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [sk, pr, bks] = await Promise.all([
      api.listSkills(workingDir),
      api.listPrompts(),
      api.getBackends().catch(() => []),
    ]);
    setSkills(sk || []);
    setPrompts(pr || []);
    setBackends((bks || []).map((b: any) => ({ id: b.id, label: b.label || b.id, type: b.type })));
  }, [workingDir]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // ── 打开编辑器 ──
  const openEditor = useCallback((type: 'skill' | 'prompt', item?: SkillItem | PromptItem) => {
    setEditingType(type);
    if (item) {
      setEditingName(item.name);
      setEditingContent(item.content || '');
      setEditingIcon((item as PromptItem).icon || '📝');
      setEditingOrigName(item.name);
    } else {
      setEditingName('');
      // 新建 Skill 时提供默认 frontmatter 模板（确保有 frontmatter 可以选择 backend）
      setEditingContent(type === 'skill' ? '---\nname: \ndescription: \n---\n\n## Instructions\n\n' : '');
      setEditingIcon('📝');
      setEditingOrigName(null);
    }
    setShowIconPicker(false);
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const closeEditor = useCallback(() => {
    setEditingType(null);
    setEditingOrigName(null);
  }, []);

  // ── 保存 ──
  const handleSave = useCallback(async () => {
    const name = editingName.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (editingType === 'skill') {
        if (editingOrigName && editingOrigName !== name) {
          await api.renameSkill(editingOrigName, name, editingContent);
        } else {
          await api.saveSkill(name, editingContent);
        }
      } else if (editingType === 'prompt') {
        if (editingOrigName && editingOrigName !== name) {
          await api.renamePrompt(editingOrigName, name, editingContent);
        } else {
          await api.savePrompt(name, editingContent, editingIcon);
        }
        // 保存 icon（改名后也需要更新）
        if (editingOrigName !== name || editingIcon) {
          await api.updatePromptIcon(name, editingIcon);
        }
      }
      await refresh();
      closeEditor();
    } finally {
      setSaving(false);
    }
  }, [editingType, editingName, editingContent, editingIcon, editingOrigName, refresh, closeEditor]);

  // ── 删除：先弹确认框 ──
  const handleDelete = useCallback((type: 'skill' | 'prompt', name: string) => {
    setDeleteConfirm({ type, name });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const { type, name } = deleteConfirm;
    if (type === 'skill') await api.deleteSkill(name);
    else await api.deletePrompt(name);
    setDeleteConfirm(null);
    await refresh();
  }, [deleteConfirm, refresh]);

  if (!open) return null;

  // 编辑器模式
  if (editingType) {
    return (
      <div style={panelStyle}>
        <div style={editorWrapStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            {editingType === 'prompt' && (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowIconPicker(!showIconPicker)}
                  style={iconBtnStyle}
                  title="选择图标"
                >{editingIcon}</button>
                {showIconPicker && (
                  <div style={iconPickerStyle}>
                    {ICONS.map(ic => (
                      <button
                        key={ic}
                        onClick={() => { setEditingIcon(ic); setShowIconPicker(false); }}
                        style={{ ...iconOptionStyle, background: ic === editingIcon ? 'var(--theme-accent-bg)' : 'transparent' }}
                      >{ic}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <input
              ref={nameRef}
              value={editingName}
              onChange={e => setEditingName(e.target.value)}
              placeholder={editingType === 'skill' ? 'Skill 名称' : 'Prompt 名称'}
              style={nameInputStyle}
            />
            <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', textTransform: 'uppercase' }}>
              {editingType === 'skill' ? 'Skill' : 'Prompt'}
            </span>
          </div>
          {/* Backend Skill：后端选择下拉框（仅 Skill 类型显示） */}
          {editingType === 'skill' && backends.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>路由后端</span>
              <select
                value={parseSkillBackend(editingContent)}
                onChange={e => {
                  setEditingContent(prev => setSkillBackend(prev, e.target.value));
                }}
                style={backendSelectStyle}
              >
                <option value="">无 (传统 Skill)</option>
                {backends.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                {parseSkillBackend(editingContent) ? '🔗 Backend Skill' : '📋 指令型 Skill'}
              </span>
            </div>
          )}
          <textarea
            value={editingContent}
            onChange={e => setEditingContent(e.target.value)}
            placeholder={editingType === 'skill' ? '# Skill 内容 (SKILL.md 格式)\n---\ntrigger: ...\n---\n\n指令内容...' : '输入 Prompt 模板内容…'}
            style={contentTextareaStyle}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={closeEditor} style={cancelBtnStyle}>取消</button>
            <button onClick={handleSave} disabled={saving || !editingName.trim()} style={saveBtnStyle}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 卡片列表模式
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', gap: 24, flex: 1, overflow: 'hidden' }}>
        {/* ── 左：Skills ── */}
        <div style={{ ...columnStyle, borderRight: '1px solid var(--theme-border)', paddingRight: 24 }}>
          <div style={{ ...columnHeaderStyle, border: 'none', padding: 0 }}>
            <span>⚡ Skills</span>
            <button onClick={() => setShowSkillTypeSelector(true)} style={addBtnStyle} title="新建 Skill">＋</button>
          </div>
          <div style={cardGridStyle}>
            {skills.map(s => (
              <div key={s.id} className="repo-card" style={cardStyle} onClick={() => openEditor('skill', s)}>
                <div style={cardIconStyle}>{parseSkillBackend(s.content || '') ? '🔗' : '⚡'}</div>
                <div style={cardNameStyle}>{s.name}</div>
                <div className="repo-card-actions" style={cardActionsStyle}>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete('skill', s.name); }}
                    style={cardDelBtnStyle}
                    title="删除"
                  >×</button>
                </div>
              </div>
            ))}
            {skills.length === 0 && <div style={emptyStyle}>暂无 Skill</div>}
          </div>
        </div>

        {/* ── 右：Prompts ── */}
        <div style={{ ...columnStyle, paddingLeft: 24 }}>
          <div style={{ ...columnHeaderStyle, border: 'none', padding: 0 }}>
            <span>📝 Prompts</span>
            <button onClick={() => openEditor('prompt')} style={addBtnStyle} title="新建 Prompt">＋</button>
          </div>
          <div style={cardGridStyle}>
            {prompts.map(p => (
              <div key={p.id} className="repo-card" style={cardStyle} onClick={() => openEditor('prompt', p)}>
                <div style={cardIconStyle}>{p.icon || '📝'}</div>
                <div style={cardNameStyle}>{p.name}</div>
                <div className="repo-card-actions" style={cardActionsStyle}>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete('prompt', p.name); }}
                    style={cardDelBtnStyle}
                    title="删除"
                  >×</button>
                </div>
              </div>
            ))}
            {prompts.length === 0 && <div style={emptyStyle}>暂无 Prompt</div>}
          </div>
        </div>
      </div>

      {/* ── 新建 Skill 类型选择器 ── */}
      {showSkillTypeSelector && (
        <div style={deleteOverlayStyle} onClick={() => setShowSkillTypeSelector(false)}>
          <div style={{ ...deleteDialogStyle, width: 380 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
              新建 Skill
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* 系统增强型：根据可用 backend 显示 */}
              {SKILL_TYPE_PRESETS.map(preset => {
                const matchingBackends = backends.filter(b => b.type === preset.backendType);
                if (matchingBackends.length === 0) return null;
                return (
                  <div key={preset.id} style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: '1px solid var(--theme-border)', background: 'var(--theme-bg)',
                    transition: 'all 0.12s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 18 }}>{preset.icon}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>{preset.label}</span>
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' }}>系统增强</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 8 }}>{preset.description}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {matchingBackends.map(b => (
                        <button
                          key={b.id}
                          onClick={() => {
                            const { name, content } = preset.template(b.id);
                            setShowSkillTypeSelector(false);
                            openEditor('skill');
                            // 延迟设置，确保 editor 已打开
                            setTimeout(() => { setEditingName(name); setEditingContent(content); }, 0);
                          }}
                          style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
                            color: 'var(--theme-text)', transition: 'all 0.12s',
                          }}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {/* 自定义 Skill */}
              <div
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  border: '1px dashed var(--theme-border)', background: 'var(--theme-bg)',
                  transition: 'all 0.12s',
                }}
                onClick={() => { setShowSkillTypeSelector(false); openEditor('skill'); }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📋</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>自定义 Skill</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>自行编写 SKILL.md 指令内容</div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSkillTypeSelector(false)} style={cancelBtnStyle}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认对话框 */}
      {deleteConfirm && (
        <div style={deleteOverlayStyle} onClick={() => setDeleteConfirm(null)}>
          <div style={deleteDialogStyle} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
              确认删除
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: 13, color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>
              确定要删除 {deleteConfirm.type === 'skill' ? 'Skill' : 'Prompt'}{' '}
              <strong style={{ color: 'var(--theme-error, #cf222e)' }}>"{deleteConfirm.name}"</strong> 吗？
              <br />此操作不可撤销。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteConfirm(null)} style={deleteCancelBtnStyle}>取消</button>
              <button onClick={confirmDelete} style={deleteConfirmBtnStyle}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════
//  样式
// ═══════════════════════════════════════
const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '12px 16px',
  background: 'var(--theme-bg-secondary)',
  borderBottom: '1px solid var(--theme-border)',
  position: 'relative',
  overflow: 'hidden',
};

const columnStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const columnHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--theme-text)',
  marginBottom: 8,
  padding: '0 4px',
};

const cardGridStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  overflow: 'auto',
  maxHeight: 200,
  padding: '2px',
};

const cardStyle: React.CSSProperties = {
  width: 110,
  padding: '10px 8px 8px',
  borderRadius: 10,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  position: 'relative',
  transition: 'border-color 0.15s, transform 0.15s, box-shadow 0.15s',
};

const cardIconStyle: React.CSSProperties = {
  fontSize: 22,
  lineHeight: 1,
};

const cardNameStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--theme-text)',
  textAlign: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  width: '100%',
  fontWeight: 500,
};

const cardActionsStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  opacity: 0,
  transition: 'opacity 0.12s',
};

const cardDelBtnStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 4,
  border: 'none',
  background: 'rgba(239,68,68,0.15)',
  color: '#ef4444',
  fontSize: 12,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const addBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: '1px dashed var(--theme-border)',
  background: 'transparent',
  color: 'var(--theme-text-muted)',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s',
};

const closeBtnStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 4,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 32,
  height: 18,
  borderRadius: '0 0 8px 8px',
  border: '1px solid var(--theme-border)',
  borderTop: 'none',
  background: 'var(--theme-bg-secondary)',
  color: 'var(--theme-text-muted)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--theme-text-muted)',
  padding: '16px 0',
  textAlign: 'center',
  width: '100%',
};

// 编辑器样式
const editorWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 350,
};

const nameInputStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 14,
  fontWeight: 600,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  color: 'var(--theme-text)',
  padding: '6px 10px',
  outline: 'none',
  fontFamily: 'inherit',
};

const backendSelectStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  color: 'var(--theme-text)',
  padding: '4px 8px',
  outline: 'none',
  fontFamily: 'inherit',
};

const contentTextareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 180,
  fontSize: 13,
  lineHeight: 1.6,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 8,
  color: 'var(--theme-text)',
  padding: '10px 12px',
  outline: 'none',
  resize: 'none',
  fontFamily: 'monospace',
};

const saveBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 6,
  border: 'none',
  background: 'var(--theme-accent)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid var(--theme-border)',
  background: 'transparent',
  color: 'var(--theme-text-muted)',
  fontSize: 13,
  cursor: 'pointer',
};

const iconBtnStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg)',
  fontSize: 20,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const iconPickerStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 4,
  display: 'grid',
  gridTemplateColumns: 'repeat(8, 1fr)',
  gap: 2,
  padding: 6,
  background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  zIndex: 100,
};

const iconOptionStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 4,
  border: 'none',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const deleteOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 2000,
};

const deleteDialogStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 10,
  padding: '20px 24px',
  width: 320,
  boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
};

const deleteCancelBtnStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  background: 'transparent',
  color: 'var(--theme-text)', fontSize: 13, cursor: 'pointer',
};

const deleteConfirmBtnStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 6,
  border: 'none',
  background: 'var(--theme-error, #cf222e)',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};

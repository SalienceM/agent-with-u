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
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [sk, pr] = await Promise.all([
      api.listSkills(workingDir),
      api.listPrompts(),
    ]);
    setSkills(sk || []);
    setPrompts(pr || []);
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
      setEditingContent('');
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

  // ── 删除 ──
  const handleDelete = useCallback(async (type: 'skill' | 'prompt', name: string) => {
    if (type === 'skill') await api.deleteSkill(name);
    else await api.deletePrompt(name);
    await refresh();
  }, [refresh]);

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
            <button onClick={() => openEditor('skill')} style={addBtnStyle} title="新建 Skill">＋</button>
          </div>
          <div style={cardGridStyle}>
            {skills.map(s => (
              <div key={s.id} className="repo-card" style={cardStyle} onClick={() => openEditor('skill', s)}>
                <div style={cardIconStyle}>⚡</div>
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

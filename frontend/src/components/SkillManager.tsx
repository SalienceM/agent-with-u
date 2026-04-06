import React, { useState, useCallback, useEffect, useRef } from 'react';
import { api, SkillInfo } from '../api';

interface SkillManagerProps {
  isOpen: boolean;
  onClose: () => void;
  workingDir?: string;   // 当前 session 的工作目录，用于项目级激活
}

const DEFAULT_SKILL_CONTENT = (name: string) => `---
name: ${name}
description: Describe what this skill does and when Claude should use it (max 250 chars)
---

## Instructions

Write step-by-step instructions for Claude here.
`;

// ── 解析 SKILL.md 的 description 字段用于展示 ──────────────────
function parseDescription(content: string): string {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return '';
  const desc = m[1].match(/description:\s*(.+)/);
  return desc ? desc[1].trim().replace(/^["']|["']$/g, '') : '';
}

export const SkillManager: React.FC<SkillManagerProps> = ({ isOpen, onClose, workingDir = '' }) => {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'list' | 'edit'>('list');
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // ── 插件包安装 ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [installing, setInstalling] = useState(false);
  // ── Secrets 配置 ──
  const [secretsSkill, setSecretsSkill] = useState<string | null>(null);
  const [secretsSchema, setSecretsSchema] = useState<{ fields: Array<{ key: string; label: string; type: string; required?: boolean; placeholder?: string }> } | null>(null);
  const [secretsValues, setSecretsValues] = useState<Record<string, string>>({});
  const [secretsPresence, setSecretsPresence] = useState<string[]>([]);
  const [savingSecrets, setSavingSecrets] = useState(false);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  // ── 加载列表 ────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listSkills(workingDir);
      setSkills(list);
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  useEffect(() => {
    if (isOpen) reload();
  }, [isOpen, reload]);

  // ── 激活/停用 ─────────────────────────────────────────────
  const toggleActivation = useCallback(async (name: string, scope: 'global' | 'project', current: boolean) => {
    if (scope === 'project' && !workingDir) return;
    const fn = current ? api.deactivateSkill : api.activateSkill;
    const res = await fn(name, scope, workingDir);
    if (!res) { showMsg('err', '无法连接到后端'); return; }
    if (res.status === 'ok') {
      await reload();
    } else {
      showMsg('err', res.message || '操作失败');
    }
  }, [workingDir, reload]);

  // ── 打开编辑器 ────────────────────────────────────────────
  const openEdit = useCallback((skill?: SkillInfo) => {
    if (skill) {
      setEditName(skill.name);
      setNameInput(skill.name);
      setEditContent(skill.content);
    } else {
      setEditName('');
      setNameInput('');
      setEditContent('');
    }
    setView('edit');
  }, []);

  // ── 保存 ──────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const name = nameInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!name) { showMsg('err', 'Skill 名称不能为空'); return; }
    const content = editContent || DEFAULT_SKILL_CONTENT(name);
    setSaving(true);
    try {
      let res;
      if (editName && editName !== name) {
        // 重命名
        res = await api.renameSkill(editName, name, content);
      } else {
        res = await api.saveSkill(name, content);
      }
      if (!res) { showMsg('err', '保存失败：无法连接到后端'); return; }
      if (res.status === 'ok') {
        showMsg('ok', '已保存');
        await reload();
        setView('list');
      } else {
        showMsg('err', `保存失败：${res.message || '未知错误'}`);
      }
    } finally {
      setSaving(false);
    }
  }, [nameInput, editContent, editName, reload]);

  // ── 删除 ──────────────────────────────────────────────────
  const handleDelete = useCallback(async (name: string) => {
    const res = await api.deleteSkill(name);
    if (!res) { showMsg('err', '删除失败：无法连接到后端'); return; }
    if (res.status === 'ok') {
      showMsg('ok', '已删除');
      setConfirmDelete(null);
      await reload();
    } else {
      showMsg('err', res.message || '删除失败');
    }
  }, [reload]);

  // ── 安装插件包 ──────────────────────────────────────────────
  const handleInstallFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 将文件路径传给后端（Qt 环境下 file.path 是本地路径；浏览器中用 URL.createObjectURL 不行，
    // 但 Qt WebEngine 支持通过 webkitRelativePath 或直接文件系统路径）
    const filePath: string = (file as any).path || (file as any).webkitRelativePath || file.name;
    setInstalling(true);
    try {
      const res = await api.installSkillPackage(filePath);
      if (res.status === 'ok') {
        const m = res.manifest;
        showMsg('ok', `已安装插件 ${m?.name || m?.id} v${m?.version || '?'}`);
        await reload();
        // 若有 secrets.schema.json，立即引导配置
        if (m?.id) {
          const schema = await api.getSkillSecretsSchema(m.id);
          if (schema?.fields?.length) {
            setSecretsSkill(m.id);
            setSecretsSchema(schema);
            setSecretsValues({});
            setSecretsPresence([]);
          }
        }
      } else {
        showMsg('err', `安装失败：${res.message || '未知错误'}`);
      }
    } finally {
      setInstalling(false);
      // 清空 input 以便重复安装同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [reload]);

  // ── 打开 Secrets 配置 ────────────────────────────────────────
  const openSecretsDialog = useCallback(async (skillName: string) => {
    const [schema, presence] = await Promise.all([
      api.getSkillSecretsSchema(skillName),
      api.getSkillSecretsPresence(skillName),
    ]);
    if (!schema?.fields?.length) {
      showMsg('err', '该 Skill 没有 secrets.schema.json');
      return;
    }
    setSecretsSkill(skillName);
    setSecretsSchema(schema);
    setSecretsValues({});     // 不回显已有值（密码安全）
    setSecretsPresence(presence);
  }, []);

  const handleSaveSecrets = useCallback(async () => {
    if (!secretsSkill) return;
    setSavingSecrets(true);
    try {
      const res = await api.setSkillSecrets(secretsSkill, secretsValues);
      if (res.status === 'ok') {
        showMsg('ok', '凭据已安全保存到本地（不传给大模型）');
        setSecretsSkill(null);
        await reload();
      } else {
        showMsg('err', res.message || '保存失败');
      }
    } finally {
      setSavingSecrets(false);
    }
  }, [secretsSkill, secretsValues, reload]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>

        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {view === 'edit' && (
              <button onClick={() => setView('list')} style={backBtnStyle}>←</button>
            )}
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: 'var(--theme-text)' }}>
              {view === 'list' ? '⚡ Skill 库' : (editName ? `编辑：${editName}` : '新建 Skill')}
            </h2>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* 工作目录提示 */}
        {workingDir && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 12,
            background: 'rgba(99,102,241,0.08)', borderRadius: 6, padding: '5px 10px' }}>
            📁 当前目录：<code style={{ fontSize: 10 }}>{workingDir}</code>
          </div>
        )}

        {msg && (
          <div style={{
            fontSize: 12, padding: '6px 12px', borderRadius: 6, marginBottom: 12,
            background: msg.type === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            color: msg.type === 'ok' ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)',
          }}>
            {msg.text}
          </div>
        )}

        {/* ── 列表视图 ── */}
        {view === 'list' && (
          <>
            {loading ? (
              <div style={{ textAlign: 'center', color: 'var(--theme-text-muted)', padding: 24, fontSize: 13 }}>
                加载中...
              </div>
            ) : skills.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--theme-text-muted)', padding: 24, fontSize: 13 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
                孵化库为空，点击下方新建第一个 Skill
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {skills.map(skill => (
                  <SkillRow
                    key={skill.name}
                    skill={skill}
                    workingDir={workingDir}
                    onEdit={() => openEdit(skill)}
                    onToggle={toggleActivation}
                    onDeleteClick={() => setConfirmDelete(skill.name)}
                    onSecretsClick={() => openSecretsDialog(skill.name)}
                  />
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => openEdit()} style={{ ...addBtnStyle, flex: 1 }}>
                + 新建 Skill
              </button>
              {/* 安装插件包 */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={installing}
                title="从本地 .awu 文件安装插件 Skill"
                style={{
                  ...addBtnStyle, flex: 'none', padding: '11px 16px',
                  background: 'rgba(34,197,94,0.1)', borderColor: 'rgba(34,197,94,0.3)',
                  color: 'rgba(34,197,94,0.9)',
                }}
              >
                {installing ? '安装中…' : '📦 安装包'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".awu,.zip"
                style={{ display: 'none' }}
                onChange={handleInstallFile}
              />
            </div>

            {/* 说明 */}
            <div style={{ marginTop: 14, fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.7,
              borderTop: '1px solid var(--theme-border)', paddingTop: 12 }}>
              <strong style={{ color: 'var(--theme-text)' }}>🌐 全局</strong>：激活后对所有 session 生效（~/.claude/skills/）<br />
              <strong style={{ color: 'var(--theme-text)' }}>📁 此项目</strong>：仅当前目录的 session 生效（.claude/skills/），可提交进 Git<br />
              <strong style={{ color: 'var(--theme-text)' }}>📦 安装包</strong>：从 .awu 文件安装插件 Skill（格式：zip，含 manifest.json + SKILL.md）
            </div>
          </>
        )}

        {/* ── 编辑视图 ── */}
        {view === 'edit' && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Skill 名称（用作 /slash-command，小写+连字符）</label>
              <input
                type="text"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                style={inputStyle}
                placeholder="e.g., take-screenshot"
                spellCheck={false}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>SKILL.md 内容（YAML frontmatter + Markdown 指令）</label>
              <textarea
                value={editContent || DEFAULT_SKILL_CONTENT(nameInput || 'skill-name')}
                onChange={e => setEditContent(e.target.value)}
                style={{ ...inputStyle, height: 300, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                spellCheck={false}
              />
              <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 4 }}>
                <code>description</code> 字段控制 Claude 何时自动调用此 Skill（最多 250 字符）
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSave} disabled={saving} style={saveBtnStyle}>
                {saving ? '保存中...' : '保存到孵化库'}
              </button>
              <button onClick={() => setView('list')} style={cancelBtnStyle}>取消</button>
            </div>
          </>
        )}

        {/* ── 删除确认 ── */}
        {confirmDelete && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 340 }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--theme-text)' }}>确认删除</h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 8px' }}>
                删除 <strong style={{ color: 'rgba(239,68,68,0.9)' }}>{confirmDelete}</strong>？
              </p>
              <p style={{ fontSize: 12, color: 'var(--theme-text-muted)', margin: '0 0 16px' }}>
                将同步撤销所有已激活位置的 SKILL.md。
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleDelete(confirmDelete!)} style={{ ...saveBtnStyle, background: 'rgba(239,68,68,0.7)', flex: 1 }}>
                  删除
                </button>
                <button onClick={() => setConfirmDelete(null)} style={cancelBtnStyle}>取消</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Secrets 配置对话框 ── */}
        {secretsSkill && secretsSchema && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 420 }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--theme-text)' }}>
                🔑 配置凭据：{secretsSkill}
              </h3>
              <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 16px', lineHeight: 1.6 }}>
                凭据保存在本地 <code>~/.agent-with-u/skill-secrets/</code>（chmod 600），<br />
                <strong>永不传给大模型</strong>，Skill 执行时通过环境变量注入。
              </p>
              {secretsPresence.length > 0 && (
                <div style={{ fontSize: 11, color: 'rgba(34,197,94,0.8)', marginBottom: 12,
                  background: 'rgba(34,197,94,0.08)', padding: '5px 10px', borderRadius: 6 }}>
                  已配置字段：{secretsPresence.join(', ')}（留空则保留原值）
                </div>
              )}
              {secretsSchema.fields.map(field => (
                <div key={field.key} style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>
                    {field.label}
                    {field.required && <span style={{ color: 'rgba(239,68,68,0.8)', marginLeft: 3 }}>*</span>}
                  </label>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={secretsValues[field.key] ?? ''}
                      onChange={e => setSecretsValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder || (secretsPresence.includes(field.key) ? '（留空保留原值）' : '')}
                      style={{ ...inputStyle, height: 80, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                    />
                  ) : (
                    <input
                      type={field.type === 'password' ? 'password' : 'text'}
                      value={secretsValues[field.key] ?? ''}
                      onChange={e => setSecretsValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder || (secretsPresence.includes(field.key) ? '（留空保留原值）' : '')}
                      style={inputStyle}
                      autoComplete="off"
                    />
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={handleSaveSecrets} disabled={savingSecrets} style={saveBtnStyle}>
                  {savingSecrets ? '保存中…' : '保存凭据'}
                </button>
                <button onClick={() => setSecretsSkill(null)} style={cancelBtnStyle}>取消</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── SkillRow 子组件 ────────────────────────────────────────────────────────
const SkillRow: React.FC<{
  skill: SkillInfo;
  workingDir: string;
  onEdit: () => void;
  onToggle: (name: string, scope: 'global' | 'project', current: boolean) => void;
  onDeleteClick: () => void;
  onSecretsClick?: () => void;
}> = ({ skill, workingDir, onEdit, onToggle, onDeleteClick, onSecretsClick }) => {
  const desc = parseDescription(skill.content);
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onEdit}>
        <div style={{ fontWeight: 500, color: 'var(--theme-text)', fontSize: 13, marginBottom: 2 }}>
          /{skill.name}
        </div>
        {desc && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {desc}
          </div>
        )}
      </div>

      {/* 激活开关区 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        {/* 全局 */}
        <ToggleChip
          label="全局"
          active={skill.isGlobal}
          onClick={() => onToggle(skill.name, 'global', skill.isGlobal)}
          title={skill.isGlobal ? '已全局激活，点击停用' : '点击全局激活（~/.claude/skills/）'}
        />
        {/* 项目级 */}
        {workingDir && (
          <ToggleChip
            label="此项目"
            active={skill.isProject}
            onClick={() => onToggle(skill.name, 'project', skill.isProject)}
            title={skill.isProject ? '已在此项目激活，点击停用' : '点击为此项目激活（.claude/skills/）'}
          />
        )}
        {/* 凭据 */}
        {skill.hasSecretsSchema && (
          <button
            onClick={e => { e.stopPropagation(); onSecretsClick?.(); }}
            style={{ background: 'none', border: 'none',
              color: skill.hasSecrets ? 'rgba(234,197,95,0.8)' : 'rgba(255,255,255,0.3)',
              cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1 }}
            title={skill.hasSecrets ? '已配置凭据，点击修改' : '点击配置凭据'}
          >
            🔑
          </button>
        )}
        {/* 删除 */}
        <button
          onClick={e => { e.stopPropagation(); onDeleteClick(); }}
          style={{ background: 'none', border: 'none', color: 'rgba(239,68,68,0.5)',
            cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1 }}
          title="删除"
        >
          🗑
        </button>
      </div>
    </div>
  );
};

const ToggleChip: React.FC<{
  label: string; active: boolean; onClick: () => void; title: string;
}> = ({ label, active, onClick, title }) => (
  <button
    onClick={e => { e.stopPropagation(); onClick(); }}
    title={title}
    style={{
      fontSize: 10, padding: '2px 7px', borderRadius: 10, cursor: 'pointer',
      border: `1px solid ${active ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.15)'}`,
      background: active ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
      color: active ? 'rgba(34,197,94,0.9)' : 'var(--theme-text-muted)',
      fontWeight: active ? 600 : 400, transition: 'all 0.15s',
    }}
  >
    {active ? '✓ ' : ''}{label}
  </button>
);

/* ── styles ── */
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
  borderRadius: 12, padding: 24, width: '90%', maxWidth: 560,
  maxHeight: '85vh', overflowY: 'auto',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px',
};
const backBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 18, cursor: 'pointer', padding: '2px 6px',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 12px', marginBottom: 6,
  background: 'rgba(255,255,255,0.04)', borderRadius: 8,
};
const addBtnStyle: React.CSSProperties = {
  width: '100%', padding: 11, borderRadius: 8,
  background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)',
  color: 'rgba(165,168,255,0.9)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--theme-text)', display: 'block', marginBottom: 6,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px',
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, color: 'var(--theme-text)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
};
const saveBtnStyle: React.CSSProperties = {
  flex: 1, padding: '9px 16px', borderRadius: 7,
  background: 'rgba(99,102,241,0.4)', border: '1px solid rgba(99,102,241,0.5)',
  color: 'rgba(200,201,255,0.95)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
const cancelBtnStyle: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 7,
  background: 'transparent', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text-muted)', fontSize: 13, cursor: 'pointer',
};

import React, { useEffect, useState, useCallback, memo, useRef } from 'react';
import { api } from '../api';

interface Session {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  workingDir: string;
  backendId: string;
  abilities?: { skills: string[]; prompts: string[] };
}

interface Backend {
  id: string;
  label: string;
  type: string;
}

interface Props {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession?: (id: string) => void;
  onAcknowledgeSession?: (id: string) => void; // ★ 用户明确确认后才消除通知
  streamingSessions: Set<string>;
  completedSessions?: Set<string>;  // ★ 后台完成待查看的 session
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

// ★ Wrap with React.memo to prevent unnecessary re-renders when parent updates
export const Sidebar: React.FC<Props> = memo(({ activeSessionId, onSelectSession, onNewSession, onDeleteSession, onAcknowledgeSession, streamingSessions, completedSessions = new Set(), collapsed, onToggleCollapse }) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [backends, setBackends] = useState<Backend[]>([]);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  const [abilityPickerSession, setAbilityPickerSession] = useState<Session | null>(null);
  const [availablePrompts, setAvailablePrompts] = useState<any[]>([]);
  const [availableSkills, setAvailableSkills] = useState<any[]>([]);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ★ Memoize refresh function to avoid re-creating it on every render
  const refresh = useCallback(async () => {
    const sessionList = await api.listSessions();
    sessionList.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setSessions(sessionList);
  }, []);

  // ★ 能力绑定
  const openAbilityPicker = useCallback(async (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setAbilityPickerSession(session);
    const [sk, pr] = await Promise.all([api.listSkills(session.workingDir || ''), api.listPrompts()]);
    setAvailableSkills(sk || []);
    setAvailablePrompts(pr || []);
  }, [api]);

  // ★ 删除技能/提示确认
  const [itemToDelete, setItemToDelete] = useState<{ type: 'skills' | 'prompts', name: string } | null>(null);

  const confirmDeleteItem = useCallback(async () => {
    if (!itemToDelete || !abilityPickerSession) return;
    const { type, name } = itemToDelete;
    const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
    const list = [...(current[type] || [])];
    const idx = list.indexOf(name);
    if (idx >= 0) {
      list.splice(idx, 1);
      const newAbilities = { ...current, [type]: list };
      await api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
      setAbilityPickerSession({ ...abilityPickerSession, abilities: newAbilities });
    }
    setItemToDelete(null);
  }, [itemToDelete, abilityPickerSession]);

  // ★ 预览内容状态
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // ★ 临时约束本地 state，避免每次 onChange 触发异步 API 导致 IME 组合被打断
  const [constraintsValue, setConstraintsValue] = useState('');

  // 打开 picker 时同步 constraints 到本地 state
  useEffect(() => {
    if (abilityPickerSession) {
      setConstraintsValue((abilityPickerSession.abilities as any)?.constraints || '');
    }
  }, [abilityPickerSession?.id]);

  // ★ 显示 Skill 预览
  const show_preview_skill = useCallback(async (skill: any) => {
    setPreviewContent(skill.content || '');
  }, []);

  // ★ 显示 Prompt 预览
  const show_preview_prompt = useCallback(async (prompt: any) => {
    setPreviewContent(prompt.content || '');
  }, []);

  const toggleAbility = useCallback(async (type: 'skills' | 'prompts', name: string) => {
    if (!abilityPickerSession) return;
    const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
    const list = [...(current[type] || [])];
    const idx = list.indexOf(name);
    if (idx >= 0) list.splice(idx, 1); else list.push(name);
    const newAbilities = { ...current, [type]: list };
    await api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
    setAbilityPickerSession({ ...abilityPickerSession, abilities: newAbilities });
    refresh();
  }, [abilityPickerSession, refresh]);

  useEffect(() => {
    api.getBackends().then(setBackends);
    refresh();
  }, [refresh]);

  const renamingRef = useRef(false);  // 防止 Enter+blur 双触发
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleRenameStart = useCallback((s: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    renamingRef.current = false;
    setRenamingSessionId(s.id);
    setRenameValue(s.title);
    setTimeout(() => { renameInputRef.current?.select(); }, 0);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renamingSessionId || renamingRef.current) return;
    renamingRef.current = true;
    const title = renameValue.trim();
    setRenamingSessionId(null);
    if (!title) return;
    await api.renameSession(renamingSessionId, title);
    refresh();
    renamingRef.current = false;
  }, [renamingSessionId, renameValue, refresh]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleRenameConfirm(); }
    if (e.key === 'Escape') setRenamingSessionId(null);
    e.stopPropagation();
  }, [handleRenameConfirm]);

  const handleDeleteClick = useCallback((session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    // ★ Check if session is streaming
    if (streamingSessions.has(session.id)) {
      alert(`会话 "${session.title}" 正在进行中，无法删除。请等待完成或停止后再试。`);
      return;
    }
    setSessionToDelete(session);
  }, [streamingSessions]);

  const confirmDelete = useCallback(() => {
    if (sessionToDelete) {
      const deletedId = sessionToDelete.id;
      api.deleteSession(deletedId).then(() => {
        refresh();
        onDeleteSession?.(deletedId);
      });
      setSessionToDelete(null);
    }
  }, [sessionToDelete, refresh, onDeleteSession]);

  // ★ Listen for session-created event to refresh list
  useEffect(() => {
    const handleSessionCreated = () => refresh();
    window.addEventListener('session-created', handleSessionCreated);
    return () => window.removeEventListener('session-created', handleSessionCreated);
  }, [refresh]);

  // ★ 约束输入框聚焦 ref
  const constraintsRef = useRef<HTMLTextAreaElement>(null);
  const [showConstraintsInput, setShowConstraintsInput] = useState(false);

  // ★ Expose refresh to parent via custom event or ref if needed
  // For now, refresh when window gains focus (user might have created session elsewhere)
  useEffect(() => {
    const handleFocus = () => refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  const getBackendShortLabel = useCallback((backendId: string) => {
    const backend = backends.find((b) => b.id === backendId);
    if (!backend) return backendId;
    const label = backend.label;
    if (label.includes('Sonnet')) return 'Sonnet';
    if (label.includes('Opus')) return 'Opus';
    if (label.includes('Haiku')) return 'Haiku';
    if (label.includes('GPT')) return 'GPT';
    return label.split(' ')[0];
  }, [backends]);

  const formatWorkingDir = useCallback((dir: string): string => {
    if (!dir) return 'Not set';
    if (dir === '.') return '(current dir)';
    // Show last 2-3 segments of the path
    const parts = dir.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return dir;
    return '.../' + parts.slice(-3).join('/');
  }, []);

  const pendingCount = completedSessions.size;

  // ★ 折叠状态：只显示窄条 + 展开按钮，有未确认通知时显示角标
  if (collapsed) {
    return (
      <div style={collapsedSidebarStyle}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button
            onClick={onToggleCollapse}
            style={toggleBtnStyle}
            title="展开侧栏"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          {pendingCount > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4,
              minWidth: 14, height: 14, borderRadius: 7,
              background: '#ef4444', color: '#fff',
              fontSize: 9, fontWeight: 700, lineHeight: '14px',
              textAlign: 'center', padding: '0 3px',
              pointerEvents: 'none',
            }}>
              {pendingCount > 9 ? '9+' : pendingCount}
            </span>
          )}
        </div>
        <button onClick={onNewSession} style={{ ...toggleBtnStyle, marginTop: 4 }} title="New session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div style={sidebarStyle}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.25); }
        }
        @keyframes badgePulse {
          0%, 100% { transform: scale(1);    opacity: 1; }
          50%       { transform: scale(1.15); opacity: 0.82; }
        }
        @keyframes dialogSlideIn {
          from { opacity: 0; transform: perspective(900px) rotateX(-14deg) scale(0.96) translateY(-8px); }
          to   { opacity: 1; transform: perspective(900px) rotateX(0deg)   scale(1)    translateY(0); }
        }
        @keyframes streamBorderFlow {
          from { transform: translateY(-66%); }
          to   { transform: translateY(66%); }
        }
        .session-streaming-item {
          border-left: 3px solid transparent !important;
          background-clip: padding-box;
          position: relative;
          overflow: hidden;
        }
        .session-streaming-item::before {
          content: '';
          position: absolute;
          left: 0; top: -100%; bottom: -100%;
          width: 3px;
          border-radius: 3px 0 0 3px;
          background: linear-gradient(180deg, transparent, #22c55e 30%, #7aa2f7 70%, transparent);
          will-change: transform;
          animation: streamBorderFlow 1.6s linear infinite;
        }
        .session-notify-badge {
          position: absolute;
          top: -5px;
          right: -5px;
          min-width: 16px;
          height: 16px;
          border-radius: 8px;
          background: #ef4444;
          color: #fff;
          font-size: 9px;
          font-weight: 700;
          line-height: 16px;
          text-align: center;
          padding: 0 4px;
          cursor: pointer;
          animation: badgePulse 1.8s ease-in-out infinite;
          border: 1.5px solid var(--theme-bg, #1a1a2e);
          z-index: 10;
          transition: background 0.15s, transform 0.1s;
          user-select: none;
        }
        .session-notify-badge:hover {
          background: #dc2626;
          transform: scale(1.2) !important;
          animation: none;
        }
        .session-notify-badge-wrap {
          position: absolute;
          top: 0; right: 0; bottom: 0; left: 0;
          pointer-events: none;
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 12px 8px' }}>
        <button
          onClick={onToggleCollapse}
          style={{ ...toggleBtnStyle, marginRight: 6 }}
          title="收起侧栏"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text-muted, rgba(255,255,255,0.5))', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Sessions
        </span>
        <button onClick={onNewSession} style={newBtnStyle} title="New session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px' }}>
        {sessions.map((s: any) => {
          const isRunning = streamingSessions.has(s.id);
          const isCompleted = !isRunning && completedSessions.has(s.id);
          const isActive = s.id === activeSessionId;

          return (
          <div
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            onMouseEnter={() => setHoveredSessionId(s.id)}
            onMouseLeave={() => setHoveredSessionId(null)}
            className={isRunning ? 'session-streaming-item' : undefined}
            style={{
              ...itemStyle,
              ...(isActive ? { background: 'var(--theme-accent-bg, #7aa2f726)' } : {}),
              ...(hoveredSessionId === s.id && !isActive ? { background: 'var(--theme-bg-tertiary, #242536)' } : {}),
              ...(isRunning   ? { border: '1px solid #22c55e33' } : {}),
              ...(isCompleted ? { border: '1px solid #ef444455', borderLeft: '3px solid #ef4444' } : {}),
            }}
          >
            {/* ★ Running indicator — 绿点 */}
            {isRunning && (
              <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', animation: 'pulse 1.5s infinite' }} />
              </div>
            )}

            {/* ★ Completed indicator — 右上角红点角标，点击才确认消除 */}
            {isCompleted && (
              <span
                className="session-notify-badge"
                title="点击确认已查看"
                onClick={(e) => {
                  e.stopPropagation();
                  onAcknowledgeSession?.(s.id);
                }}
              >
                !
              </span>
            )}

            {/* ★ Working directory is PRIMARY - shown first and prominently */}
            <div style={{ fontSize: 11, color: 'var(--theme-success, #2da44e)', fontFamily: 'monospace', marginBottom: 4, paddingLeft: isRunning ? 18 : 0 }}>
              📁 {formatWorkingDir(s.workingDir)}
            </div>
            {renamingSessionId === s.id ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameConfirm}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                style={renameInputStyle}
              />
            ) : (
              <div style={{ fontSize: 13, color: isActive ? 'var(--theme-accent, #7aa2f7)' : 'var(--theme-text, #e2e3ea)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 68 }}>
                {s.title}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 10, color: 'var(--theme-text-muted, #656d76)' }}>
                {s.messageCount} msgs
              </span>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {/* Backend name badge */}
                <span
                  style={{
                    ...backendBadgeStyle,
                    background: getBackendBadgeColor(s.backendId),
                  }}
                  title={getBackendShortLabel(s.backendId)}
                >
                  {getBackendShortLabel(s.backendId)}
                </span>
              </div>
            </div>
            {/* ★ Hover action buttons: rename | constraints | delete */}
            <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 2, opacity: hoveredSessionId === s.id ? 1 : 0, transition: 'opacity 0.15s', zIndex: 5 }}>
              <button
                onClick={(e) => handleRenameStart(s, e)}
                style={actionBtnStyle}
                title="重命名"
              >
                ✎
              </button>
              <button
                onClick={(e) => openAbilityPicker(s, e)}
                style={actionBtnStyle}
                title="绑定能力"
              >
                🧩
              </button>
              <button
                onClick={(e) => handleDeleteClick(s, e)}
                style={actionBtnStyle}
                title="Delete"
                disabled={isRunning}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
        {sessions.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--theme-text-muted, #656d76)', fontSize: 13, padding: 20 }}>
            No sessions yet
          </div>
        )}
      </div>

      {/* 能力绑定面板 */}
      {abilityPickerSession && (
        <div ref={pickerRef} style={overlayStyle} onClick={() => setAbilityPickerSession(null)}>
          <div style={{
            ...confirmPanelStyle,
            maxWidth: 720,
            width: '90%',
            height: '80vh',
            display: 'flex',
            flexDirection: 'column',
            animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)'
          }} onClick={(e) => e.stopPropagation()}>
            {/* 头部：显示会话名称和关闭按钮 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
                编辑会话
                <span style={{ marginLeft: 6, color: 'var(--theme-accent)', fontSize: 13, fontWeight: 500 }}>"{abilityPickerSession.title}"</span>
              </span>
              <button onClick={() => setAbilityPickerSession(null)} style={{
                fontSize: 14, padding: '2px 6px', borderRadius: 4,
                border: '1px solid var(--theme-border)', background: 'transparent',
                color: 'var(--theme-text-muted)', cursor: 'pointer', width: 24, height: 24,
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                ✕
              </button>
            </div>

            {/* 主体内容：上下布局 */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
              {/* 上方：Skills 和 Prompts 左右分栏 - 占 45% */}
              <div style={{ flex: '0 0 45%', display: 'flex', gap: 16, minHeight: 0 }}>
                {/* Skills 列 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6, textTransform: 'uppercase' }}>⚡ Skills</div>
                  <div style={{
                    flex: 1, overflowY: 'auto', border: '1px solid var(--theme-border)',
                    borderRadius: 8, overflow: 'hidden', padding: '4px'
                  }}>
                    {availableSkills.length > 0 ? (
                      availableSkills.map((sk: any) => {
                        const bound = (abilityPickerSession.abilities?.skills || []).includes(sk.name);
                        return (
                          <div
                            key={sk.id}
                            onClick={(e) => { e.stopPropagation(); toggleAbility('skills', sk.name); }}
                            style={{
                              padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                              background: bound ? 'var(--theme-accent-bg, rgba(122,162,247,0.08))' : 'transparent',
                              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.04))',
                            }}
                          >
                            <div style={{
                              width: 14, height: 14, borderRadius: 3, borderWidth: 2, borderStyle: 'solid',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: bound ? 'var(--theme-accent)' : 'transparent',
                              borderColor: bound ? 'var(--theme-accent)' : 'var(--theme-border)',
                            }}>
                              {bound && <div style={{ width: 6, height: 6, background: '#fff', borderRadius: 1 }} />}
                            </div>
                            <span style={{ flex: 1, fontSize: 12, color: 'var(--theme-text)' }}>{sk.name}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); show_preview_skill(sk); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                              >
                                预览
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setItemToDelete({ type: 'skills', name: sk.name }); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer' }}
                                title="取消绑定"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: 12, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
                        暂无 Skills，请先在 Repo 中创建
                      </div>
                    )}
                  </div>
                </div>

                {/* Prompts 列 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6, textTransform: 'uppercase' }}>📝 Prompts</div>
                  <div style={{
                    flex: 1, overflowY: 'auto', border: '1px solid var(--theme-border)',
                    borderRadius: 8, overflow: 'hidden', padding: '4px'
                  }}>
                    {availablePrompts.length > 0 ? (
                      availablePrompts.map((p: any) => {
                        const bound = (abilityPickerSession.abilities?.prompts || []).includes(p.name);
                        return (
                          <div
                            key={p.id}
                            onClick={(e) => { e.stopPropagation(); toggleAbility('prompts', p.name); }}
                            style={{
                              padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                              background: bound ? 'var(--theme-accent-bg, rgba(122,162,247,0.08))' : 'transparent',
                              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.04))',
                            }}
                          >
                            <div style={{
                              width: 14, height: 14, borderRadius: 3, borderWidth: 2, borderStyle: 'solid',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: bound ? 'var(--theme-accent)' : 'transparent',
                              borderColor: bound ? 'var(--theme-accent)' : 'var(--theme-border)',
                            }}>
                              {bound && <div style={{ width: 6, height: 6, background: '#fff', borderRadius: 1 }} />}
                            </div>
                            <span style={{ flex: 1, fontSize: 12, color: 'var(--theme-text)' }}>{p.icon || '📝'} {p.name}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); show_preview_prompt(p); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                              >
                                预览
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setItemToDelete({ type: 'prompts', name: p.name }); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer' }}
                                title="取消绑定"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: 12, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
                        暂无 Prompts，请先在 Repo 中创建
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 下方：临时 Session 级约束 - 占 45% */}
              <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6 }}>
                  临时约束/rule
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 400, color: 'var(--theme-text-muted)', background: 'var(--theme-accent-bg)', padding: '2px 8px', borderRadius: 4 }}>
                    Session 级临时生效
                  </span>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={constraintsValue}
                    onChange={(e) => setConstraintsValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="输入临时约束规则（仅本次会话有效）..."
                    style={{
                      flex: 1, fontSize: 12, resize: 'none',
                      background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                      borderRadius: 8, padding: '10px 12px', color: 'var(--theme-text)',
                      fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', minHeight: 160,
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
                    <button
                      onClick={() => setConstraintsValue('')}
                      style={{ fontSize: 11, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                    >
                      清空约束
                    </button>
                    <button
                      onClick={() => {
                        const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
                        const newAbilities = { ...current, constraints: constraintsValue };
                        api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
                        setAbilityPickerSession(null);
                      }}
                      style={{ ...confirmBtnStyle, fontSize: 12, padding: '6px 16px' }}
                    >
                      保存并关闭
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 预览对话框 */}
            {previewContent && (
              <div style={overlayStyle} onClick={() => setPreviewContent(null)}>
                <div style={{ ...confirmPanelStyle, maxWidth: 520, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--theme-border)' }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>预览内容</h3>
                    <button onClick={() => setPreviewContent(null)} style={{
                      fontSize: 14, padding: '2px 6px', borderRadius: 4,
                      border: '1px solid var(--theme-border)', background: 'transparent',
                      color: 'var(--theme-text-muted)', cursor: 'pointer', width: 24, height: 24
                    }}>
                      ✕
                    </button>
                  </div>
                  <div style={{ background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: 12, maxHeight: 400, overflowY: 'auto' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text)' }}>
                      {previewContent}
                    </pre>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                    <button onClick={() => setPreviewContent(null)} style={confirmBtnStyle}>关闭</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 删除确认对话框 */}
      {sessionToDelete && (
        <div style={overlayStyle}>
          <div style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              确认删除会话
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              确定要删除会话 <strong style={{ color: 'var(--theme-error, #cf222e)' }}>{sessionToDelete.title}</strong> 吗？
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              此操作不可撤销，将删除 {sessionToDelete.messageCount} 条消息。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmDelete} style={confirmBtnStyle}>
                删除
              </button>
              <button onClick={() => setSessionToDelete(null)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除技能/提示确认对话框 */}
      {itemToDelete && (
        <div style={overlayStyle}>
          <div style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              确认取消绑定
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              确定要取消绑定 <strong style={{ color: 'var(--theme-error, #cf222e)' }}>{itemToDelete.name}</strong> 吗？
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              此操作将在保存后生效。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmDeleteItem} style={confirmBtnStyle}>
                确认
              </button>
              <button onClick={() => setItemToDelete(null)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.activeSessionId === nextProps.activeSessionId
    && prevProps.streamingSessions === nextProps.streamingSessions
    && prevProps.completedSessions === nextProps.completedSessions
    && prevProps.collapsed === nextProps.collapsed;
});

// Simple color mapping for backend badges
// Using solid colors that work on both light and dark backgrounds
function getBackendBadgeColor(backendId: string): string {
  if (backendId.includes('opus')) return '#a855f733';  // Purple with alpha
  if (backendId.includes('sonnet')) return '#6366f133'; // Indigo with alpha
  if (backendId.includes('haiku')) return '#22c55e33';  // Green with alpha
  if (backendId.includes('gpt')) return '#ef444433';    // Red with alpha
  return '#94a3b833';                                    // Slate with alpha
}

const sidebarStyle: React.CSSProperties = {
  width: 260,
  borderRight: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--theme-sidebar-bg, #f6f8fa)',
  flexShrink: 0,
  transition: 'width 0.2s ease',
};

const collapsedSidebarStyle: React.CSSProperties = {
  width: 40,
  borderRight: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  background: 'var(--theme-sidebar-bg, #f6f8fa)',
  flexShrink: 0,
  paddingTop: 12,
};

const toggleBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s ease',
};

const runningDotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--theme-success, #2da44e)',
};

const newBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s ease',
};

const itemStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  cursor: 'pointer',
  marginBottom: 4,
  position: 'relative',
  transition: 'background 0.15s',
};

const actionBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 13,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const renameInputStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  fontFamily: 'inherit',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-accent, #7aa2f7)',
  borderRadius: 6,
  color: 'var(--theme-text, #e2e3ea)',
  padding: '2px 6px',
  outline: 'none',
  boxShadow: '0 0 0 2px var(--theme-accent-bg, rgba(122,162,247,0.15))',
};

const backendBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  fontWeight: 500,
  color: 'var(--theme-text, #1f2328)',
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const confirmPanelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 12,
  padding: 24, width: '90%', maxWidth: 400,
  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
};

const confirmBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-error, #cf222e)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-bg-secondary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', fontSize: 14, cursor: 'pointer',
};

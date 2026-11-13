import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { api } from '../api';
import { TextAttachmentPreview } from './TextAttachmentPreview';
import type { TextAttachment } from '../types/attachments';

interface EditImage {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
}

// 序列任务：用户预排的一串渐进明细的想法/指令。一条答完再发下一条；
// 模型忙碌时继续输入会自动入队；本组件显示等待状态，并允许编辑、增删、调序。
export interface SeqTaskT {
  id: string;
  text: string;
  images?: any[];
  imageCount?: number;
  textAttachments?: any[];
  textAttachmentCount?: number;
  deliveryMode?: 'redirect';
  status: string;
  error?: string;
  createdAt?: number;
  syncing?: boolean;
  scheduleRef?: import('../types/sessionSchedules').ScheduleRef;
}

interface Props {
  sessionId: string;
  tasks: SeqTaskT[];
  chainActive?: boolean;   // 执行端持久化的自动调度开关
  queueError?: string;
  isStreaming: boolean;
  onSendNext: () => void;
  onPause?: () => void;
  canSteer?: boolean;
  steerAttachments?: boolean;
  steerCapabilityError?: string;
  onRefreshSteerCapabilities?: () => void;
  onSteerTask?: (taskId: string) => Promise<{ status: string; message?: string }>;
  onTasksChange?: (tasks: SeqTaskT[]) => void;
}

// 仅收起显示，不截断队列原文；长日志按需展开，滚动留在当前卡片内。
const SeqTaskText: React.FC<{ text: string; history?: boolean }> = ({ text, history = false }) => {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const preview = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
  useEffect(() => { setExpanded(false); }, [text]);
  useLayoutEffect(() => {
    if (expanded || !previewRef.current) return;
    const element = previewRef.current;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <div style={{ minWidth: 0, width: '100%' }} onClick={event => { if (expanded) event.stopPropagation(); }}>
    <div ref={previewRef} style={{ ...(history ? historyText : taskText), ...(expanded ? fullTextStyle : previewTextStyle) }}
      role={expanded ? 'region' : undefined} aria-label={expanded ? '任务完整内容' : '任务内容预览'} tabIndex={expanded ? 0 : undefined}>
      {text ? expanded ? text : preview : <span style={{ color: 'var(--theme-text-muted)' }}>（仅附件）</span>}
    </div>
    {(expanded || clipped || text.length > 1000) && <button type="button" aria-expanded={expanded}
      onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}
      style={textToggleStyle}>{expanded ? '收起全文' : '查看全文'}</button>}
  </div>;
};

export const SeqTaskPanel: React.FC<Props> = ({
  sessionId, tasks, chainActive, queueError, isStreaming, onSendNext, onPause, canSteer, steerAttachments = true,
  steerCapabilityError, onRefreshSteerCapabilities, onSteerTask, onTasksChange,
}) => {
  const pending = tasks.filter((t) => ['pending', 'steering', 'error'].includes(t.status));
  const running = tasks.some((t) => t.status === 'running');
  const failed = tasks.some((t) => t.status === 'error');
  const hasSyncing = pending.some((t) => t.syncing);
  const sent = tasks.filter((t) => ['sent', 'done', 'interrupted'].includes(t.status));
  const [open, setOpen] = useState(false);   // 默认收起,只留一条 slim 条
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editImages, setEditImages] = useState<EditImage[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);  // ★ 历史条目折叠
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null);  // ★ 历史图片编辑
  const [historyImages, setHistoryImages] = useState<EditImage[]>([]);
  const [steeringIds, setSteeringIds] = useState<Set<string>>(() => new Set());
  const [steerErrors, setSteerErrors] = useState<Record<string, string>>({});
  const [mutationError, setMutationError] = useState('');
  const editPasteRef = useRef<HTMLTextAreaElement>(null);

  // 首页“处理待办”直接落到目标会话并展开队列，避免用户再点第二次。
  useEffect(() => {
    try {
      if (sessionStorage.getItem('awu:open-seq-task-session') === sessionId) {
        setOpen(true);
        sessionStorage.removeItem('awu:open-seq-task-session');
      }
    } catch { /* */ }
    const openFromDashboard = (event: Event) => {
      const targetSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (targetSessionId === sessionId) {
        setOpen(true);
        try { sessionStorage.removeItem('awu:open-seq-task-session'); } catch { /* */ }
      }
    };
    window.addEventListener('awu:open-seq-tasks', openFromDashboard);
    return () => window.removeEventListener('awu:open-seq-tasks', openFromDashboard);
  }, [sessionId]);

  const startEdit = useCallback((t: SeqTaskT) => {
    if (t.scheduleRef) { setMutationError('定时任务请在上方“定时”面板编辑计划或取消本次。'); return; }
    setEditingId(t.id);
    setEditText(t.text);
    setEditImages([]);
    // 异步聚焦
    setTimeout(() => editPasteRef.current?.focus(), 50);
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    const imgs = editImages.length ? editImages.map((im) => ({
      id: im.id, base64: im.base64, mime_type: im.mime_type, size: im.size,
    })) : undefined;
    const result = await api.seqtaskEdit(sessionId, id, editText.trim(), imgs);
    if (result.status !== 'ok') {
      setMutationError(result.message || '保存队列任务失败');
      return;
    }
    if (result.seqTasks) onTasksChange?.(result.seqTasks);
    setMutationError('');
    setEditingId(null);
    setEditImages([]);
  }, [editText, editImages, sessionId, onTasksChange]);

  // ★ 编辑区粘贴图片
  const handleEditPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImgs: EditImage[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          newImgs.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            base64,
            mime_type: file.type,
            size: file.size,
          });
          if (newImgs.length === Array.from(items).filter((it) => it.type.startsWith('image/')).length) {
            setEditImages((prev) => [...prev, ...newImgs]);
          }
        };
        reader.readAsDataURL(file);
        e.preventDefault();
      }
    }
  }, []);

  const removeEditImage = useCallback((id: string) => {
    setEditImages((prev) => prev.filter((im) => im.id !== id));
  }, []);

  // ★ 历史条目的图片编辑（仅图片，文本不可改）
  const startHistoryEdit = useCallback((t: SeqTaskT) => {
    setEditingHistoryId(t.id);
    // 载入已有图片
    const existing: EditImage[] = (t.images || []).map((im: any, i: number) => ({
      id: im.id || `existing_${i}`,
      base64: im.base64 || '',
      mime_type: im.mime_type || 'image/png',
      size: im.size || 0,
    }));
    setHistoryImages(existing);
  }, []);

  const saveHistoryEdit = useCallback(async (id: string) => {
    const imgs = historyImages.length ? historyImages.map((im) => ({
      id: im.id, base64: im.base64, mime_type: im.mime_type, size: im.size,
    })) : undefined;
    const result = await api.seqtaskEdit(sessionId, id, '', imgs);
    if (result.status !== 'ok') {
      setMutationError(result.message || '保存历史附件失败');
      return;
    }
    if (result.seqTasks) onTasksChange?.(result.seqTasks);
    setMutationError('');
    setEditingHistoryId(null);
    setHistoryImages([]);
  }, [historyImages, sessionId, onTasksChange]);

  const handleHistoryPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImgs: EditImage[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          newImgs.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            base64,
            mime_type: file.type,
            size: file.size,
          });
          if (newImgs.length === Array.from(items).filter((it) => it.type.startsWith('image/')).length) {
            setHistoryImages((prev) => [...prev, ...newImgs]);
          }
        };
        reader.readAsDataURL(file);
        e.preventDefault();
      }
    }
  }, []);

  const removeHistoryImage = useCallback((id: string) => {
    setHistoryImages((prev) => prev.filter((im) => im.id !== id));
  }, []);

  const move = useCallback(async (idx: number, dir: -1 | 1) => {
    const ids = pending.map((t) => t.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    const result = await api.seqtaskReorder(sessionId, ids);
    if (result.status === 'ok' && result.seqTasks) onTasksChange?.(result.seqTasks);
    else if (result.status !== 'ok') setMutationError(result.message || '调整队列顺序失败');
  }, [pending, sessionId, onTasksChange]);

  const clearTasks = useCallback(async () => {
    const result = await api.seqtaskClear(sessionId);
    if (result.status === 'ok') {
      if (result.seqTasks) onTasksChange?.(result.seqTasks);
      setMutationError('');
    } else setMutationError(result.message || '清空队列失败');
  }, [sessionId, onTasksChange]);

  const removeTask = useCallback(async (taskId: string) => {
    const result = await api.seqtaskRemove(sessionId, taskId);
    if (result.status === 'ok') {
      if (result.seqTasks) onTasksChange?.(result.seqTasks);
      setMutationError('');
    } else setMutationError(result.message || '删除队列任务失败');
  }, [sessionId, onTasksChange]);

  const steerTask = useCallback(async (taskId: string) => {
    if (!onSteerTask) return;
    setSteeringIds((previous) => new Set(previous).add(taskId));
    setSteerErrors((previous) => {
      const next = { ...previous };
      delete next[taskId];
      return next;
    });
    try {
      const result = await onSteerTask(taskId);
      if (result.status !== 'ok') {
        setSteerErrors((previous) => ({
          ...previous,
          [taskId]: result.message || '引导失败，消息仍保留在队列中',
        }));
      }
    } catch (error) {
      setSteerErrors((previous) => ({
        ...previous,
        [taskId]: String(error) || '引导失败，消息仍保留在队列中',
      }));
    } finally {
      setSteeringIds((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    }
  }, [onSteerTask]);

  const canSendNext = !hasSyncing && pending.length > 0;
  if (!pending.length && !running && !queueError && !mutationError) return null;

  return (
    <section aria-label="序列队列" style={wrap}>
      <div style={header}>
        <button onClick={() => setOpen(!open)} aria-expanded={open} style={chevBtn} title={open ? '收起' : '展开队列'}>{open ? '▾' : '▸'}</button>
        <span
          onClick={() => setOpen(!open)}
          style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--theme-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title="点击查看/管理队列"
        >
          🧬 序列队列
          {pending.length > 0 && <span style={countPill}>{pending.length}</span>}
        </span>
        {(pending.length > 0 || running) && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          {chainActive === false ? running ? '执行中 · 后续已暂停' : '已暂停' : running ? '执行中' : isStreaming ? '等待当前回答' : '等待执行'}
        </span>}
        <div style={{ flex: 1 }} />
        {chainActive === false && pending.length > 0 && (
          <button onClick={onSendNext} disabled={!canSendNext}
            title={failed ? '重试失败条目并继续；已执行的部分操作可能重复，请先核对聊天结果' : '恢复执行端自动调度，当前回答结束后继续'}
            style={{ ...sendBtn, opacity: canSendNext ? 1 : 0.45, cursor: canSendNext ? 'pointer' : 'not-allowed' }}>
            {failed ? '↻ 重试并继续' : '▶ 继续'}
          </button>
        )}
        {chainActive && onPause && (
          <button onClick={onPause} style={sendBtn} title="暂停后续任务，不中断当前回答；状态保存在执行端">⏸ 暂停</button>
        )}
        {pending.length > 0 && (
          <button onClick={() => void clearTasks()} disabled={hasSyncing}
            style={{ ...clearBtn, opacity: hasSyncing ? .45 : 1 }}
            title={hasSyncing ? '等待新增任务同步完成' : '清空队列'}>清空</button>
        )}
      </div>

      <div style={queueContentStyle} role="region" aria-label="序列队列内容" tabIndex={0}>
      {mutationError && <div style={mutationErrorStyle}>⚠ {mutationError}</div>}
      {queueError && <div style={mutationErrorStyle}>⚠ {queueError}</div>}
      {steerCapabilityError && pending.length > 0 && (
        <div style={mutationErrorStyle}>
          引导能力暂未确认：{steerCapabilityError}。待发消息仍保留在队列中。
          {onRefreshSteerCapabilities && (
            <button onClick={onRefreshSteerCapabilities} style={tinyGhost}>重新检查引导能力</button>
          )}
        </div>
      )}

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {pending.length === 0 ? (
            <div style={emptyHint}>
              暂无待发任务
            </div>
          ) : pending.map((t, i) => (
            <div key={t.id} data-seq-task-id={t.id} style={card}>
              <span style={idxBadge}>{i + 1}</span>
              {editingId === t.id ? (
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea ref={editPasteRef} value={editText} onChange={(e) => setEditText(e.target.value)}
                    onPaste={handleEditPaste}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(t.id); if (e.key === 'Escape') { setEditingId(null); setEditImages([]); } }}
                    placeholder="编辑内容… 可粘贴图片（Ctrl+V）"
                    style={editArea} />
                  {/* ★ 编辑区图片预览 */}
                  {editImages.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {editImages.map((im) => (
                        <div key={im.id} style={editImgWrap}>
                          <img src={`data:${im.mime_type};base64,${im.base64}`} style={editImgThumb} alt="" />
                          <button onClick={() => removeEditImage(im.id)} style={editImgRemove} title="移除">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => saveEdit(t.id)} style={tinyPrimary}>保存</button>
                    <button onClick={() => { setEditingId(null); setEditImages([]); }} style={tinyGhost}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}
                  onClick={() => { if (['pending', 'error'].includes(t.status) && !t.syncing) startEdit(t); }}
                  title={t.syncing ? '正在同步到执行端' : t.status === 'pending' ? '点击编辑' : '正在引导当前轮'}>
                  <div style={taskLine}>
                    {t.scheduleRef && <span title={`定时计划 ${t.scheduleRef.scheduleId}；请在定时面板管理`}>定时</span>}
                    <div style={{ flex: '1 1 160px', minWidth: 0, maxWidth: '100%' }}><SeqTaskText text={t.text} /></div>
                    {t.syncing && <span style={syncingBadge}>同步中…</span>}
                    {!t.syncing && !t.scheduleRef && (steeringIds.has(t.id) || t.status === 'steering' || (canSteer && t.status === 'pending')) && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void steerTask(t.id);
                        }}
                        disabled={steeringIds.has(t.id) || t.status === 'steering' || (!steerAttachments && !!(t.imageCount || t.images?.length))}
                        style={{
                          ...steerBtn,
                          opacity: steeringIds.has(t.id) || t.status === 'steering' ? 0.6 : 1,
                          cursor: steeringIds.has(t.id) || t.status === 'steering' ? 'wait' : 'pointer',
                        }}
                        title={!steerAttachments && (t.imageCount || t.images?.length) ? '此后端的当前轮引导不支持图片，请排到下一轮' : '引导当前轮，在后续步骤生效；不会中断正在执行的工具'}
                      >
                        {steeringIds.has(t.id) || t.status === 'steering' ? '引导中…' : '↪ 引导'}
                      </button>
                    )}
                  </div>
                  {steerErrors[t.id] && <div style={steerError}>{steerErrors[t.id]}</div>}
                  {t.error && <div style={steerError}>{t.error}</div>}
                  {!!(t.imageCount || t.images?.length) && (
                    <span style={imgBadge}>🖼️ {t.imageCount ?? t.images?.length}</span>
                  )}
                  {!!(t.textAttachmentCount || t.textAttachments?.length) && (
                    <span style={imgBadge}>📄 {t.textAttachmentCount ?? t.textAttachments?.length}</span>
                  )}
                  {!!t.textAttachments?.length && (
                    <div onClick={(event) => event.stopPropagation()} style={{ marginTop: 5 }}>
                      <TextAttachmentPreview
                        attachments={t.textAttachments as TextAttachment[]}
                        compact
                      />
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', flexShrink: 0, flexDirection: 'column', gap: 2 }}>
                <button onClick={() => move(i, -1)} disabled={i === 0 || t.status === 'steering' || hasSyncing} style={arrowBtn} title="上移">▲</button>
                <button onClick={() => move(i, 1)} disabled={i === pending.length - 1 || t.status === 'steering' || hasSyncing} style={arrowBtn} title="下移">▼</button>
              </div>
              <button onClick={() => void removeTask(t.id)} disabled={!!t.scheduleRef || t.status === 'steering' || t.syncing} style={removeBtn} title={t.scheduleRef ? '请在定时面板取消本次运行' : '删除'}>✕</button>
            </div>
          ))}

          {/* ★ 历史已发送条目（可追加/编辑图片） */}
          {sent.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                style={historyToggleBtn}
              >
                {historyOpen ? '▾' : '▸'} 📋 执行历史 ({sent.length})
              </button>
              {historyOpen && sent.map((t) => (
                <div key={t.id} data-seq-task-id={t.id} style={historyCard}>
                  <span style={historyBadge}>{t.status === 'interrupted' ? '⏹' : '✓'}</span>
                  {editingHistoryId === t.id ? (
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <SeqTaskText text={t.text} history />
                      {/* 图片编辑区：粘贴添加 */}
                      <div
                        onPaste={handleHistoryPaste}
                        style={historyPasteArea}
                      >
                        {historyImages.length === 0
                          ? <span style={{ color: 'var(--theme-text-muted)', fontSize: 11 }}>点击此处后粘贴图片（Ctrl+V）</span>
                          : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {historyImages.map((im) => (
                                <div key={im.id} style={editImgWrap}>
                                  {im.base64 && <img src={`data:${im.mime_type};base64,${im.base64}`} style={editImgThumb} alt="" />}
                                  <button onClick={() => removeHistoryImage(im.id)} style={editImgRemove} title="移除">✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => saveHistoryEdit(t.id)} style={tinyPrimary}>保存图片</button>
                        <button onClick={() => { setEditingHistoryId(null); setHistoryImages([]); }} style={tinyGhost}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 0 }} onClick={() => startHistoryEdit(t)} title="点击编辑图片">
                        {t.error && <div style={steerError}>{t.error}</div>}
                        <SeqTaskText text={t.text} history />
                        {!!(t.imageCount || t.images?.length) && (
                          <span style={imgBadge}>🖼️ {t.imageCount ?? t.images?.length}</span>
                        )}
                        {!!(t.textAttachmentCount || t.textAttachments?.length) && (
                          <span style={imgBadge}>📄 {t.textAttachmentCount ?? t.textAttachments?.length}</span>
                        )}
                        {!!t.textAttachments?.length && (
                          <div onClick={(event) => event.stopPropagation()} style={{ marginTop: 5 }}>
                            <TextAttachmentPreview
                              attachments={t.textAttachments as TextAttachment[]}
                              compact
                            />
                          </div>
                        )}
                      </div>
                      <button onClick={() => startHistoryEdit(t)} style={histEditBtn} title="编辑图片">🖼️</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </section>
  );
};

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: '0 1 auto', minHeight: 0, minWidth: 0, maxHeight: 'min(320px, 35vh)', overflow: 'hidden', boxSizing: 'border-box', borderTop: '1px solid var(--theme-border)', padding: '7px 12px', background: 'var(--theme-bg-secondary)' };
const header: React.CSSProperties = { display: 'flex', flexShrink: 0, flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const queueContentStyle: React.CSSProperties = { minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain' };
const chevBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 12, padding: 0 };
const countPill: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--theme-accent)', borderRadius: 999, padding: '0 7px', lineHeight: 1.7 };
const sendBtn: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 7, border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const clearBtn: React.CSSProperties = { fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--theme-border)', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const emptyHint: React.CSSProperties = { fontSize: 11.5, color: 'var(--theme-text-muted)', lineHeight: 1.6, padding: '4px 2px' };
const card: React.CSSProperties = { display: 'flex', flexShrink: 0, minWidth: 0, alignItems: 'flex-start', gap: 8, padding: '7px 9px', borderRadius: 8, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)' };
const idxBadge: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--theme-text-muted)', minWidth: 16, textAlign: 'center', marginTop: 2 };
const taskLine: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 };
const taskText: React.CSSProperties = { fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', cursor: 'text' };
const previewTextStyle: React.CSSProperties = { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' };
const fullTextStyle: React.CSSProperties = { maxHeight: 'min(180px, 20vh)', overflow: 'auto', overscrollBehavior: 'contain' };
const textToggleStyle: React.CSSProperties = { border: 0, padding: '2px 0', background: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 11 };
const steerBtn: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, fontWeight: 650, padding: '2px 7px', borderRadius: 999, border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const steerError: React.CSSProperties = { marginTop: 3, fontSize: 10.5, color: 'var(--theme-error, #cf222e)', lineHeight: 1.35, maxHeight: 72, overflow: 'auto', overflowWrap: 'anywhere' };
const mutationErrorStyle: React.CSSProperties = { ...steerError, marginTop: 5 };
const syncingBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-accent)', border: '1px solid var(--theme-accent)', borderRadius: 999, padding: '1px 6px' };
const imgBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 3, display: 'inline-block' };
const editArea: React.CSSProperties = { width: '100%', minHeight: 48, maxHeight: 'min(180px, 20vh)', overflow: 'auto', fontSize: 12.5, padding: 6, borderRadius: 6, border: '1px solid var(--theme-accent)', background: 'var(--theme-bg)', color: 'var(--theme-text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' };
const arrowBtn: React.CSSProperties = { fontSize: 9, lineHeight: 1, padding: '2px 4px', border: '1px solid var(--theme-border)', borderRadius: 4, background: 'var(--theme-bg)', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const removeBtn: React.CSSProperties = { flexShrink: 0, fontSize: 11, padding: '2px 6px', border: 'none', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const tinyPrimary: React.CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--theme-accent)', color: '#fff', cursor: 'pointer' };
const tinyGhost: React.CSSProperties = { fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const editImgWrap: React.CSSProperties = { position: 'relative', width: 40, height: 40, borderRadius: 6, border: '1px solid var(--theme-border)', overflow: 'hidden', flexShrink: 0 };
const editImgThumb: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
const editImgRemove: React.CSSProperties = { position: 'absolute', top: -2, right: -2, width: 14, height: 14, borderRadius: '50%', border: 'none', background: 'var(--theme-error, #cf222e)', color: '#fff', fontSize: 8, lineHeight: '14px', textAlign: 'center', cursor: 'pointer', padding: 0 };

// ★ 历史条目样式
const historyToggleBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 11, fontWeight: 600, padding: '4px 0', textAlign: 'left' };
const historyCard: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px', borderRadius: 6, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', opacity: 0.75, marginTop: 4 };
const historyBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-success, #2da44e)', minWidth: 14, textAlign: 'center', marginTop: 2 };
const historyText: React.CSSProperties = { fontSize: 11.5, color: 'var(--theme-text-muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', cursor: 'pointer' };
const historyPasteArea: React.CSSProperties = { minHeight: 32, padding: 6, borderRadius: 6, border: '1px dashed var(--theme-border)', background: 'var(--theme-bg-secondary)', cursor: 'text' };
const histEditBtn: React.CSSProperties = { fontSize: 10, padding: '2px 6px', border: '1px solid var(--theme-border)', borderRadius: 4, background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };

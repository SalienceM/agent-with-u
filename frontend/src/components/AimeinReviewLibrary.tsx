import React, { useEffect, useRef, useState } from 'react';
import type { AimeinDocument, AimeinLibraryResult, AimeinMemory, AimeinRecommendation } from '../types/aimein';
import type { LoopRecord, LoopStateT } from '../types/loopWorkbench';
import { BackendRuntimeFields, isRuntimeConfigurableBackend, isPoeBackend } from './CodexRuntimeFields';

export const aimeinButton: React.CSSProperties = { border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', borderRadius: 7, padding: '8px 12px', fontSize: 12, cursor: 'pointer' };
export const aimeinInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)', borderRadius: 7, padding: '9px 11px', font: 'inherit', fontSize: 13 };
const small: React.CSSProperties = { fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.8 };
const block: React.CSSProperties = { padding: 16, borderRadius: 12, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', minWidth: 0, overflowWrap: 'anywhere' };
const emptyDocument: AimeinDocument = { name: '', backendId: '', model: '', reasoningEffort: '', domain: '', flavor: '', focus: '' };
const kinds: Record<string, string> = { preference: '偏好校准', confirmed: '判断得到确认', false_positive: '误报', missed: '漏报', unsuitable: '不适配' };

export const AimeinReviewLibrary: React.FC<{
  state: LoopStateT; current?: LoopRecord; backends?: any[]; execKey: string; disabled: boolean; active: boolean;
  load: (task: string) => Promise<AimeinLibraryResult>;
  update: (command: Record<string, unknown>) => Promise<{ status: string; message?: string }>;
  calibration?: { id: string; serial: number };
}> = ({ state, current, backends = [], execKey, disabled, active, load, update, calibration }) => {
  const [memory, setMemory] = useState<AimeinMemory>();
  const [ranked, setRanked] = useState<AimeinRecommendation[]>([]);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(state.goal);
  const [task, setTask] = useState(state.goal);
  const [chosen, setChosen] = useState<string[]>([]);
  const [draft, setDraft] = useState<AimeinDocument>({ ...emptyDocument });
  const [editing, setEditing] = useState('');
  const [draftRevision, setDraftRevision] = useState(0);
  const [showEditor, setShowEditor] = useState(false);
  const [imported, setImported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewId, setReviewId] = useState('review1');
  const calibrationForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!active || !calibration) return;
    setReviewId(calibration.id);
    requestAnimationFrame(() => {
      const form = calibrationForm.current;
      const panel = form?.closest<HTMLElement>('[data-testid="aimein-scene-panel"]');
      if (form && panel) panel.scrollTop += form.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
    });
  }, [calibration?.serial, active]);
  const [kind, setKind] = useState('preference');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const noteKey = `${current?.seq || 0}:${reviewId}`;
  const note = notes[noteKey] || '';
  const inflight = useRef(false);
  const loadedKey = useRef('');
  useEffect(() => {
    if (!active) return;
    const key = JSON.stringify([task, state.aimeinMemory?.revision || 0, retry]);
    if (loadedKey.current === key) return;
    let alive = true;
    setReadError('');
    load(task).then(result => {
      if (!alive) return;
      if (result.status !== 'ok' || !result.memory) throw new Error(result.message || '档案读取失败');
      loadedKey.current = key;
      setMemory(result.memory); setRanked(result.recommendations || []);
    }).catch(error => { if (alive) setReadError(String(error.message || error)); });
    return () => { alive = false; };
  }, [load, task, state.aimeinMemory?.revision, retry, active]);
  const perform = async (command: Record<string, unknown>) => {
    if (inflight.current || !memory || disabled) return false;
    inflight.current = true; setSaving(true); setNotice('正在保存…');
    try {
      const result = await update({ expectedRevision: memory.revision, ...command });
      if (result.status !== 'ok') { setNotice(result.message || '结果未确认，请先重新读取，草稿已保留'); return false; }
      setNotice('已保存'); setRetry(n => n + 1); return true;
    } catch (error: any) { setNotice(error.message || '保存失败，草稿已保留'); return false; }
    finally { inflight.current = false; setSaving(false); }
  };
  const controlsDisabled = disabled || saving || !memory;
  const selectedModels = chosen.map(id => memory?.profiles.find(p => p.id === id)?.document.model.trim().toLocaleLowerCase()).filter(Boolean);
  const duplicateModels = new Set(selectedModels).size !== selectedModels.length;
  const backend = backends.find(b => b.id === draft.backendId);
  const eligibleReviews = current?.completed ? current.aimeinRun?.reviews?.filter(r => r.profile && ['passed', 'changes_requested'].includes(r.status)) || [] : [];
  const selectedReview = eligibleReviews.find(r => r.id === reviewId);
  const exportDocument = (document: AimeinDocument) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'aimein-reviewer', version: 1, document }, null, 2)], { type: 'application/json' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'aimein-reviewer.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section aria-label="评委工坊" style={{ display: 'grid', gap: 16 }}>
    <div style={{ ...block, background: 'linear-gradient(115deg, var(--theme-accent-bg), var(--theme-bg-secondary))' }}>
      <div style={small}>REVIEWER WORKSHOP</div><h3 style={{ margin: '5px 0 10px', fontSize: 19 }}>让评委越来越理解这个目标</h3>
      <p style={small}>模型 × 口味 × 聚焦。积累的是有版本的评审经验文档；能力判断来自可追溯的用户校准。档案属于当前会话，跨会话可导出再导入。</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={aimeinButton} disabled={controlsDisabled} onClick={() => { setDraft({ ...emptyDocument }); setEditing(''); setImported(false); setDraftRevision(memory!.revision); setShowEditor(true); }}>创建评委档案</button>
        <label style={{ ...aimeinButton, opacity: controlsDisabled ? .5 : 1 }}>导入档案
          <input aria-label="导入评委档案" type="file" accept="application/json,.json" disabled={controlsDisabled} style={{ display: 'block', maxWidth: 200, fontSize: 11, marginTop: 4 }} onChange={async e => {
            const file = e.target.files?.[0]; if (!file) return;
            try {
              if (file.size > 20000) throw new Error('档案文件超过 20 KB');
              const raw = JSON.parse(await file.text());
              if (raw.format !== 'aimein-reviewer' || raw.version !== 1 || !raw.document) throw new Error('不是 AIMEIN 评委档案');
              const value = { ...emptyDocument };
              for (const key of Object.keys(value) as Array<keyof AimeinDocument>) {
                if (typeof raw.document[key] !== 'string') throw new Error('档案字段缺失');
                value[key] = raw.document[key];
              }
              setDraft(value); setEditing(''); setImported(true); setDraftRevision(memory!.revision); setShowEditor(true); setNotice('已读取文档，请核对模型连接后保存；不导入能力评分。');
            } catch (error: any) { setNotice(error.message || '导入失败'); }
            e.target.value = '';
          }} />
        </label>
      </div>
      {disabled && <p style={small}>当前执行或控制权状态下只能查看；档案修改从空闲时开始。</p>}
      {readError && <p role="alert">{readError} <button style={aimeinButton} onClick={() => setRetry(n => n + 1)}>重新读取档案</button></p>}
      {!memory && !readError && <p role="status">正在读取档案…</p>}
      {notice && <p role="status" style={small}>{notice}</p>}
    </div>
    {showEditor && <form aria-label="评委档案编辑" style={block} onSubmit={async e => {
      e.preventDefault();
      if (await perform({ action: imported ? 'import' : 'save', profileId: editing, document: draft, expectedRevision: draftRevision })) setShowEditor(false);
    }}>
      <h4 style={{ marginTop: 0 }}>{imported ? '核对导入档案' : editing ? '更新档案版本' : '建立一位评委'}</h4>
      {memory && memory.revision !== draftRevision && <div role="status" style={small}>档案库已更新，草稿仍保留。请核对下方最新档案。<button type="button" style={aimeinButton} onClick={() => setDraftRevision(memory.revision)}>以最新修订保存此草稿</button></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 }}>
        <label style={small}>档案名称<input required maxLength={120} style={aimeinInput} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label style={small}>模型连接<select required style={aimeinInput} value={draft.backendId} onChange={e => { const b = backends.find(v => v.id === e.target.value); setDraft({ ...draft, backendId: e.target.value, model: b?.model || '', reasoningEffort: '' }); }}>
          <option value="">选择当前执行节点的连接</option>{backends.filter(b => b.enabled !== false && !isPoeBackend(b)).map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
        </select></label>
      </div>
      {backend && isRuntimeConfigurableBackend(backend) ? <BackendRuntimeFields compact backend={backend} sessionId={state.sessionId} execKey={execKey} value={draft} onChange={runtime => setDraft({ ...draft, model: runtime.model || '', reasoningEffort: runtime.reasoningEffort || '' })} />
        : <p style={small}>模型：{draft.model || '选择连接后显示'}</p>}
      {([['domain', '领域 / 适用任务', '例如：产品体验、离线存储、代码审查', 500], ['flavor', '口味 / 取舍偏好', '例如：先保证用户首次使用清晰，再考虑配置灵活性', 1200], ['focus', '聚焦 / 核对重点', '例如：失败反馈、恢复路径、成熟度是否符合当前目标', 1200]] as const).map(([key, label, placeholder, max]) => <label key={key} style={{ ...small, display: 'block', marginTop: 12 }}>{label}
        <textarea required maxLength={max} rows={key === 'domain' ? 2 : 3} style={{ ...aimeinInput, resize: 'vertical' }} placeholder={placeholder} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} />
      </label>)}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button disabled={controlsDisabled} style={aimeinButton} type="submit">保存档案</button><button style={aimeinButton} type="button" onClick={() => setShowEditor(false)}>收起编辑</button></div>
    </form>}
    <section aria-label="评委推荐" style={block}>
      <h4 style={{ marginTop: 0 }}>为下一次评审组队</h4>
      <label style={small}>任务与成熟度关注点<textarea style={aimeinInput} rows={2} maxLength={8000} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
        <button style={aimeinButton} onClick={() => { setTask(query); setRetry(n => n + 1); }}>查看匹配推荐</button>
        <button style={aimeinButton} disabled={controlsDisabled || !ranked.some(r => r.recommended)} onClick={() => setChosen(ranked.filter(r => r.recommended).map(r => r.profileId))}>勾选推荐组合</button>
        <button style={aimeinButton} disabled={controlsDisabled || (chosen.length < 1 || chosen.length > 3) || duplicateModels} onClick={() => void perform({ action: 'select', profileIds: chosen })}>选用 {chosen.length} 位评委</button>
      </div>
      <p style={small}>只依据领域匹配和同版本用户校准排序。{ranked.filter(r => r.recommended).length < 3 ? '可以选用 1–3 位不同模型；数量由你决定。' : '不同模型相互补充；选用后在下一次尝试冻结。'}</p>
      {duplicateModels && <p role="status" style={small}>各席位需要不同模型；同一模型的不同档案不能重复占位。</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 12 }}>
        {ranked.map(item => {
          const profile = memory?.profiles.find(p => p.id === item.profileId); if (!profile) return null;
          const doc = profile.document;
          const calibrations = memory?.calibrations.filter(c => c.profileId === profile.id) || [];
          const inUse = state.policy?.aimeinReviewers?.some(r => r.profileId === profile.id);
          return <article key={profile.id} style={block}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'start', fontSize: 14, fontWeight: 600 }}><input type="checkbox" aria-label={`选择 ${doc.name}`} disabled={!item.available || controlsDisabled} checked={chosen.includes(profile.id)} onChange={e => setChosen(e.target.checked ? [...chosen, profile.id].slice(-3) : chosen.filter(id => id !== profile.id))} />{doc.name}</label>
            <p style={small}>{doc.model} · {inUse ? '已选用' : item.recommended ? '建议候选' : item.available ? '可主动选择' : '连接不可用'} · v{doc.revision?.slice(0, 6)}</p>
            <p style={small}><b>口味</b> {doc.flavor}<br /><b>聚焦</b> {doc.focus}</p>
            <ul style={{ ...small, paddingLeft: 18 }}>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={controlsDisabled} style={aimeinButton} onClick={() => { setDraft({ ...doc }); setEditing(profile.id); setImported(false); setDraftRevision(memory!.revision); setShowEditor(true); }}>编辑档案</button>
              <button style={aimeinButton} onClick={() => exportDocument(doc)}>导出文档</button>
            </div>
            <details style={{ ...small, marginTop: 10 }}><summary>版本与校准 ({profile.history.length} / {calibrations.length})</summary>
              {profile.history.map((version, i) => <p key={`${version.revision}-${i}`}>v{version.revision?.slice(0, 6)} · {version.model}<br />{version.flavor}<br />{version.focus}</p>)}
              {calibrations.map(c => <p key={`${c.seq}:${c.reviewId}`}>尝试 #{c.seq} · {kinds[c.kind]} · v{c.revision.slice(0, 6)}<br />{c.note}</p>)}
              {!profile.history.length && !calibrations.length && <p>尚无历史；没有依据的能力保持未知。</p>}
            </details>
          </article>;
        })}
      </div>
      {memory && !memory.profiles.length && <p style={small}>还没有评委档案。先为已有模型写下口味和聚焦，再积累实际评审中的校准。</p>}
    </section>
    <form ref={calibrationForm} aria-label="评委校准" style={block} onSubmit={async e => { e.preventDefault(); const key = noteKey; if (await perform({ action: 'calibrate', seq: current?.seq, reviewId, kind, note })) setNotes(prev => ({ ...prev, [key]: '' })); }}>
      <h4 style={{ marginTop: 0 }}>从这次评审中学到什么</h4>
      <p style={small}>针对当前查看的尝试 #{current?.seq || '—'}，记录判断与实际用户需求的差异。偏好不增加能力信用，同一评审重复保存会更新原校准。</p>
      {!eligibleReviews.length ? <p style={small}>先选用档案完成一次独立评审，才能在这里校准其模型与档案组合。</p> : <>
        <label style={small}>被校准的评委<select style={aimeinInput} value={reviewId} onChange={e => setReviewId(e.target.value)}><option value="">请选择</option>{eligibleReviews.map(r => <option key={r.id} value={r.id}>{r.profile?.name} · {r.model}</option>)}</select></label>
        <label style={{ ...small, display: 'block', marginTop: 10 }}>观察类型<select style={aimeinInput} value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label style={{ ...small, display: 'block', marginTop: 10 }}>具体依据 / 下次应如何理解<textarea required maxLength={1600} rows={3} style={aimeinInput} value={note} onChange={e => setNotes({ ...notes, [noteKey]: e.target.value })} placeholder="指出具体判断、实际结果和需要调整的关注点" /></label>
        <button style={{ ...aimeinButton, marginTop: 10 }} disabled={controlsDisabled || !selectedReview} type="submit">保存用户校准</button>
      </>}
    </form>
  </section>;
};

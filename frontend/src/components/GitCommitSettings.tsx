import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getExecutors, getHomeExecKey, onExecStatus, onCurrentUserChanged,
  type GitCommitRule, type GitCommitRuleState, type GitCommitPromptPreview } from '../api';

interface Props {
  initialExecKey?: string;
  initialWorkingDir?: string;
  onDirtyChange: (dirty: boolean) => void;
}

export const GitCommitSettings: React.FC<Props> = ({ initialExecKey, initialWorkingDir, onDirtyChange }) => {
  const [executors, setExecutors] = useState(getExecutors);
  const [execKey, setExecKey] = useState(initialExecKey || getHomeExecKey());
  const [workingDir, setWorkingDir] = useState(initialWorkingDir || '');
  const [scope, setScope] = useState<'default' | 'project'>('default');
  const [sessions, setSessions] = useState<any[]>([]);
  const [state, setState] = useState<GitCommitRuleState | null>(null);
  const [draft, setDraft] = useState<GitCommitRule | null>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [preview, setPreview] = useState<GitCommitPromptPreview | null>(null);
  const [stagedOnly, setStagedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  const targetDir = scope === 'project' ? workingDir : '';
  const dirty = !!state && JSON.stringify(draft) !== JSON.stringify(state.setting);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedTarget = useRef('');
  const online = executors.some(item => item.key === execKey && item.connected);
  const effective = draft || state?.inherited;
  const projects = useMemo(() => [...new Set(sessions.filter(item => item.execKey === execKey && item.workingDir)
    .map(item => String(item.workingDir)))], [sessions, execKey]);
  const prompt = !draft ? state?.inheritedPrompt || '' : draft.mode === 'builtin' ? state?.defaultPrompt || ''
    : draft.mode === 'library' ? templates.find(item => item.name === draft.promptName)?.content || '' : draft.prompt;

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => onExecStatus(() => setExecutors(getExecutors())), []);
  useEffect(() => onCurrentUserChanged(() => {
    version.current++; setState(null); setDraft(null); setPreview(null); setTemplates([]); setSessions([]);
    loadedTarget.current = '';
    setWorkingDir(''); setScope('default'); setReload(value => value + 1);
  }), []);
  useEffect(() => {
    const id = ++version.current;
    const target = JSON.stringify([execKey, targetDir, scope, reload]);
    // 连接抖动不能抹掉未保存的规则；显式切换/重载才丢弃已确认放弃的草稿。
    if (loadedTarget.current === target && dirtyRef.current) { setBusy(false); return; }
    loadedTarget.current = target;
    setState(null); setPreview(null); setError(''); setNotice('');
    if (!online || (scope === 'project' && !workingDir)) { setBusy(false); return; }
    setBusy(true);
    Promise.all([api.gitCommitSettingsGet(targetDir, execKey), api.listPrompts(execKey), api.listSessions()])
      .then(([result, prompts, allSessions]) => {
        if (version.current !== id) return;
        if (result.status !== 'ok') throw new Error(result.message || '读取规则失败');
        setState(result); setDraft(result.setting); setTemplates(prompts); setSessions(allSessions);
      }).catch(cause => { if (version.current === id) setError(cause?.message || '无法读取提交规则'); })
      .finally(() => { if (version.current === id) setBusy(false); });
    return () => { version.current++; };
  }, [execKey, targetDir, online, reload, scope]);

  const leaveDraft = () => !dirty || window.confirm('提交生成规则尚未保存，是否放弃修改？');
  const changeDraft = (next: GitCommitRule | null) => { setDraft(next); setPreview(null); setNotice(''); };
  const save = async () => {
    if (!state) return;
    const id = version.current;
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const result = await api.gitCommitSettingsSave(targetDir, draft, state.revision, execKey);
      if (id !== version.current) return;
      if (result.status !== 'ok') throw new Error(result.message || '保存失败');
      setState(result); setDraft(result.setting); setNotice('已保存到所选执行端；下次生成生效，不影响正在生成的任务。');
    } catch (cause: any) { if (id === version.current) setError(cause?.message || '保存失败'); }
    finally { if (id === version.current) setBusy(false); }
  };
  const inspect = useCallback(async () => {
    const id = version.current;
    setBusy(true); setError(''); setPreview(null);
    try {
      const result = await api.gitCommitPromptPreview(workingDir, stagedOnly, execKey);
      if (id !== version.current) return;
      if (result.status !== 'ok') throw new Error(result.message || '预览失败');
      setPreview(result);
    } catch (cause: any) { if (id === version.current) setError(cause?.message || '预览失败'); }
    finally { if (id === version.current) setBusy(false); }
  }, [workingDir, stagedOnly, execKey]);

  return <section aria-label="Git 提交生成规则" style={{ display: 'grid', gap: 14, minWidth: 0, fontSize: 12 }}>
    <p style={hint}>统一用于提交面板的 AI 生成、/commit 和自动提交。规则保存在执行端，按当前用户隔离；不会开启提交或推送。</p>
    <label style={label}>执行节点
      <select aria-label="提交规则执行节点" value={execKey} disabled={busy} style={field}
        onChange={event => { if (leaveDraft()) { setExecKey(event.target.value); setWorkingDir(''); setScope('default'); } }}>
        {executors.map(item => <option key={item.key} value={item.key}>{item.label}{item.connected ? '' : '（离线）'}</option>)}
      </select>
    </label>
    {!online && <div role="alert">所选执行端离线，无法读取或保存规则。</div>}
    <label style={label}>项目（用于项目规则和只读预览）
      <select aria-label="提交规则项目" value={workingDir} disabled={busy} style={field}
        onChange={event => { if (scope === 'default' || leaveDraft()) { setWorkingDir(event.target.value); setPreview(null); } }}>
        <option value="">选择当前节点上的 Session 项目</option>
        {workingDir && !projects.includes(workingDir) && <option value={workingDir}>{workingDir}</option>}
        {projects.map(path => <option key={path} value={path}>{path}</option>)}
      </select>
    </label>
    <label style={label}>配置范围
      <select aria-label="提交规则范围" value={scope} disabled={busy} style={field}
        onChange={event => { if (leaveDraft()) setScope(event.target.value as typeof scope); }}>
        <option value="default">默认规则（当前用户 · 所选执行端）</option>
        <option value="project" disabled={!workingDir}>项目覆盖（同一仓库的 Session 共用）</option>
      </select>
    </label>
    {state && effective && <>
      <div style={hint}>优先级：项目覆盖 → 用户默认 → 内置规则。已保存来源：{sourceLabel(state.source)}{state.root && <div style={{ overflowWrap: 'anywhere' }}>{state.root}</div>}</div>
      {state.resolutionError && <div role="alert" style={{ color: 'var(--theme-error)' }}>{state.resolutionError}</div>}
      <label style={label}>生成规则来源
        <select aria-label="生成规则来源" disabled={busy} style={field} value={!draft ? 'inherit' : draft.mode}
          onChange={event => changeDraft(event.target.value === 'inherit' ? null : {
            ...effective, mode: event.target.value as GitCommitRule['mode'], prompt,
          })}>
          <option value="inherit">{scope === 'project' ? '继承默认规则' : '使用内置默认'}</option>
          <option value="builtin">内置规则（可单独设置署名）</option>
          <option value="library">引用 Prompt 库</option>
          <option value="custom">独立自定义模板</option>
        </select>
      </label>
      {draft?.mode === 'library' && <label style={label}>Prompt 模板（生成时读取最新正文）
        <select aria-label="提交 Prompt 模板" disabled={busy} style={field} value={draft.promptName}
          onChange={event => changeDraft({ ...draft, promptName: event.target.value })}>
          <option value="">请选择模板</option>
          {draft.promptName && !templates.some(item => item.name === draft.promptName) && <option value={draft.promptName}>已丢失：{draft.promptName}</option>}
          {templates.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </label>}
      <label style={label}>规则正文{draft?.mode !== 'custom' && '（只读）'}
        <textarea aria-label="提交规则正文" value={prompt} readOnly={draft?.mode !== 'custom'} disabled={busy}
          maxLength={16000} rows={11} style={{ ...field, resize: 'vertical', lineHeight: 1.6 }}
          onChange={event => { if (draft) changeDraft({ ...draft, prompt: event.target.value }); }} />
      </label>
      <div style={hint}>只填写写作规则，diff、文件清单、历史提交由程序附加。引用模板要修改时可在 Prompt 库维护，或切换“独立自定义模板”另存，不覆盖原模板。</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={effective.signature} disabled={busy || !draft}
          onChange={event => { if (draft) changeDraft({ ...draft, signature: event.target.checked }); }} />
        末尾添加 By AgentWithU{!draft && '（继承）'}
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={button} disabled={busy || !dirty || !online} onClick={() => void save()}>保存生成规则</button>
        <button style={button} disabled={busy} onClick={() => changeDraft(null)}>{scope === 'project' ? '恢复继承默认' : '恢复内置默认'}</button>
        <button style={button} disabled={busy} onClick={() => { if (leaveDraft()) setReload(value => value + 1); }}>重新加载</button>
      </div>
      {dirty && <div style={hint}>有未保存的修改，保存后才能预览实际输入。</div>}
      <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 12, display: 'grid', gap: 8 }}>
        <label><input type="checkbox" checked={stagedOnly} disabled={busy} onChange={event => { setStagedOnly(event.target.checked); setPreview(null); }} /> 仅预览已暂存变更</label>
        <button style={button} disabled={busy || dirty || !workingDir || !online} onClick={() => void inspect()}>预览实际输入（不调用 AI）</button>
        <div style={hint}>使用所选项目当前生效的已保存规则；项目覆盖优先。预览全项目材料，提交面板生成时仍只分析勾选文件。</div>
      </div>
    </>}
    {busy && <div role="status">正在读取或保存…</div>}
    {notice && <div role="status">{notice}</div>}
    {error && <div role="alert" style={{ color: 'var(--theme-error)', overflowWrap: 'anywhere' }}>{error}
      <button style={{ ...button, marginLeft: 8 }} disabled={busy} onClick={() => { if (leaveDraft()) setReload(value => value + 1); }}>重试加载</button>
    </div>}
    {preview && <details open>
      <summary>实际输入 · {sourceLabel(preview.source)} · {preview.fileCount} 个变更文件</summary>
      {preview.warnings.map((warning, index) => <p key={index} style={hint}>{warning}</p>)}
      <pre aria-label="提交提示词预览" style={{ ...field, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 380, overflowY: 'auto', fontSize: 11 }}>{preview.constraints}{'\n\n'}{preview.content}</pre>
    </details>}
  </section>;
};

function sourceLabel(source: string): string { return source === 'project' ? '项目覆盖' : source === 'default' ? '用户默认' : '内置规则'; }
const hint: React.CSSProperties = { margin: 0, lineHeight: 1.6, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere' };
const label: React.CSSProperties = { display: 'grid', gap: 6, minWidth: 0 };
const field: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--theme-border)', borderRadius: 5, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', font: 'inherit' };
const button: React.CSSProperties = { padding: '7px 10px', border: '1px solid var(--theme-border)', borderRadius: 5, background: 'var(--theme-accent-bg)', color: 'var(--theme-text)', font: 'inherit', cursor: 'pointer' };

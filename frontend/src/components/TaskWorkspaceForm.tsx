import React, { useEffect, useRef, useState } from 'react';
import type { TaskRepository, TaskWorkspace } from '../types/taskWorkspaces';
import { BackendRuntimeFields, isRuntimeConfigurableBackend } from './CodexRuntimeFields';
import { WorkflowButton, workflowFieldStyle } from './WorkflowControls';

export const copyActionStyle: React.CSSProperties = { minHeight: 42, padding: '10px 20px', fontSize: 14, fontWeight: 600 };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500 };
const helpStyle: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--theme-text-muted, #687487)' };
const sectionStyle: React.CSSProperties = { borderTop: '1px solid var(--theme-border, #dce1e8)', paddingTop: 14 };
const summaryStyle: React.CSSProperties = { cursor: 'pointer', padding: '4px 0', fontWeight: 500 };
const fieldsStyle: React.CSSProperties = { display: 'grid', gap: 16, minWidth: 0 };

interface Props {
  config: TaskWorkspace['config'];
  repo: TaskRepository;
  backends: any[];
  executor: string;
  busy: boolean;
  setConfig: React.Dispatch<React.SetStateAction<TaskWorkspace['config']>>;
  onPreview: () => void;
}

export const TaskWorkspaceForm: React.FC<Props> = ({ config, repo, backends, executor, busy, setConfig, onPreview }) => {
  const nameInput = useRef<HTMLInputElement>(null), focused = useRef(false);
  useEffect(() => {
    if (!busy && !focused.current) { focused.current = true; nameInput.current?.focus(); }
  }, [busy]);
  const backend = backends.find(row => row.id === config.backendId);
  const blocked = config.snapshotMode === 'current' && repo.dirty.some(row => !!row.blocked);
  const [filesOpen, setFilesOpen] = useState(blocked);
  return <fieldset disabled={busy} style={{ ...fieldsStyle, padding: 0, margin: 0, border: 0 }}>
    {repo.initialization && <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
      {repo.initialization.kind === 'init' ? '此项目尚未启用 Git。' : '此项目还没有 Git 提交。'}
      创建时会{repo.initialization.kind === 'init' ? '启用 Git，并' : ''}用所选文件建立首次提交，再创建分支副本。源文件保留。
    </p>}
    <label style={labelStyle}>副本名称
      <input ref={nameInput} aria-label="副本名称" style={workflowFieldStyle} value={config.title} onChange={e => setConfig(old => ({ ...old, title: e.target.value }))} />
    </label>
    <label style={labelStyle}>Backend
      <select aria-label="执行 Backend" style={workflowFieldStyle} value={config.backendId}
        onChange={e => setConfig(old => ({ ...old, backendId: e.target.value, runtime: {} }))}>
        {(!backend || backend.enabled === false) && <option value={config.backendId} disabled>请选择可用 Backend</option>}
        {backends.filter(row => row.enabled !== false).map(row => <option key={row.id} value={row.id}>{row.label || row.id}</option>)}
      </select>
    </label>
    {isRuntimeConfigurableBackend(backend) && <BackendRuntimeFields backend={backend} value={config.runtime}
      onChange={runtime => setConfig(old => ({ ...old, runtime }))} execKey={executor} />}
    <label style={labelStyle}>初始需求 <span style={{ ...helpStyle, fontWeight: 400 }}>（可选）</span>
      <textarea aria-label="初始需求" rows={3} style={{ ...workflowFieldStyle, resize: 'vertical' }} value={config.goal}
        placeholder="也可以创建后再开始对话" onChange={e => setConfig(old => ({ ...old, goal: e.target.value }))} />
    </label>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={config.skipPermissions} onChange={e => setConfig(old => ({ ...old, skipPermissions: e.target.checked }))} />
      跳过普通执行确认
    </label>
    <details style={sectionStyle}>
      <summary style={summaryStyle}>更多设置</summary>
      <div style={{ ...fieldsStyle, marginTop: 14 }}>
        <p style={helpStyle}>沿用当前对话的 Skills、约束和偏好，可在这里调整。</p>
        <label style={labelStyle}>任务约束<textarea aria-label="任务约束" rows={3} style={workflowFieldStyle} value={config.constraints}
          onChange={e => setConfig(old => ({ ...old, constraints: e.target.value }))} /></label>
        <label style={labelStyle}>Skills（每行一个已安装 ID）<textarea aria-label="Skills（每行一个已安装 ID）" rows={2} style={workflowFieldStyle}
          value={config.skills.join('\n')} onChange={e => setConfig(old => ({ ...old, skills: e.target.value.split('\n') }))} /></label>
        <WorkflowButton disabled={busy || !config.title.trim() || !backend || backend.enabled === false || blocked} onClick={onPreview}>预览副本创建计划</WorkflowButton>
      </div>
    </details>
    {blocked && <p role="alert" style={{ margin: 0, color: 'var(--theme-warning, #b7791f)' }}>有文件无法复制，请在下方选择要带入的文件，或处理后重新打开。</p>}
    <details style={sectionStyle} open={filesOpen} onToggle={event => setFilesOpen(event.currentTarget.open)}>
      <summary style={summaryStyle}>复制范围 <span style={{ ...helpStyle, fontWeight: 400 }}>· {config.snapshotMode === 'current' ? '当前项目内容' : `${config.includePaths.length} 条未提交路径`}</span></summary>
      <div style={{ ...fieldsStyle, marginTop: 14 }}>
        <p style={helpStyle}>默认带入当前修改、新文件和项目 Skills。依赖、缓存和构建产物等其他 Git 忽略文件不复制。聊天记录、队列和单次授权不复制。</p>
        <label style={labelStyle}>项目文件范围<select aria-label="项目文件范围" style={workflowFieldStyle} value={config.snapshotMode || 'selected'}
          onChange={e => setConfig(old => ({ ...old, snapshotMode: e.target.value as 'current' | 'selected', includePaths: e.target.value === 'current' ? repo.dirty.filter(row => !row.blocked).map(row => row.path) : old.includePaths }))}>
          <option value="current">当前项目内容（默认）</option><option value="selected">手动选择未提交路径</option>
        </select></label>
        {repo.dirty.length > 0 && <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {repo.dirty.map(row => <label key={row.path} style={{ display: 'flex', gap: 8, padding: '5px 0', overflowWrap: 'anywhere' }}>
            <input type="checkbox" style={{ flexShrink: 0 }} disabled={!!row.blocked || config.snapshotMode === 'current'} checked={config.includePaths.includes(row.path)}
              onChange={e => setConfig(old => ({ ...old, includePaths: e.target.checked ? [...old.includePaths, row.path] : old.includePaths.filter(path => path !== row.path) }))} />
            <span>{row.path}{row.blocked ? ` · ${row.blocked}` : ''}</span>
          </label>)}
        </div>}
      </div>
    </details>
  </fieldset>;
};

/** 技术明细按需展开；创建主界面只保留用户需要选择的配置。 */
export const TaskWorkspaceDetails: React.FC<{ task: TaskWorkspace }> = ({ task }) => <details style={sectionStyle}>
  <summary style={summaryStyle}>创建详情</summary>
  <div style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
    <p>目录：{task.root}</p><p>分支：{task.branch}</p>
    <p>来源提交：{task.repository.initialization ? `创建时建立首次提交（${task.repository.initialization.branch}）` : task.repository.head.slice(0, 12)}</p>
    {task.repository.initialization && <p>{task.notice}</p>}
    <p>Skills：{task.config.skills.filter(Boolean).join('、') || '无'}</p>
    <p style={{ whiteSpace: 'pre-wrap' }}>约束：{task.config.constraints || '无附加约束'}</p>
    {task.inherited && <>
      <p>继承 Prompts：{task.inherited.abilities?.prompts?.join('、') || '无'}；自动继续：{task.inherited.auto_continue ? '开启' : '关闭'}；自动提交 / 推送：{task.inherited.auto_commit ? '开启' : '关闭'} / {task.inherited.auto_commit_push ? '开启' : '关闭'}；输入建议：{task.inherited.followup_suggestions_enabled ? '开启' : '关闭'}</p>
      <p>Kit 工具：{task.inherited.abilities?.kitToolsMode || '默认'}；工作区工具：{task.inherited.abilities?.workspaceToolsMode || '默认'}。</p>
    </>}
    <details><summary style={summaryStyle}>项目 Skills 文件（{task.skillFiles?.length || 0}）</summary>{task.skillFiles?.map(row => <div key={row.path}>{row.path}</div>)}</details>
    <details><summary style={summaryStyle}>包含的未提交路径（{task.config.includePaths.length}）</summary>{task.config.includePaths.map(path => <div key={path}>{path}</div>)}</details>
  </div>
</details>;

import React, { useEffect, useState } from 'react';
import { BackendRuntimeFields, isRuntimeConfigurableBackend, isPoeBackend, type ModelRuntime } from './CodexRuntimeFields';
import { WorkflowButton, WorkflowPopover, workflowFieldStyle } from './WorkflowControls';
import type { FollowupConfig } from '../utils/followupSuggestions';

interface Props { config: FollowupConfig; supported: boolean; saving: boolean; notice: string; executor: string;
  backends: any[]; backendId: string; sessionRuntime?: ModelRuntime; onSave: (config: FollowupConfig) => Promise<boolean> }
const supportedTypes = new Set(['codex-office', 'qwen-code-cli', 'claude-agent-sdk', 'claude-code-official', 'openai-compatible', 'anthropic-api', 'deepseek-harness']);

export const FollowupSettings: React.FC<Props> = ({ config, supported, saving, notice, executor, backends, backendId, sessionRuntime, onSave }) => {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(config), [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(config); }, [config]);
  const available = backends.filter(item => item.enabled !== false && supportedTypes.has(item.type) && !isPoeBackend(item));
  const actual = available.find(item => item.id === (draft.backendId || backendId));
  const follows = !draft.backendId && !draft.model && !draft.reasoningEffort;
  const change = (patch: Partial<FollowupConfig>) => { setDraft(old => ({ ...old, ...patch })); setSaved(false); };
  const custom = !!(config.backendId || config.model || config.reasoningEffort);
  return <WorkflowPopover label="建议模型设置" title={custom ? '建议模型 · 自定' : '建议模型'}
    icon="settings" open={open} onOpenChange={setOpen} width={380}>
    {open && <>
      <p style={{ margin: '0 0 12px', color: 'var(--theme-text-muted)' }}>可为影子建议单独选用轻量模型，主对话模型保持不变。保存后用于后续回答。</p>
      {!supported ? <p role="status">当前节点尚未提供建议模型设置，请更新执行节点。</p> : <>
        <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <label>建议 Backend<select aria-label="建议 Backend" value={draft.backendId} style={workflowFieldStyle}
            onChange={event => change({ backendId: event.target.value, model: '', reasoningEffort: '' })}>
            <option value="">使用当前对话 Backend</option>
            {draft.backendId && !available.some(item => item.id === draft.backendId) && <option value={draft.backendId}>已不可用 · {draft.backendId}</option>}
            {available.map(item => <option key={item.id} value={item.id}>{item.label || item.id}{item.model ? ` · ${item.model}` : ''}</option>)}
          </select></label>
          {actual && <div style={{ marginTop: 12 }}>
            {isRuntimeConfigurableBackend(actual) ? <BackendRuntimeFields backend={actual} execKey={executor} compact
              inherited={follows ? sessionRuntime : undefined}
              value={{ model: draft.model, reasoningEffort: draft.reasoningEffort }}
              onChange={runtime => change({ model: runtime.model || '', reasoningEffort: runtime.reasoningEffort || '' })} />
              : <label>建议模型<input aria-label="建议模型" value={draft.model} maxLength={200} style={workflowFieldStyle}
                placeholder={!draft.backendId ? `跟随对话：${sessionRuntime?.model || actual.model || '默认模型'}` : actual.model ? `默认：${actual.model}` : '输入该服务支持的模型 ID'} onChange={event => change({ model: event.target.value })} /></label>}
          </div>}
          <p style={{ color: 'var(--theme-text-muted)', margin: '8px 0 12px' }}>全部留空时跟随主对话。{['codex-office', 'deepseek-harness'].includes(actual?.type)
            ? '指定模型后，推理档位使用上方选择或 Backend 默认值；建议选用较低档位以减少等待。'
            : '独立选择 Backend 后，模型留空使用其默认值；也可填写该服务支持的轻量模型 ID。'}</p>
          <label>最长等待<select aria-label="建议最长等待" value={draft.timeoutSeconds} style={workflowFieldStyle} onChange={event => change({ timeoutSeconds: Number(event.target.value) })}>
            <option value={30}>30 秒（默认）</option><option value={60}>60 秒</option><option value={120}>120 秒（慢网络）</option>
          </select></label>
          <p style={{ color: 'var(--theme-text-muted)' }}>等待包含启动和连接时间；超时不自动重试。独立调用计费，Tab 采纳只填入草稿。</p>
          <WorkflowButton tone="primary" disabled={!actual || saving} onClick={() => void onSave(draft).then(ok => { if (ok) setSaved(true); })}>
            {saving ? '保存中…' : '保存建议设置'}
          </WorkflowButton>
        </fieldset>
        {saved && <p role="status">已保存，下次回答完成后生效。</p>}
      </>}
      {notice && <p role="status" style={{ overflowWrap: 'anywhere' }}>{notice}</p>}
    </>}
  </WorkflowPopover>;
};

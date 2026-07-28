import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  WorkspaceKitState,
  WorkspaceKit,
  KitRun,
  KitInputSpec,
  KitAssertionSpec,
  KitOutputSpec,
} from '../types/workspaceKits';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

type Draft = Omit<WorkspaceKit, 'id' | 'lastRunId' | 'createdAt' | 'updatedAt'> & { id?: string };
type View = 'kits' | 'data';

const EMPTY_STATE: WorkspaceKitState = {
  sessionId: '',
  kits: [],
  runs: [],
  artifacts: [],
  dataMarket: [],
  terminalConnectedKitIds: [],
};

const newDraft = (): Draft => ({
  title: '新 Kit',
  description: '',
  command: "Write-Output 'hello kit'",
  shell: 'powershell',
  cwd: '.',
  timeoutSeconds: 300,
  inputs: [],
  assertions: [{ type: 'exit_code', expected: 0, label: '进程正常退出' }],
  outputs: [{ key: 'result', label: '运行结果', type: 'text', source: 'stdout' }],
  dependencies: [],
  schedule: { mode: 'manual', intervalSeconds: 300, nextRunAt: null },
  view: { default: 'summary', showLogs: true, showData: true, showTerminal: true },
  enabled: true,
  controlMode: 'shared',
});

const statusMeta: Record<string, { label: string; color: string }> = {
  queued: { label: '排队', color: '#8b949e' },
  running: { label: '执行中', color: '#d29922' },
  evaluating: { label: '验收中', color: '#58a6ff' },
  succeeded: { label: '成功', color: '#3fb950' },
  failed: { label: '失败', color: '#f85149' },
  error: { label: '异常', color: '#f85149' },
  cancelled: { label: '已停止', color: '#8b949e' },
};

function lastRunOf(state: WorkspaceKitState, kit: WorkspaceKit): KitRun | undefined {
  if (kit.lastRunId) {
    const exact = state.runs.find((run) => run.id === kit.lastRunId);
    if (exact) return exact;
  }
  return [...state.runs].reverse().find((run) => run.kitId === kit.id);
}

function asDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 5 }}>{children}</div>
);

export const WorkspaceKitsPanel: React.FC<Props> = ({ sessionId, open, onClose }) => {
  const [state, setState] = useState<WorkspaceKitState>({ ...EMPTY_STATE, sessionId });
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<View>('kits');
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [terminalCommand, setTerminalCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.kitGetState(sessionId).then((result) => {
      if (cancelled || result.status !== 'ok') {
        if (!cancelled && result.message) setNotice({ kind: 'error', text: result.message });
        return;
      }
      const next = result as WorkspaceKitState & { status: string };
      setState({
        sessionId,
        kits: next.kits || [],
        runs: next.runs || [],
        artifacts: next.artifacts || [],
        dataMarket: next.dataMarket || [],
        terminalConnectedKitIds: next.terminalConnectedKitIds || [],
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      });
      setSelectedId((current) => current || next.kits?.[0]?.id || '');
    });
    const off = api.onKitUpdated((next) => {
      if (next.sessionId !== sessionId) return;
      setState(next);
      setSelectedId((current) => current || next.kits[0]?.id || '');
    });
    return () => { cancelled = true; off(); };
  }, [open, sessionId]);

  useEffect(() => {
    setState({ ...EMPTY_STATE, sessionId });
    setSelectedId('');
    setDraft(null);
    setInputs({});
    setNotice(null);
  }, [sessionId]);

  const selected = state.kits.find((kit) => kit.id === selectedId);
  const lastRun = selected ? lastRunOf(state, selected) : undefined;
  const selectedRuns = useMemo(
    () => state.runs.filter((run) => run.kitId === selectedId).slice(-12).reverse(),
    [state.runs, selectedId],
  );

  useEffect(() => {
    if (!selected) { setInputs({}); return; }
    const defaults: Record<string, unknown> = {};
    selected.inputs.forEach((spec) => {
      if (spec.default !== undefined) defaults[spec.key] = spec.default;
    });
    setInputs(defaults);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    const result = draft.id
      ? await api.kitUpdate(sessionId, draft.id, draft)
      : await api.kitCreate(sessionId, draft);
    setBusy(false);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '保存失败' });
      return;
    }
    if (result.kit) setSelectedId(result.kit.id);
    setDraft(null);
    setNotice({ kind: 'ok', text: 'Kit 已保存' });
  };

  const runKit = async () => {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    const result = await api.kitRun(sessionId, selected.id, inputs);
    setBusy(false);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '启动失败' });
    }
  };

  const terminalRun = async () => {
    if (!selected || !terminalCommand.trim()) return;
    setBusy(true);
    const result = await api.kitTerminalCommand(sessionId, selected.id, terminalCommand);
    setBusy(false);
    if (result.status === 'ok') {
      setTerminalCommand('');
    } else {
      setNotice({ kind: 'error', text: result.message || '终端命令启动失败' });
    }
  };

  const deleteKit = async () => {
    if (!selected || !window.confirm(`删除 Kit「${selected.title}」？运行历史和已发布数据会保留。`)) return;
    const result = await api.kitDelete(sessionId, selected.id);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '删除失败' });
      return;
    }
    setSelectedId(state.kits.find((item) => item.id !== selected.id)?.id || '');
  };

  return (
    <div style={overlayStyle} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header style={headerStyle}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>🧰 Workspace Kits</strong>
              <span style={experimentBadge}>实验</span>
            </div>
            <div style={subtleStyle}>这个 Session 的标准配件、判言、视图窗与数据依赖</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={tabButton(view === 'kits')} onClick={() => setView('kits')}>配件</button>
            <button style={tabButton(view === 'data')} onClick={() => setView('data')}>
              数据市场 {state.dataMarket.length ? `· ${state.dataMarket.length}` : ''}
            </button>
            <button style={iconButton} onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        {notice && (
          <div style={{
            padding: '7px 12px', fontSize: 12,
            color: notice.kind === 'error' ? '#ff7b72' : '#56d364',
            background: notice.kind === 'error' ? 'rgba(248,81,73,.08)' : 'rgba(63,185,80,.08)',
          }}>{notice.text}</div>
        )}

        {view === 'data' ? (
          <DataMarket state={state} />
        ) : (
          <div style={bodyStyle}>
            <aside style={sidebarStyle}>
              <button
                style={{ ...primaryButton, width: '100%', marginBottom: 10 }}
                onClick={() => setDraft(newDraft())}
              >＋ 新建 Kit</button>
              {state.kits.length === 0 && (
                <div style={{ ...subtleStyle, padding: '18px 8px', textAlign: 'center' }}>
                  暂无配件。创建一个，把重复工作变成可验收的标准组件。
                </div>
              )}
              {state.kits.map((kit) => {
                const run = lastRunOf(state, kit);
                const meta = run ? statusMeta[run.status] : null;
                return (
                  <button
                    key={kit.id}
                    onClick={() => { setSelectedId(kit.id); setDraft(null); }}
                    style={{
                      ...kitListButton,
                      borderColor: selectedId === kit.id ? 'var(--theme-accent, #58a6ff)' : 'transparent',
                      background: selectedId === kit.id ? 'rgba(88,166,255,.10)' : 'transparent',
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, flex: '0 0 auto', borderRadius: '50%',
                      background: meta?.color || '#6e7681',
                      boxShadow: run?.status === 'running' ? `0 0 8px ${meta?.color}` : 'none',
                    }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{kit.title}</span>
                      <span style={{ ...subtleStyle, display: 'block', marginTop: 2 }}>
                        {kit.schedule.mode === 'interval' ? `每 ${kit.schedule.intervalSeconds}s` : '手动'}
                        {meta ? ` · ${meta.label}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </aside>

            <main style={mainStyle}>
              {draft ? (
                <KitEditor draft={draft} onChange={setDraft} onSave={saveDraft}
                  onCancel={() => setDraft(null)} busy={busy} />
              ) : selected ? (
                <KitDetail
                  kit={selected}
                  run={lastRun}
                  runs={selectedRuns}
                  inputs={inputs}
                  onInputsChange={setInputs}
                  onRun={runKit}
                  onCancel={(runId) => api.kitCancel(sessionId, runId)}
                  onEdit={() => setDraft({ ...selected })}
                  onDelete={deleteKit}
                  onToggleEnabled={() => api.kitUpdate(sessionId, selected.id, { enabled: !selected.enabled })}
                  onControlMode={(mode) => api.kitSetControlMode(sessionId, selected.id, mode)}
                  terminalCommand={terminalCommand}
                  onTerminalCommand={setTerminalCommand}
                  onTerminalRun={terminalRun}
                  terminalConnected={state.terminalConnectedKitIds?.includes(selected.id) || false}
                  onTerminalClose={() => api.kitTerminalClose(sessionId, selected.id)}
                  busy={busy}
                  dataMarket={state.dataMarket}
                />
              ) : (
                <div style={emptyMainStyle}>选择或创建一个 Kit</div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
};

const KitEditor: React.FC<{
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}> = ({ draft, onChange, onSave, onCancel, busy }) => {
  const patch = (value: Partial<Draft>) => onChange({ ...draft, ...value });
  const setInputs = (inputs: KitInputSpec[]) => patch({ inputs });
  const setAssertions = (assertions: KitAssertionSpec[]) => patch({ assertions });
  const setOutputs = (outputs: KitOutputSpec[]) => patch({ outputs });

  return (
    <div style={{ padding: 18, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={sectionTitle}>{draft.id ? '编辑 Kit' : '创建标准 Kit'}</div>
      <div style={twoColumns}>
        <label><FieldLabel>名称</FieldLabel>
          <input style={inputStyle} value={draft.title}
            onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label><FieldLabel>Shell</FieldLabel>
          <select style={inputStyle} value={draft.shell}
            onChange={(e) => patch({ shell: e.target.value as Draft['shell'] })}>
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
            <option value="bash">Bash</option>
          </select>
        </label>
      </div>
      <label style={blockLabel}><FieldLabel>说明</FieldLabel>
        <input style={inputStyle} value={draft.description}
          onChange={(e) => patch({ description: e.target.value })} />
      </label>
      <div style={twoColumns}>
        <label><FieldLabel>Session 内工作目录</FieldLabel>
          <input style={inputStyle} value={draft.cwd}
            onChange={(e) => patch({ cwd: e.target.value })} />
        </label>
        <label><FieldLabel>超时（秒）</FieldLabel>
          <input style={inputStyle} type="number" min={1} value={draft.timeoutSeconds}
            onChange={(e) => patch({ timeoutSeconds: Math.max(1, Number(e.target.value) || 300) })} />
        </label>
      </div>
      <label style={blockLabel}><FieldLabel>执行过程 · 用 {'{{input_key}}'} 引用标准输入</FieldLabel>
        <textarea style={{ ...inputStyle, minHeight: 96, fontFamily: 'Consolas, monospace' }}
          value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
      </label>

      <EditorGroup title="预定义输入" action="＋ 输入" onAction={() => setInputs([
        ...draft.inputs, { key: `input_${draft.inputs.length + 1}`, label: '输入', type: 'text' },
      ])}>
        {draft.inputs.map((item, index) => (
          <div key={index} style={editorRow}>
            <input style={miniInput} placeholder="key" value={item.key}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, key: e.target.value } : x))} />
            <input style={miniInput} placeholder="显示名" value={item.label || ''}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
            <select style={miniInput} value={item.type || 'text'}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, type: e.target.value as KitInputSpec['type'] } : x))}>
              <option value="text">文本</option><option value="number">数字</option>
              <option value="boolean">开关</option><option value="select">选项</option>
            </select>
            {item.type === 'select' && (
              <input style={miniInput} placeholder="选项，以逗号分隔" value={(item.options || []).join(',')}
                onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? {
                  ...x,
                  options: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                } : x))} />
            )}
            <input style={miniInput} placeholder="来源数据 key（可选）" value={item.sourceKey || ''}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, sourceKey: e.target.value } : x))} />
            <label style={tinyCheck}><input type="checkbox" checked={!!item.required}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, required: e.target.checked } : x))} />必填</label>
            <button style={dangerMini} onClick={() => setInputs(draft.inputs.filter((_, i) => i !== index))}>×</button>
          </div>
        ))}
      </EditorGroup>

      <EditorGroup title="成功 / 失败判言（至少一条）" action="＋ 判言" onAction={() => setAssertions([
        ...draft.assertions, { type: 'stdout_contains', expected: '', label: '输出包含' },
      ])}>
        {draft.assertions.map((item, index) => (
          <div key={index} style={editorRow}>
            <select style={miniInput} value={item.type}
              onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, type: e.target.value as KitAssertionSpec['type'] } : x))}>
              <option value="exit_code">退出码</option>
              <option value="stdout_contains">标准输出包含</option>
              <option value="stdout_regex">标准输出正则</option>
              <option value="stderr_contains">错误输出包含</option>
              <option value="stderr_regex">错误输出正则</option>
              <option value="json_valid">标准输出是 JSON</option>
              <option value="file_exists">文件存在</option>
            </select>
            <input style={{ ...miniInput, flex: 1 }} placeholder="名称" value={item.label || ''}
              onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
            <input style={{ ...miniInput, flex: 1 }} placeholder="期望值 / 相对路径" value={String(item.expected ?? item.path ?? '')}
              onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, expected: e.target.value } : x))} />
            <button style={dangerMini} disabled={draft.assertions.length <= 1}
              onClick={() => setAssertions(draft.assertions.filter((_, i) => i !== index))}>×</button>
          </div>
        ))}
      </EditorGroup>

      <EditorGroup title="发布到数据市场" action="＋ 输出" onAction={() => setOutputs([
        ...draft.outputs, { key: `output_${draft.outputs.length + 1}`, label: '结果', source: 'stdout', type: 'text' },
      ])}>
        {draft.outputs.map((item, index) => (
          <div key={index} style={editorRow}>
            <input style={miniInput} placeholder="数据 key" value={item.key}
              onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, key: e.target.value } : x))} />
            <input style={miniInput} placeholder="显示名" value={item.label || ''}
              onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
            <select style={miniInput} value={item.source || 'stdout'}
              onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, source: e.target.value as KitOutputSpec['source'] } : x))}>
              <option value="stdout">标准输出</option><option value="stderr">错误输出</option>
              <option value="json">JSON</option><option value="file">文件</option>
            </select>
            {item.source === 'file' && <input style={miniInput} placeholder="相对路径" value={item.path || ''}
              onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, path: e.target.value } : x))} />}
            <button style={dangerMini} onClick={() => setOutputs(draft.outputs.filter((_, i) => i !== index))}>×</button>
          </div>
        ))}
      </EditorGroup>

      <label style={blockLabel}><FieldLabel>硬数据依赖（数据 key，以逗号分隔；缺失时不执行）</FieldLabel>
        <input style={inputStyle} value={draft.dependencies.join(',')}
          onChange={(e) => patch({
            dependencies: e.target.value.split(',').map((value) => value.trim()).filter(Boolean),
          })} />
      </label>

      <div style={twoColumns}>
        <label><FieldLabel>触发方式</FieldLabel>
          <select style={inputStyle} value={draft.schedule.mode}
            onChange={(e) => patch({ schedule: { ...draft.schedule, mode: e.target.value as 'manual' | 'interval' } })}>
            <option value="manual">单次手动执行</option>
            <option value="interval">Schedule 周期执行</option>
          </select>
        </label>
        {draft.schedule.mode === 'interval' && (
          <label><FieldLabel>间隔秒数（最低 10）</FieldLabel>
            <input style={inputStyle} type="number" min={10} value={draft.schedule.intervalSeconds}
              onChange={(e) => patch({ schedule: { ...draft.schedule, intervalSeconds: Math.max(10, Number(e.target.value) || 300) } })} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button style={secondaryButton} onClick={onCancel}>取消</button>
        <button style={primaryButton} disabled={busy || !draft.command.trim()} onClick={onSave}>
          {busy ? '保存中…' : '保存 Kit'}
        </button>
      </div>
    </div>
  );
};

const EditorGroup: React.FC<{
  title: string; action: string; onAction: () => void; children: React.ReactNode;
}> = ({ title, action, onAction, children }) => (
  <section style={editorGroup}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <strong style={{ fontSize: 12 }}>{title}</strong>
      <button style={linkButton} onClick={onAction}>{action}</button>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>{children}</div>
  </section>
);

const KitDetail: React.FC<{
  kit: WorkspaceKit;
  run?: KitRun;
  runs: KitRun[];
  inputs: Record<string, unknown>;
  onInputsChange: (inputs: Record<string, unknown>) => void;
  onRun: () => void;
  onCancel: (runId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onControlMode: (mode: 'ai' | 'human' | 'shared') => void;
  terminalCommand: string;
  onTerminalCommand: (value: string) => void;
  onTerminalRun: () => void;
  terminalConnected: boolean;
  onTerminalClose: () => void;
  busy: boolean;
  dataMarket: WorkspaceKitState['dataMarket'];
}> = ({
  kit, run, runs, inputs, onInputsChange, onRun, onCancel, onEdit, onDelete,
  onToggleEnabled, onControlMode, terminalCommand, onTerminalCommand, onTerminalRun,
  terminalConnected, onTerminalClose, busy, dataMarket,
}) => {
  const running = !!run && ['queued', 'running', 'evaluating'].includes(run.status);
  const meta = run ? statusMeta[run.status] : null;
  return (
    <div style={{ padding: 18, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 17 }}>{kit.title}</h3>
            {meta && <span style={{ ...statusPill, color: meta.color, borderColor: `${meta.color}66` }}>● {meta.label}</span>}
            {!kit.enabled && <span style={mutedPill}>停用</span>}
          </div>
          {kit.description && <div style={{ ...subtleStyle, marginTop: 6 }}>{kit.description}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={secondaryButton} onClick={onToggleEnabled}>{kit.enabled ? '停用' : '启用'}</button>
          <button style={secondaryButton} onClick={onEdit}>编辑</button>
          <button style={{ ...secondaryButton, color: '#ff7b72' }} onClick={onDelete}>删除</button>
        </div>
      </div>

      <section style={cardStyle}>
        <div style={cardTitle}>标准输入</div>
        {kit.inputs.length === 0 ? (
          <div style={subtleStyle}>这个 Kit 没有运行时输入。</div>
        ) : (
          <div style={twoColumns}>
            {kit.inputs.map((spec) => (
              <label key={spec.key}>
                <FieldLabel>{spec.label || spec.key}{spec.required ? ' *' : ''}
                  {spec.sourceKey ? ` · 自动来源 ${spec.sourceKey}` : ''}</FieldLabel>
                {spec.type === 'boolean' ? (
                  <input type="checkbox" checked={!!inputs[spec.key]}
                    onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.checked })} />
                ) : spec.type === 'select' ? (
                  <select style={inputStyle} value={String(inputs[spec.key] ?? '')}
                    onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.value })}>
                    <option value="">请选择</option>
                    {(spec.options || []).map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                ) : (
                  <input style={inputStyle} type={spec.type === 'number' ? 'number' : 'text'}
                    placeholder={spec.placeholder || (spec.sourceKey ? '留空则取数据市场' : '')}
                    value={String(inputs[spec.key] ?? '')}
                    onChange={(e) => onInputsChange({
                      ...inputs,
                      [spec.key]: spec.type === 'number' ? Number(e.target.value) : e.target.value,
                    })} />
                )}
              </label>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
          <div style={subtleStyle}>
            {kit.schedule.mode === 'interval'
              ? `Schedule：每 ${kit.schedule.intervalSeconds} 秒 · 下次 ${kit.schedule.nextRunAt ? new Date(kit.schedule.nextRunAt * 1000).toLocaleString() : '待计算'}`
              : '单次执行'}
          </div>
          {running ? (
            <button style={dangerButton} onClick={() => onCancel(run.id)}>■ 停止</button>
          ) : (
            <button style={primaryButton} disabled={busy || !kit.enabled} onClick={onRun}>▶ 执行并验收</button>
          )}
        </div>
      </section>

      {run && (
        <section style={cardStyle}>
          <div style={cardTitle}>判言 · 用户看到的标准化结论</div>
          {run.assertions.length === 0 && running && <div style={subtleStyle}>执行完成后自动判定…</div>}
          {run.assertions.map((item, index) => (
            <div key={index} style={{ ...assertionRow, color: item.passed ? '#56d364' : '#ff7b72' }}>
              <span>{item.passed ? '●' : '●'}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={subtleStyle}>
                {item.message || `${asDisplay(item.actual)}${item.expected !== undefined ? ` / 期望 ${asDisplay(item.expected)}` : ''}`}
              </span>
            </div>
          ))}
          {run.error && <div style={{ color: '#ff7b72', fontSize: 12, marginTop: 8 }}>{run.error}</div>}
        </section>
      )}

      <section style={cardStyle}>
        <div style={cardTitle}>结果视图</div>
        {!run ? <div style={subtleStyle}>尚未运行。</div> : (
          <>
            <div style={runMetaGrid}>
              <span>退出码：{run.exitCode ?? '—'}</span>
              <span>触发：{run.trigger}</span>
              <span>操作者：{run.owner === 'ai' ? 'AI' : '人工'}</span>
              <span>目录：{run.cwd || kit.cwd}</span>
            </div>
            <LogBlock title="stdout" text={run.stdout} />
            <LogBlock title="stderr" text={run.stderr} tone="error" />
          </>
        )}
      </section>

      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 7 }}>
              终端接管 · 持久命令通道
              <span style={{ color: terminalConnected ? '#56d364' : '#8b949e', fontWeight: 400 }}>
                ● {terminalConnected ? '已连接' : '未连接'}
              </span>
            </div>
            <div style={subtleStyle}>AI 与人工操作同一个持久 Shell；目录、变量和进程上下文会保留，所有命令进入运行账本。</div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['ai', 'shared', 'human'] as const).map((mode) => (
              <button key={mode} style={tabButton(kit.controlMode === mode)} onClick={() => onControlMode(mode)}>
                {mode === 'ai' ? 'AI' : mode === 'human' ? '人工' : '共享'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
          <input style={{ ...inputStyle, fontFamily: 'Consolas, monospace' }}
            disabled={kit.controlMode === 'ai' || running}
            placeholder={kit.controlMode === 'ai' ? 'AI 已接管终端' : '输入一条命令…'}
            value={terminalCommand}
            onChange={(e) => onTerminalCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onTerminalRun(); }} />
          <button style={secondaryButton} disabled={kit.controlMode === 'ai' || running || !terminalCommand.trim()}
            onClick={onTerminalRun}>运行</button>
          {terminalConnected && (
            <button style={dangerButton} disabled={running} onClick={onTerminalClose}>断开</button>
          )}
        </div>
      </section>

      <section style={cardStyle}>
        <div style={cardTitle}>数据连接</div>
        <div style={subtleStyle}>
          依赖：{kit.dependencies.length ? kit.dependencies.join('、') : '无硬依赖'} ·
          可用数据：{dataMarket.length ? dataMarket.map((item) => item.key).join('、') : '暂无'}
        </div>
      </section>

      {runs.length > 1 && (
        <section style={cardStyle}>
          <div style={cardTitle}>最近运行</div>
          {runs.map((item) => {
            const itemMeta = statusMeta[item.status] || statusMeta.error;
            return <div key={item.id} style={historyRow}>
              <span style={{ color: itemMeta.color }}>● {itemMeta.label}</span>
              <span>{new Date(item.createdAt * 1000).toLocaleString()}</span>
              <span>{item.trigger} · {item.owner}</span>
            </div>;
          })}
        </section>
      )}
    </div>
  );
};

const LogBlock: React.FC<{ title: string; text: string; tone?: 'error' }> = ({ title, text, tone }) => (
  <details style={{ marginTop: 10 }} open={!!text}>
    <summary style={{ fontSize: 11, cursor: 'pointer', color: tone === 'error' ? '#ff7b72' : 'var(--theme-text-muted)' }}>
      {title} · {text ? `${text.length} 字符` : '空'}
    </summary>
    <pre style={{
      margin: '7px 0 0', padding: 10, maxHeight: 260, overflow: 'auto',
      borderRadius: 7, background: '#0d1117', color: tone === 'error' ? '#ff9b93' : '#c9d1d9',
      fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }}>{text || '（无输出）'}</pre>
  </details>
);

const DataMarket: React.FC<{ state: WorkspaceKitState }> = ({ state }) => (
  <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
    <div style={sectionTitle}>Session 数据市场</div>
    <div style={{ ...subtleStyle, marginBottom: 14 }}>
      每个成功运行可以发布带来源的类型化数据；其他 Kit 用输入的 sourceKey 声明依赖并自动消费最新版本。
    </div>
    {state.dataMarket.length === 0 ? (
      <div style={emptyMainStyle}>还没有数据。给 Kit 配置输出并成功运行一次。</div>
    ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        {state.dataMarket.map((item) => (
          <article key={item.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{item.label}</strong>
              <code style={dataKeyStyle}>{item.key}</code>
            </div>
            <div style={{ ...subtleStyle, marginTop: 6 }}>
              {item.type} · {new Date(item.createdAt * 1000).toLocaleString()}
            </div>
            <pre style={dataPreviewStyle}>{asDisplay(item.value).slice(0, 1600)}</pre>
            <div style={{ ...subtleStyle, marginTop: 7 }}>Kit {item.kitId.slice(0, 8)} · Run {item.runId.slice(0, 8)}</div>
          </article>
        ))}
      </div>
    )}
  </div>
);

const overlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 80,
  background: 'rgba(0,0,0,.38)', display: 'flex', justifyContent: 'flex-end',
};
const panelStyle: React.CSSProperties = {
  width: 'min(920px, 96%)', height: '100%', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg, #161b22)', color: 'var(--theme-text, #e6edf3)',
  borderLeft: '1px solid var(--theme-border)', boxShadow: '-10px 0 35px rgba(0,0,0,.28)',
};
const headerStyle: React.CSSProperties = {
  minHeight: 60, padding: '10px 14px', boxSizing: 'border-box',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  borderBottom: '1px solid var(--theme-border)',
};
const bodyStyle: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const sidebarStyle: React.CSSProperties = {
  width: 220, flex: '0 0 220px', padding: 10, overflow: 'auto',
  borderRight: '1px solid var(--theme-border)', boxSizing: 'border-box',
};
const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0 };
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 650, marginBottom: 14 };
const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 650, marginBottom: 9 };
const subtleStyle: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted, #8b949e)' };
const cardStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border, rgba(255,255,255,.12))',
  background: 'var(--theme-bg-secondary, rgba(255,255,255,.025))',
  borderRadius: 9, padding: 12, marginTop: 12,
};
const experimentBadge: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 9,
  color: '#d2a8ff', border: '1px solid rgba(210,168,255,.35)', background: 'rgba(210,168,255,.08)',
};
const statusPill: React.CSSProperties = { fontSize: 10, border: '1px solid', padding: '2px 7px', borderRadius: 10 };
const mutedPill: React.CSSProperties = { ...statusPill, color: '#8b949e', borderColor: '#6e768166' };
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', borderRadius: 6, padding: '7px 9px',
  color: 'var(--theme-text)', background: 'var(--theme-bg-tertiary, #0d1117)',
  border: '1px solid var(--theme-border)', fontSize: 12, outline: 'none',
};
const miniInput: React.CSSProperties = { ...inputStyle, width: 'auto', minWidth: 80, flex: '0 1 150px', padding: '5px 7px' };
const twoColumns: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 };
const blockLabel: React.CSSProperties = { display: 'block', marginTop: 10 };
const editorGroup: React.CSSProperties = { ...cardStyle, marginTop: 14 };
const editorRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const tinyCheck: React.CSSProperties = { fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' };
const primaryButton: React.CSSProperties = {
  border: '1px solid rgba(88,166,255,.65)', background: 'rgba(88,166,255,.16)',
  color: 'var(--theme-text)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 12,
};
const secondaryButton: React.CSSProperties = {
  border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary, rgba(255,255,255,.04))',
  color: 'var(--theme-text)', borderRadius: 7, padding: '6px 10px', cursor: 'pointer', fontSize: 11,
};
const dangerButton: React.CSSProperties = { ...secondaryButton, borderColor: 'rgba(248,81,73,.5)', color: '#ff7b72' };
const dangerMini: React.CSSProperties = { ...secondaryButton, color: '#ff7b72', padding: '4px 7px' };
const linkButton: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--theme-accent, #58a6ff)', cursor: 'pointer', fontSize: 11 };
const iconButton: React.CSSProperties = { ...secondaryButton, fontSize: 18, padding: '1px 9px' };
const tabButton = (active: boolean): React.CSSProperties => ({
  ...secondaryButton,
  color: active ? 'var(--theme-accent, #58a6ff)' : 'var(--theme-text-muted)',
  borderColor: active ? 'rgba(88,166,255,.45)' : 'var(--theme-border)',
  background: active ? 'rgba(88,166,255,.10)' : 'transparent',
});
const kitListButton: React.CSSProperties = {
  width: '100%', display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left',
  color: 'var(--theme-text)', border: '1px solid transparent', borderRadius: 7,
  padding: '9px 7px', cursor: 'pointer', marginBottom: 4,
};
const emptyMainStyle: React.CSSProperties = {
  height: '100%', minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--theme-text-muted)', fontSize: 12,
};
const assertionRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
  borderBottom: '1px solid var(--theme-border)', fontSize: 12,
};
const runMetaGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6,
  fontSize: 11, color: 'var(--theme-text-muted)',
};
const historyRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '80px 1fr 110px', gap: 8,
  padding: '6px 0', fontSize: 11, borderBottom: '1px solid var(--theme-border)',
};
const dataKeyStyle: React.CSSProperties = {
  fontSize: 10, color: '#79c0ff', background: 'rgba(88,166,255,.1)', padding: '2px 5px', borderRadius: 4,
};
const dataPreviewStyle: React.CSSProperties = {
  margin: '9px 0 0', padding: 8, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
  wordBreak: 'break-word', borderRadius: 6, background: '#0d1117', color: '#c9d1d9', fontSize: 10,
};

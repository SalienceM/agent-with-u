import React from 'react';
import { WorkflowButton as BaseWorkflowButton, workflowFieldStyle, workflowNoticeStyle } from './WorkflowControls';
import { useProjectMergeWorkflow } from '../hooks/useProjectMergeWorkflow';
import { normalizeRelativeFilePath } from '../utils/fileFocus';
import type { MergeDiagnostic } from '../types/taskWorkspaces';
import { ProjectMergeRepair } from './ProjectMergeRepair';

const labels: Record<string, string> = { preview: '待确认准备', blocked: '需要处理', preparing: '准备中', conflict: '待解决冲突', candidate: '审阅候选', applying: '应用中', succeeded: '已完成', unknown: '结果未知', error: '失败', cancelled: '已取消' };
const testStates: Record<string, string> = { unknown: '未验证', passed: '有通过记录', failed: '存在失败', stale: '证据已过期' };
const mutedStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 12 };
const detailStyle: React.CSSProperties = { borderTop: '1px solid var(--theme-border)', padding: '12px 0', marginTop: 8 };
const tagStyle: React.CSSProperties = { ...mutedStyle, padding: '3px 8px', borderRadius: 6, background: 'var(--theme-bg-tertiary)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const WorkflowButton: React.FC<React.ComponentProps<typeof BaseWorkflowButton>> = ({ style, ...props }) =>
  <BaseWorkflowButton {...props} style={{ minHeight: 36, padding: '8px 14px', fontSize: 13, ...(props.tone === 'primary' ? { fontWeight: 600 } : {}), ...style }} />;
const diagnosticHelp = (entry: MergeDiagnostic, side: string) => {
  if (entry.code === 'git_dirty') return `先在 ${side} 提交需要合入的改动，再重新预览。`;
  if (entry.code === 'buffer_dirty') return `先打开${side}保存未保存的编辑内容，再检查是否需要提交。`;
  if (entry.code === 'activity') return `等待${side}的运行实际结束，再刷新状态。切换页面不会停止运行。`;
  if (entry.code === 'changed') return `${side}已与原计划不同，需要按当前内容重新预览。原记录和成果会保留。`;
  return `打开${side}核对原因；状态未知时不能继续合并。`;
};
interface Props { session: string; executor: string; onOpenSession?: (id: string) => void; fixedTarget?: string;
  entrySession?: string; entryRole?: string; onBackToEntry?: () => void;
  initialOperation?: string; onOpenOrigin?: (session: string, operation: string, parent?: string) => void }
export const ProjectMergePanel: React.FC<Props> = ({ session, executor, onOpenSession, fixedTarget, initialOperation, onOpenOrigin, entrySession = session, entryRole, onBackToEntry }) => {
  const c = useProjectMergeWorkflow(session, executor, fixedTarget, initialOperation);
  const { row, draft, busy, uncertain, online } = c;
  const [tab, setTab] = React.useState<'overview' | 'files'>('overview');
  React.useEffect(() => setTab('overview'), [row?.id]);
  const own = row?.sourceSessionId === session, workflow = row?.workflow;
  const readBlocked = busy || uncertain || !online || !own;
  const blocked = readBlocked || !c.readReady;
  const verified = workflow ? workflow.gitVerified : row?.verification.status === 'git_verified' && row?.verification.head === row?.candidate;
  const diagnostics = workflow?.diagnostics || [];
  const syncing = row?.direction === 'sync_main';
  const sourceTitle = workflow?.sides.source?.title || row?.source.title;
  const targetTitle = workflow?.sides.target?.title || row?.target.title;
  const shortTitle = (title?: string) => title?.split(' · ').pop() || '';
  const sourceIsMain = syncing || entryRole === '主干' && row?.source.sessionId === entrySession;
  const targetIsMain = !syncing && !!fixedTarget || entryRole === '主干' && row?.target.sessionId === entrySession;
  const sides = { source: sourceIsMain ? '主干' : shortTitle(sourceTitle) || '来源分支', target: targetIsMain ? '主干' : shortTitle(targetTitle) || '目标分支', integration: '处理空间' };
  const pairMatches = row && (row.source.sessionId === session && row.target.sessionId === fixedTarget || row.source.sessionId === fixedTarget && row.target.sessionId === session);
  const canSync = c.branchSync && fixedTarget && (!row || own && pairMatches && ['succeeded', 'cancelled', 'error', 'blocked'].includes(row.status));
  const syncMain = () => { if (canSync && !busy && !uncertain && online) void c.preview({ source: fixedTarget!, target: session }); };
  const activeDiagnostics = row && !['succeeded', 'cancelled'].includes(row.status) ? diagnostics : [];
  const repairManaged = c.mergeRepair && !!row?.integration;
  const repairBusy = repairManaged && ['running', 'unknown'].includes(row?.repair?.status || '');
  const externalDiagnostics = activeDiagnostics.filter(entry => !repairManaged || entry.side !== 'integration' || !['git_dirty', 'activity'].includes(entry.code));
  const firstIssue = externalDiagnostics[0];
  const needsNewPreview = row && (row.status === 'blocked' && !row.integration || activeDiagnostics.some(entry => entry.code === 'changed'));
  const waiting = uncertain || row?.status === 'unknown' || row?.status === 'preparing' || row?.status === 'applying';
  const finished = row?.status === 'succeeded' || row?.status === 'cancelled';
  const comparison = workflow?.comparison;
  const summary = c.history.find(item => item.id === draft.selected);
  const currentPair = !!pairMatches && comparison?.state === 'known'
    && Number.isInteger(comparison.sourceAhead) && comparison.sourceAhead! >= 0
    && Number.isInteger(comparison.targetAhead) && comparison.targetAhead! >= 0;
  const branchIsSource = row?.source.sessionId === session;
  const branchAhead = currentPair ? (branchIsSource ? comparison!.sourceAhead! : comparison!.targetAhead!) : 0;
  const mainAhead = currentPair ? (branchIsSource ? comparison!.targetAhead! : comparison!.sourceAhead!) : 0;
  const branchDirty = !!workflow?.sides[branchIsSource ? 'source' : 'target']?.dirty.length;
  const operationTitle = row?.sourceSessionId === row?.source.sessionId ? shortTitle(sourceTitle) : row?.sourceSessionId === row?.target.sessionId ? shortTitle(targetTitle) : '原会话';
  const canContinue = !!canSync && row?.status === 'succeeded';
  const nextRound = !canContinue ? '' : currentPair
    ? branchAhead > 0 || branchDirty ? 'merge' : mainAhead > 0 ? 'sync' : 'return'
    : syncing ? 'merge' : 'sync';
  const mergeCurrent = () => { if (canContinue && !blocked) void c.preview({ source: session, target: fixedTarget! }); };
  const repreview = () => { if (row && !blocked && !waiting) void c.preview({ source: row.source.sessionId, target: row.target.sessionId }); };
  const openFile = (sessionId: string, root: string, path: string) => {
    const relativePath = normalizeRelativeFilePath(path);
    if (!relativePath || !sessionId || !root) return;
    window.dispatchEvent(new CustomEvent('awu:merge-file-focus', { detail: { sessionId, workingDir: root, relativePath, executor } }));
    onOpenSession?.(sessionId);
  };
  const newPreview = () => { if (fixedTarget) c.change({ source: session, target: fixedTarget }); else if (row) c.change({ source: row.source.sessionId, target: row.target.sessionId }); c.select(''); };
  const frozenPlan = row && <>
    <p>来源：{row.source.title} · {row.source.branch || '游离 HEAD'} · {row.source.head.slice(0, 12)}<br />
      目标：{row.target.title} · {row.target.branch || '游离 HEAD'} · {row.target.head.slice(0, 12)}</p>
    <p>来源目录：{row.source.root}<br />目标目录：{row.target.root}</p>
    <p>处理空间 Backend：{row.integrationConfig.backendId} · {row.integrationConfig.model || '默认模型'} · {row.integrationConfig.reasoningEffort || '默认推理档位'} · 保留执行确认</p>
    <p>{row.policy}</p>
    <details><summary>变化文件（{row.files.length}）</summary>{row.files.map(file => <div key={file}>{file}</div>)}</details>
  </>;
  return <section aria-label="连续合并流程" style={{ minWidth: 0, minHeight: 0, flex: 1, overflow: 'auto', padding: '20px clamp(14px, 3vw, 32px)', overflowWrap: 'anywhere', fontWeight: 400 }}>
    {c.loading && <p role="status">正在恢复已有合并记录…</p>}
    {!draft.selected ? <>
      <h3>{c.history.filter(item => !['succeeded', 'cancelled', 'error'].includes(item.status)).length > 1 ? '请选择要继续的合并请求' : '新建合并请求'}</h3>
      {fixedTarget ? <p style={mutedStyle}>预览已提交差异，再确认合并。</p> : <>
        <label>查找会话<input value={draft.query} onChange={e => c.change({ query: e.target.value })} style={workflowFieldStyle} /></label>
        <WorkflowButton disabled={busy || !online} onClick={() => void c.discover()}>发现项目会话</WorkflowButton>
        {(['source', 'target'] as const).map(side => <label key={side} style={{ display: 'block', margin: '12px 0' }}>{side === 'source' ? '来源会话' : '目标会话'}
          <select aria-label={side === 'source' ? '来源会话' : '目标会话'} value={draft[side]} style={workflowFieldStyle} onChange={e => c.change({ [side]: e.target.value })}>
            <option value="">请选择真实会话</option>{c.items.map(item => <option key={item.id} value={item.id}>{item.title} · {item.id} · {item.workingDir}</option>)}
          </select></label>)}
      </>}
      <WorkflowButton tone="primary" disabled={busy || c.loading || !online || !draft.source || !draft.target || draft.source === draft.target} onClick={() => void c.preview()}>{fixedTarget ? '预览合并到主 Session' : '预览汇合计划'}</WorkflowButton>
      {canSync && <WorkflowButton disabled={busy || c.loading || !online || uncertain} onClick={syncMain}>同步主干到此分支</WorkflowButton>}
    </> : row ? <>
      {onBackToEntry && <div aria-label="操作会话" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <span style={tagStyle}>正在操作：{operationTitle}</span>
        <WorkflowButton tone="quiet" disabled={busy} onClick={onBackToEntry}>返回{entryRole === '主干' ? '主干' : '入口'}记录</WorkflowButton>
      </div>}
      <header style={{ marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>{sourceTitle} <span style={mutedStyle}>→</span> {targetTitle}</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={tagStyle}>{row.status === 'succeeded' ? '上次操作 · ' : ''}{syncing ? '同步主干' : '分支合并'}</span>
          <span style={tagStyle} title={row.target.branch}>目标：{sides.target} · {row.target.branch || '未知分支'}</span>
          <span style={tagStyle}>{repairBusy ? row.repair?.status === 'running' ? '修复中' : '待核对运行状态' : labels[row.status] || row.status}</span>
          <span style={mutedStyle}>{row.status === 'succeeded' ? '上次变化' : '本次预览的已提交差异'}：{row.files.length} 个文件</span>
          {syncing && !finished && <span style={mutedStyle}>{row.fastForward ? '可直接快进' : '保留双方提交'}</span>}
        </div>
        <div aria-label="合并方向" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12, marginTop: 16 }}>
          {(['source', 'target'] as const).map(side => <div key={side} style={{ padding: '12px 14px', border: '1px solid var(--theme-border)', borderRadius: 8, minWidth: 0 }}>
            <div style={mutedStyle}>{side === 'source' ? '来源分支 · 合入内容' : '目标分支 · 接收变更'}</div>
            <strong style={{ display: 'block', margin: '4px 0' }}>{side === 'source' ? sourceTitle : targetTitle}</strong>
            <code style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{row[side].branch || '游离 HEAD'}</code>
          </div>)}
        </div>
      </header>
      <nav aria-label="合并请求视图" style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--theme-border)', paddingBottom: 10, marginBottom: 18 }}>
        <WorkflowButton aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>概览</WorkflowButton>
        <WorkflowButton aria-pressed={tab === 'files'} onClick={() => setTab('files')}>变更文件（{row.files.length}）</WorkflowButton>
        {c.checking && <span role="status" style={{ ...mutedStyle, marginLeft: 'auto', alignSelf: 'center' }}>正在核对当前状态…</span>}
      </nav>
      {tab === 'files' && <section aria-label="合并变更文件">
        <p style={mutedStyle}>本次计划中的已提交变化。打开文件可在对应分支查看内容。</p>
        {row.files.length === 0 ? <p>没有已提交的文件差异。</p> : row.files.map(path => <div key={path} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--theme-border)' }}>
          <code style={{ flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere' }}>{path}</code>
          <WorkflowButton disabled={!onOpenSession} onClick={() => openFile(row.source.sessionId, row.source.root, path)}>来源文件</WorkflowButton>
          <WorkflowButton disabled={!onOpenSession} onClick={() => openFile(row.target.sessionId, row.target.root, path)}>目标文件</WorkflowButton>
        </div>)}
      </section>}
      <div hidden={tab !== 'overview'}>
      {!own && !finished && <div style={workflowNoticeStyle}>正在查看 {operationTitle} 发起的合并（关联记录 · 只读）
        <WorkflowButton tone="primary" disabled={!onOpenOrigin || busy} onClick={() => onOpenOrigin?.(row.sourceSessionId, row.id,
          entryRole === '主干' && [row.source.sessionId, row.target.sessionId].includes(entrySession) ? entrySession : undefined)}>进入 {operationTitle} 合并</WorkflowButton>
      </div>}
      <div aria-label="下一步" hidden={!!repairManaged && !firstIssue && !waiting && (row.status === 'conflict' || !!repairBusy)} style={{ padding: '18px 20px', borderRadius: 12, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)', marginBottom: 16, position: 'relative' }}>
        <WorkflowButton tone="quiet" icon="refresh" aria-label="核对原操作" title="刷新此条合并的状态" disabled={busy || !online} onClick={c.refresh} style={{ float: 'right', margin: '-5px -8px 4px 8px' }} />
        {!online ? <><strong>执行节点离线，暂时不能继续</strong><p style={mutedStyle}>连接恢复后刷新状态。</p></>
          : waiting ? <><strong>{uncertain || row.status === 'unknown' ? '提交结果待核对' : row.status === 'preparing' ? '正在准备合并' : '正在应用合并'}</strong><p style={mutedStyle}>等待原操作结果，或点击刷新核对。</p></>
          : repairBusy ? <><strong>{row.repair?.status === 'running' ? '正在处理本次合并' : '修复运行状态待核对'}</strong><p style={mutedStyle}>进度和必要确认显示在下方，完成后回到本次合并确认。</p></>
          : firstIssue || row.status === 'blocked' ? <>
            <strong>{firstIssue ? `${sides[firstIssue.side]}${firstIssue.code === 'git_dirty' ? firstIssue.paths?.length ? ` 有 ${firstIssue.paths.length} 个未提交文件` : ' 有未提交改动' : firstIssue.code === 'changed' ? ' 已变化，请重新预览' : `：${firstIssue.notice}`}` : row.blockers[0] || row.notice || '需要先处理阻塞'}</strong>
            <p>{firstIssue ? diagnosticHelp(firstIssue, sides[firstIssue.side]) : '请核对下方阻塞详情。处理后重新预览当前内容，再确认准备。'}</p>
            {row.files.length === 0 && activeDiagnostics.some(entry => entry.code === 'git_dirty') && <p style={mutedStyle}>未提交改动尚未计入本次预览。</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {firstIssue?.sessionId && <WorkflowButton tone="primary" disabled={!onOpenSession} onClick={() => onOpenSession?.(firstIssue.sessionId)}>打开 {sides[firstIssue.side]}</WorkflowButton>}
              {own && needsNewPreview && <WorkflowButton disabled={blocked} onClick={repreview}>重新预览合并</WorkflowButton>}
            </div>
          </> : row.status === 'preview' ? <><strong>待确认准备</strong><p style={mutedStyle}>在独立空间准备候选，目标分支暂不变更。</p></>
          : row.status === 'conflict' ? <><strong>需要解决冲突</strong><p style={mutedStyle}>{repairManaged ? '在下方启动修复，系统会处理冲突并生成候选提交。' : '此节点尚不支持请求内修复，可通过下方兼容入口处理。'}</p></>
          : row.status === 'candidate' ? <><strong>{verified ? '候选已就绪' : '待核对候选'}</strong><p style={mutedStyle}>{verified ? '确认下方计划后更新目标分支。' : '核对冲突、工作树和提交历史。'}</p></>
          : row.status === 'error' ? <><strong>本次操作失败</strong><p>{row.notice || '请查看原操作结果。'}{row.applyRequestId && row.integration && row.candidate ? '可重新核对原候选。' : '可在“变更与验证详情”中重新预览。'}</p></>
          : <><strong style={{ fontSize: 18, fontWeight: 600 }}>{row.status === 'succeeded'
              ? currentPair ? branchAhead > 0 ? '当前分支有新提交' : mainAhead > 0 ? '主干有新提交' : '已提交内容与主干一致'
                : syncing ? '上次同步已完成' : '上次合并已完成'
              : labels[row.status] || row.status}</strong>
            <p style={mutedStyle}>{row.status === 'succeeded'
              ? currentPair ? `待合入主干 ${branchAhead} 个提交 · 待同步主干 ${mainAhead} 个提交`
                : '这是上次操作的回执。当前分支状态尚未确认，可刷新或预览本轮操作。'
              : '成果和历史记录已保留。'}</p>
            {row.status === 'succeeded' && branchDirty && <p style={mutedStyle}>当前分支还有未提交改动，提交后再合入。</p>}
            {nextRound === 'merge' && <WorkflowButton tone="primary" disabled={blocked} onClick={mergeCurrent}>预览本轮合并到主干</WorkflowButton>}
            {nextRound === 'sync' && <WorkflowButton tone="primary" disabled={blocked} onClick={syncMain}>同步主干到此分支</WorkflowButton>}
            {nextRound === 'return' && <WorkflowButton tone="primary" disabled={!onOpenSession} onClick={() => onOpenSession?.(session)}>返回此分支继续开发</WorkflowButton>}
            {row.status === 'succeeded' && !canContinue && <WorkflowButton tone="primary" disabled={!onOpenSession} onClick={() => onOpenSession?.(row.target.sessionId)}>返回目标 Session</WorkflowButton>}
            {row.status === 'succeeded' && row.finalHead && <div style={{ ...mutedStyle, marginTop: 14 }}>上次{syncing ? '同步' : '合并'}提交 <code title={row.finalHead}>{row.finalHead.slice(0, 12)}</code></div>}
          </>}
        <div style={{ clear: 'both' }} />
      </div>
      {own && row.status === 'candidate' && !verified && <WorkflowButton tone="primary" disabled={readBlocked || waiting || repairBusy} onClick={() => void c.action('Verify')}>核对实际 Git 候选</WorkflowButton>}
      {own && row.status === 'error' && row.applyRequestId && row.integration && row.candidate && <WorkflowButton tone="primary" disabled={readBlocked} onClick={() => void c.action('Verify')}>重新核对原候选</WorkflowButton>}
      {repairManaged && row.integration && (row.status === 'conflict' || !!row.startRequestId || activeDiagnostics.some(entry => entry.side === 'integration' && entry.code === 'git_dirty')) && <ProjectMergeRepair key={`${executor}:${session}:${row.id}`} session={session} executor={executor} row={row}
        disabled={blocked || !!firstIssue} active={tab === 'overview'} onStart={() => void c.action('Start')} />}
      {!repairManaged && row.status === 'conflict' && row.integration && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <WorkflowButton tone="primary" disabled={!row.integration.sessionId || !onOpenSession} onClick={() => onOpenSession?.(row.integration!.sessionId)}>打开处理空间</WorkflowButton>
        {own && !row.startRequestId && <WorkflowButton disabled={blocked} onClick={() => void c.action('Start')}>明确启动冲突修复与验证</WorkflowButton>}
      </div>}
      {row.status === 'candidate' && verified && <div aria-label="应用确认计划" style={{ ...workflowNoticeStyle, marginTop: 12 }}>
        <strong>第二次确认：合并到原目标</strong>
        <p>{row.target.title} · 分支 {row.target.branch}<br />{row.target.root}<br />{row.target.head.slice(0, 12)} → {row.candidate?.slice(0, 12)}</p>
        <p>仅快进该目标；来源、处理空间和历史保留。项目测试：{testStates[workflow?.tests.state || 'unknown']}。</p>
        <WorkflowButton tone="primary" disabled={blocked || repairBusy || diagnostics.length > 0} onClick={() => void c.action('Apply')}>确认快进应用到目标</WorkflowButton>
      </div>}
      {row.status === 'preview' ? <div aria-label="准备确认计划" style={workflowNoticeStyle}>
        <strong>{c.mergeRepair ? '第一次确认：准备本次合并' : '第一次确认：准备独立处理空间'}</strong>
        <p>{row.source.title} → {row.target.title} · {row.target.branch}<br />{row.source.head.slice(0, 12)} → 独立候选</p>
        <WorkflowButton tone="primary" disabled={blocked || diagnostics.length > 0} onClick={() => void c.action('Prepare')}>{c.mergeRepair ? '确认准备合并' : '确认准备独立整合空间'}</WorkflowButton>
        <details style={{ marginTop: 8 }}><summary>查看完整准备计划与变化文件</summary>{frozenPlan}</details>
      </div> : null}
      {externalDiagnostics.length ? <div aria-label="需要处理" style={{ marginTop: 12 }}>
        {externalDiagnostics.map((entry, i) => (i > 0 || !!entry.paths?.length) && <div key={i} style={{ ...workflowNoticeStyle, marginBottom: 8 }}>
          {i > 0 && <><strong>{sides[entry.side]}：{entry.notice}</strong>
          {entry.sessionId && <WorkflowButton tone="quiet" disabled={!onOpenSession} onClick={() => onOpenSession?.(entry.sessionId)}>打开对应 Session</WorkflowButton>}</>}
          {!!entry.paths?.length && <details><summary>查看 {sides[entry.side]} 的文件（{entry.paths.length}）</summary>
          <p style={{ fontSize: 12 }}>目录：{entry.root || '详情不可用'}</p>
          {entry.paths.slice(0, 20).map(file => <div key={file.path}>
            <WorkflowButton tone="quiet" disabled={!entry.sessionId || !entry.root || !onOpenSession} onClick={() => openFile(entry.sessionId, entry.root || '', file.path)}>{file.path}</WorkflowButton>
            <span> · {file.untracked ? '未跟踪' : file.status === 'buffer' ? '未保存缓冲' : [file.index && '暂存区', file.worktree && '工作树'].filter(Boolean).join(' / ') || file.status}</span>
          </div>)}
          {entry.paths.length > 20 && <details><summary>其余 {entry.paths.length - 20} 个路径</summary>{entry.paths.slice(20).map(file => <div key={file.path}><WorkflowButton tone="quiet" disabled={!entry.sessionId || !entry.root || !onOpenSession} onClick={() => openFile(entry.sessionId, entry.root || '', file.path)}>{file.path}</WorkflowButton> · {file.status}</div>)}</details>}
          </details>}
        </div>)}
      </div> : !finished && row.blockers.slice(row.status === 'blocked' ? 1 : 0).map((text, i) => <p key={i}>{text}</p>)}
      {row.integration && <>
        {!finished && row.integration.conflicts.map(file => <div key={file}>冲突：{file}</div>)}
        <div style={{ ...mutedStyle, display: 'flex', flexWrap: 'wrap', gap: '8px 20px', alignItems: 'center', margin: '16px 0' }}>
          <span aria-label="Git 核对">{finished ? '上次操作 ' : ''}Git：{verified ? '已核对' : '未核对'}</span>
          <span aria-label="项目测试" title="Git 核对与项目测试分别记录" role={workflow?.tests.state === 'failed' ? 'alert' : undefined}>{finished ? '上次操作 ' : ''}项目测试：{testStates[workflow?.tests.state || 'unknown'] || '未验证'}</span>
          {workflow && <span title="返回页面或点击刷新时核对">{new Date(workflow.checkedAt * 1000).toLocaleTimeString()} 更新</span>}
        </div>
      </>}
      {row.status === 'succeeded' && !row.finalHead && <p>旧成功记录缺少最终提交，请核对原回执。</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {own && (row.status === 'conflict' || row.status === 'candidate' && verified) && <WorkflowButton tone="quiet" disabled={readBlocked} onClick={() => void c.action('Verify')}>核对实际 Git 候选</WorkflowButton>}
      </div>
      <details style={detailStyle}><summary style={{ cursor: 'pointer', fontWeight: 500 }}>变更与验证详情</summary>
        {row.status !== 'preview' && frozenPlan}
        {row.status === 'succeeded' && row.finalHead && <p>已更新原目标 {row.target.title} 的 {row.target.branch} 分支<br />最终提交：{row.finalHead}</p>}
        {row.notice && <p>{row.notice}</p>}
        {!!workflow?.tests.items.length && <details><summary>查看测试证据</summary>{workflow.tests.items.map((test, i) => <p key={i}>{test.name} · {testStates[test.state]} · 退出码 {test.exitCode} · {new Date(test.finishedAt * 1000).toLocaleString()}<br />候选 {test.candidate}<br />原日志：{test.logRef}</p>)}</details>}
        {row.integration && <WorkflowButton tone="quiet" disabled={!row.integration.sessionId || !onOpenSession} onClick={() => onOpenSession?.(row.integration!.sessionId)}>查看整合记录与测试日志</WorkflowButton>}
        <p>操作：{row.id}<br />发起 Session：{row.sourceSessionId}<br />处理目录：{row.integration?.root || '尚未准备'}</p>
        <p>{row.verification.notice}</p>
        {canSync && row.status !== 'succeeded' && <WorkflowButton disabled={blocked || waiting} onClick={syncMain}>同步主干到此分支</WorkflowButton>}
        {own && !['applying', 'preparing', 'unknown', 'succeeded', 'cancelled'].includes(row.status) && <WorkflowButton disabled={blocked} onClick={() => void c.action('Cancel')}>取消后续汇合（保留成果）</WorkflowButton>}
        {own && ['blocked', 'error', 'cancelled'].includes(row.status) && <WorkflowButton disabled={busy || uncertain} onClick={newPreview}>返回选择并重新预览</WorkflowButton>}
      </details>
      </div>
    </> : <div aria-busy="true">
      {summary && <><h3 style={{ fontSize: 18 }}>{summary.displayTitle || summary.title || '合并请求'}</h3><span style={tagStyle}>{labels[summary.status] || summary.status}</span></>}
      <p role="status">正在核对分支与工作区状态…</p>
      <WorkflowButton disabled={busy || !online} onClick={c.refresh}>核对原操作</WorkflowButton>
    </div>}
    {uncertain && <p role="status">提交结果待核对，保留原 requestId；不会重新提交。</p>}
    {busy && <p role="status">正在处理当前操作…</p>}
    {c.notice && <p role="status" style={workflowNoticeStyle}>{c.notice}</p>}
    <details open={!draft.selected && c.history.length > 0} style={detailStyle}><summary style={{ cursor: 'pointer', fontWeight: 500 }}>合并历史（{c.history.length}{c.next !== null ? '+' : ''}）</summary>
      {c.history.map(item => <WorkflowButton tone="quiet" key={item.id} disabled={busy} aria-pressed={draft.selected === item.id} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6, overflowWrap: 'anywhere' }} onClick={() => c.select(item.id)}>
        {item.displayTitle || item.title} · {labels[item.status] || item.status}<br />{item.createdAt ? new Date(item.createdAt * 1000).toLocaleString() : '旧记录，创建时间未知'} · {item.id.slice(0, 8)} · {item.sourceHead?.slice(0, 8) || '?'} → {item.targetHead?.slice(0, 8) || '?'}
      </WorkflowButton>)}
      {c.next !== null && <WorkflowButton disabled={busy} onClick={c.more}>更多汇合</WorkflowButton>}
      <WorkflowButton disabled={busy || uncertain} onClick={newPreview}>新建汇合</WorkflowButton>
    </details>
  </section>;
};

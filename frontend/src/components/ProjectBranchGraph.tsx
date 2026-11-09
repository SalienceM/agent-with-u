import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import type { ProjectBranchGraphData } from '../types/taskWorkspaces';
import { branchMembership, layoutBranchGraph } from '../utils/branchGraph';
import { WorkflowButton, workflowNoticeStyle } from './WorkflowControls';
import { DiffViewer } from './DiffViewer';

const colors = ['#5199ed', '#b78bea', '#38ad8c', '#dc9c42', '#e47d9b', '#56aaba'];
interface Props { session: string; executor: string; onOpenSession?: (id: string) => void; onOpenMerge?: (source: string, parent: string) => void }

export const ProjectBranchGraph: React.FC<Props> = ({ session, executor, onOpenSession, onOpenMerge }) => {
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  useEffect(() => onCurrentUserChanged(() => setOwner(getCurrentUserProfile().userId)), []);
  const identity = JSON.stringify([owner, executor, session]);
  const current = useRef(identity); current.current = identity;
  const [snapshot, setSnapshot] = useState<{ identity: string; value: ProjectBranchGraphData }>(), [error, setError] = useState('');
  const data = snapshot?.identity === identity ? snapshot.value : undefined;
  const [branchId, setBranchId] = useState(session), [topology, setTopology] = useState(false);
  const [busy, setBusy] = useState(false), [nonce, setNonce] = useState(0), [limit, setLimit] = useState(80);
  const [selected, setSelected] = useState(''), [changed, setChanged] = useState(false);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.gitShow>>>(), [detailError, setDetailError] = useState('');
  const [file, setFile] = useState(''), [diff, setDiff] = useState<Awaited<ReturnType<typeof api.gitCommitFileDiff>>>();
  const graph = useMemo(() => data && topology ? layoutBranchGraph(data) : undefined, [data, topology]);
  const membership = useMemo(() => data ? branchMembership(data) : new Map<string, string[]>(), [data]);
  const focused = data?.branches.find(branch => branch.sessionId === branchId) || data?.branches.find(branch => branch.sessionId === session) || data?.branches[0];
  const main = data?.branches.find(branch => branch.main);
  const commits = data?.commits.filter(commit => focused && membership.get(commit.hash)?.includes(focused.sessionId)) || [];
  const canvas = useRef<HTMLDivElement>(null), records = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true; setBusy(true); setError(''); setChanged(false);
    void (async () => {
      const caps = await api.projectMergeCapabilities(session, executor);
      if (caps.branchGraph !== 1) throw Error('此节点尚不支持分支图，请更新执行节点。');
      if (!live || current.current !== identity || getCurrentUserProfile().userId !== owner) return;
      const value = await api.projectBranchGraph(session, executor, limit);
      if (live && current.current === identity && getCurrentUserProfile().userId === owner) { setSnapshot({ identity, value }); setSelected(old => value.commits.some(commit => commit.hash === old) ? old : ''); }
    })().catch(e => { if (live && current.current === identity) setError(String(e)); })
      .finally(() => { if (live && current.current === identity) setBusy(false); });
    return () => { live = false; };
  }, [identity, nonce, limit]);
  useEffect(() => api.onProjectMergeUpdated((row, node) => {
    if (node === executor && data?.branches.some(branch => [row.sourceSessionId, row.targetSessionId].includes(branch.sessionId))) setChanged(true);
  }), [executor, data]);
  useEffect(() => { if (canvas.current && data) canvas.current.scrollLeft = canvas.current.scrollWidth; }, [data, topology]);
  useEffect(() => {
    let live = true; setDetail(undefined); setDetailError(''); setFile(''); setDiff(undefined);
    if (data && selected) void api.gitShow(data.root, selected, executor).then(value => {
      if (live && current.current === identity && getCurrentUserProfile().userId === owner) {
        if ((value as any).error) setDetailError((value as any).error); else setDetail(value);
      }
    }).catch(e => { if (live && current.current === identity) setDetailError(String(e)); });
    return () => { live = false; };
  }, [identity, data, selected]);
  useEffect(() => {
    let live = true; setDiff(undefined);
    if (data && selected && file) void api.gitCommitFileDiff(data.root, selected, file, executor).then(value => {
      if (live && current.current === identity && getCurrentUserProfile().userId === owner) setDiff(value);
    }).catch(e => { if (live && current.current === identity) setDiff({ diff: '', binary: false, error: String(e) }); });
    return () => { live = false; };
  }, [identity, data, selected, file]);
  const choose = (hash: string, fromGraph = false) => {
    setSelected(hash);
    if (fromGraph) records.current?.querySelector<HTMLElement>(`[data-commit="${hash}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    else canvas.current?.querySelector(`[data-node="${hash}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  return <section aria-label="项目分支图" style={{ padding: '20px clamp(14px, 3vw, 28px)', overflow: 'auto', minWidth: 0, minHeight: 0, flex: 1 }}>
    <header style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
      <div><h3 style={{ margin: 0, fontSize: 20 }}>项目分支</h3><p style={{ margin: '6px 0 0', color: 'var(--theme-text-muted)', fontSize: 12 }}>选择分支，查看提交，再进入合并请求。</p></div>
      <WorkflowButton icon="refresh" disabled={busy} onClick={() => setNonce(n => n + 1)}>刷新分支</WorkflowButton>
    </header>
    {busy && <p role="status">{data ? '正在更新分支状态，当前显示上次读取结果…' : '正在读取分支与提交…'}</p>}
    {changed && <p role="status">合并状态有更新，请刷新查看。</p>}
    {error && <p role="alert" style={workflowNoticeStyle}>{error}</p>}
    {data && <>
      <div aria-label="分支状态" style={{ border: '1px solid var(--theme-border)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
        {data.branches.map(branch => <button key={branch.sessionId} type="button" aria-pressed={focused?.sessionId === branch.sessionId}
          onClick={() => { setBranchId(branch.sessionId); setSelected(''); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px 20px', width: '100%', textAlign: 'left', padding: '14px 16px', font: 'inherit', color: 'var(--theme-text)', cursor: 'pointer', border: 0, borderBottom: '1px solid var(--theme-border)', borderLeft: `3px solid ${focused?.sessionId === branch.sessionId ? 'var(--theme-accent, #4b82f0)' : 'transparent'}`, background: focused?.sessionId === branch.sessionId ? 'var(--theme-accent-bg, #4b82f014)' : 'transparent' }}>
          <span style={{ minWidth: 0, flex: '1 1 220px' }}><strong style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 14 }}>{branch.title} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text-muted)' }}>{branch.main ? '主干' : branch.sessionId === session ? '当前分支' : '副本'}</span></strong>
            <code style={{ display: 'block', marginTop: 4, fontSize: 11, overflowWrap: 'anywhere', color: 'var(--theme-text-muted)' }}>{branch.branch || (branch.state === 'known' ? '游离 HEAD' : '分支不可读取')}</code>
          </span>
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>{branch.state !== 'known' ? `状态未知：${branch.notice}` : branch.main ? '合并目标' : `领先 ${branch.ahead} · 落后 ${branch.behind}`}{branch.dirty ? ' · 有未提交修改' : ''}</span>
        </button>)}
      </div>
      {data.omittedBranches > 0 && <p>还有 {data.omittedBranches} 个分支未显示；从对应分支进入可优先查看。</p>}
      {focused && <section aria-label="所选分支" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0, flex: '1 1 260px' }}><strong style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{focused.title}{!focused.main && main ? ` → ${main.title}` : ''}</strong>
            <p style={{ margin: '6px 0 0', color: 'var(--theme-text-muted)', fontSize: 12 }}>{focused.state !== 'known' ? '此分支尚未核对' : focused.main ? '主干提交记录' : focused.ahead === 0 && focused.behind === 0 ? '已提交内容与主干一致' : `待合入主干 ${focused.ahead} 个提交 · 待同步主干 ${focused.behind} 个提交`}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <WorkflowButton disabled={!onOpenSession} onClick={() => onOpenSession?.(focused.sessionId)}>打开对话</WorkflowButton>
            {!focused.main && main && <WorkflowButton tone="primary" disabled={busy || !!error || focused.state !== 'known' || !onOpenMerge} onClick={() => onOpenMerge?.(focused.sessionId, main.sessionId)}>查看合并请求</WorkflowButton>}
          </div>
        </div>
      </section>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--theme-border)', paddingBottom: 10 }}>
        <strong>提交记录 <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text-muted)' }}>· 当前范围 {commits.length} 条</span></strong>
        <WorkflowButton tone="quiet" aria-expanded={topology} onClick={() => setTopology(value => !value)}>{topology ? '收起提交拓扑' : '查看提交拓扑'}</WorkflowButton>
      </div>
      {graph && <>
        <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>颜色区分提交路径；分支名称以节点标签和下方记录为准。多个分支可以包含同一提交。</p>
      <div ref={canvas} tabIndex={0} aria-label="横向 Git 提交图" style={{ overflow: 'auto', maxHeight: 300, border: '1px solid var(--theme-border)', borderRadius: 10 }}>
        <svg width={graph.width} height={graph.height} style={{ display: 'block' }} aria-label="提交关系">
          {graph.edges.map(({ child, parent, parentHash }) => <path key={`${child.hash}:${parentHash}`} data-edge={`${parentHash}:${child.hash}`}
            d={parent ? `M ${parent.x} ${parent.y} C ${parent.x + 35} ${parent.y}, ${child.x - 35} ${child.y}, ${child.x} ${child.y}` : `M 8 ${child.y} L ${child.x} ${child.y}`}
            fill="none" stroke={colors[child.lane % colors.length]} strokeWidth={2} strokeDasharray={parent ? undefined : '4 5'}><title>{parent ? '父提交' : '父提交在显示范围之外'}：{parentHash}</title></path>)}
          {graph.nodes.map(node => {
            const heads = data.branches.filter(branch => branch.head === node.hash);
            return <g key={node.hash} data-node={node.hash} role="button" tabIndex={0} aria-label={`提交 ${node.hash.slice(0, 8)} ${node.message}`} aria-pressed={selected === node.hash}
            onClick={() => choose(node.hash, true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(node.hash, true); } }} style={{ cursor: 'pointer' }}>
            <title>{node.hash}\n{node.message}\n{data.branches.filter(branch => branch.head === node.hash).map(branch => branch.branch).join(', ')}</title>
            <circle cx={node.x} cy={node.y} r={selected === node.hash ? 8 : 5} fill={colors[node.lane % colors.length]} stroke="var(--theme-text)" strokeWidth={selected === node.hash ? 2 : 0} />
            <text x={node.x} y={node.y + 22} textAnchor="middle" fill="var(--theme-text-muted)" fontSize={10}>{node.hash.slice(0, 7)}</text>
            {!!heads.length && <text x={node.x} y={node.y - 16} textAnchor="middle" fill={colors[node.lane % colors.length]} fontSize={11}>{heads.map(head => head.main ? `主干：${head.title}` : head.title.split(' · ').pop() || head.title).join(' / ')}</text>}
          </g>; })}
        </svg>
      </div>
      </>}
      <div ref={records} style={{ overflow: 'auto', maxHeight: 350, marginTop: 8 }}>
        <table aria-label="提交记录" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, color: 'var(--theme-text)' }}>
          <thead><tr><th style={{ width: 90, textAlign: 'left', padding: '10px 0' }}>提交</th><th style={{ textAlign: 'left' }}>说明 / 包含此提交的分支</th></tr></thead>
          <tbody>{commits.map(commit => <tr key={commit.hash} data-commit={commit.hash} style={{ background: selected === commit.hash ? 'var(--theme-accent-bg, #4b82f014)' : undefined, borderTop: '1px solid var(--theme-border)' }}>
            <td style={{ verticalAlign: 'top', padding: '10px 0' }}><WorkflowButton tone="quiet" aria-pressed={selected === commit.hash} onClick={() => choose(commit.hash)}>{commit.hash.slice(0, 8)}</WorkflowButton></td>
            <td style={{ padding: '10px 4px', overflowWrap: 'anywhere' }}><div style={{ fontWeight: 500, fontSize: 13 }}>{commit.message}{commit.parents.length > 1 ? ' · 合并提交' : ''}</div>
              <div style={{ color: 'var(--theme-text-muted)', margin: '4px 0 8px' }}>{commit.author} · {new Date(commit.date).toLocaleDateString()}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{data.branches.filter(branch => membership.get(commit.hash)?.includes(branch.sessionId)).map(branch => <span key={branch.sessionId} title={branch.branch} style={{ padding: '2px 7px', border: '1px solid var(--theme-border)', borderRadius: 5, fontSize: 11 }}>{branch.title}{branch.main ? ' · 主干' : ''}</span>)}</div>
            </td>
          </tr>)}</tbody>
        </table>
        {!commits.length && <p style={workflowNoticeStyle}>{focused?.state === 'unknown' ? '此分支不可读取，请先核对状态。' : '当前读取范围没有此分支的提交，可扩大读取范围。'}</p>}
      </div>
      {data.hasMore && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-text-muted)' }}>已读取最近 {data.limit} 条项目提交；分支标签仅标注当前范围内已确认的包含关系。
        {limit < 200 && <WorkflowButton disabled={busy} onClick={() => setLimit(200)}>查看最近 200 条提交</WorkflowButton>}
      </div>}
      {selected && <section aria-label="提交详情" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
        <strong>{selected}</strong>{detailError ? <p role="alert">{detailError}</p> : !detail ? <p>正在读取提交详情…</p> : <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{detail.message}</p>
          {detail.files.map(row => <WorkflowButton key={row.path} tone="quiet" aria-pressed={file === row.path} onClick={() => setFile(row.path)}>{row.path} · +{row.added} −{row.deleted}</WorkflowButton>)}
          {!detail.files.length && <p>此提交没有可显示的文件差异。</p>}
        </>}
        {file && (!diff ? <p>正在读取文件差异…</p> : diff.error ? <p role="alert">{diff.error}</p> : diff.binary ? <p>二进制文件</p> : <DiffViewer diff={diff.diff} filename={file} />)}
      </section>}
      <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>核对于 {new Date(data.checkedAt * 1000).toLocaleTimeString()} · 仅含已提交历史；合并前会单独核对冲突。</p>
    </>}
  </section>;
};

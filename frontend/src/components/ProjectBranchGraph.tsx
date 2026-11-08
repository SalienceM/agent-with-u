import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import type { ProjectBranchGraphData } from '../types/taskWorkspaces';
import { layoutBranchGraph } from '../utils/branchGraph';
import { WorkflowButton, workflowNoticeStyle } from './WorkflowControls';
import { DiffViewer } from './DiffViewer';

const colors = ['#5199ed', '#b78bea', '#38ad8c', '#dc9c42', '#e47d9b', '#56aaba'];
interface Props { session: string; executor: string; onOpenSession?: (id: string) => void; onOpenMerge?: (source: string, parent: string) => void }

export const ProjectBranchGraph: React.FC<Props> = ({ session, executor, onOpenSession, onOpenMerge }) => {
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  useEffect(() => onCurrentUserChanged(() => setOwner(getCurrentUserProfile().userId)), []);
  const identity = JSON.stringify([owner, executor, session]);
  const current = useRef(identity); current.current = identity;
  const [data, setData] = useState<ProjectBranchGraphData>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [nonce, setNonce] = useState(0), [limit, setLimit] = useState(80);
  const [selected, setSelected] = useState(''), [changed, setChanged] = useState(false);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.gitShow>>>(), [detailError, setDetailError] = useState('');
  const [file, setFile] = useState(''), [diff, setDiff] = useState<Awaited<ReturnType<typeof api.gitCommitFileDiff>>>();
  const graph = useMemo(() => data ? layoutBranchGraph(data) : undefined, [data]);
  const canvas = useRef<HTMLDivElement>(null), records = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true; setBusy(true); setError(''); setData(undefined); setSelected(''); setChanged(false);
    void (async () => {
      const caps = await api.projectMergeCapabilities(session, executor);
      if (caps.branchGraph !== 1) throw Error('此节点尚不支持分支图，请更新执行节点。');
      if (!live || current.current !== identity || getCurrentUserProfile().userId !== owner) return;
      const value = await api.projectBranchGraph(session, executor, limit);
      if (live && current.current === identity && getCurrentUserProfile().userId === owner) setData(value);
    })().catch(e => { if (live && current.current === identity) setError(String(e)); })
      .finally(() => { if (live && current.current === identity) setBusy(false); });
    return () => { live = false; };
  }, [identity, nonce, limit]);
  useEffect(() => api.onProjectMergeUpdated((row, node) => {
    if (node === executor && data?.branches.some(branch => [row.sourceSessionId, row.targetSessionId].includes(branch.sessionId))) setChanged(true);
  }), [executor, data]);
  useEffect(() => { if (canvas.current && data) canvas.current.scrollLeft = canvas.current.scrollWidth; }, [data]);
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
  return <section aria-label="项目分支图" style={{ padding: 16, overflow: 'auto', minWidth: 0, minHeight: 0, flex: 1 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <strong>分支与提交</strong><WorkflowButton disabled={busy} onClick={() => setNonce(n => n + 1)}>刷新分支图</WorkflowButton>
      {data?.hasMore && limit < 200 && <WorkflowButton disabled={busy} onClick={() => setLimit(200)}>查看最近 200 条提交</WorkflowButton>}
      {changed && <span role="status">合并状态有更新，请刷新查看。</span>}
    </div>
    <p style={{ color: 'var(--theme-text-muted)', fontSize: 12 }}>从左到右：旧提交 → 新提交。上方选节点，下方查看提交和文件差异。领先／落后按主 Session 当前提交计算。</p>
    {busy && <p role="status">正在读取本节点的真实分支与提交…</p>}
    {error && <p role="alert" style={workflowNoticeStyle}>{error}</p>}
    {data && graph && <>
      <div aria-label="分支状态" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {data.branches.map(branch => <div key={branch.sessionId} style={{ ...workflowNoticeStyle, flex: '1 1 210px', minWidth: 0, overflowWrap: 'anywhere' }}>
          <WorkflowButton tone="quiet" disabled={!onOpenSession} onClick={() => onOpenSession?.(branch.sessionId)}>{branch.main ? '主干' : branch.sessionId === session ? '当前分支' : '分支'} · {branch.title}</WorkflowButton>
          {branch.state === 'known' ? <><div>{branch.branch || '游离 HEAD'} · {branch.head?.slice(0, 8)}</div>
            <small>{branch.main ? '主 Session' : `领先 ${branch.ahead} · 落后 ${branch.behind}`}{branch.dirty ? ' · 有未提交修改' : ''}</small>
            {!!branch.behind && <div style={{ fontSize: 12 }}>主干有新提交，继续开发前可同步。</div>}
            {!branch.main && <WorkflowButton tone="quiet" disabled={!onOpenMerge || !data.branches.find(row => row.main)}
              onClick={() => onOpenMerge?.(branch.sessionId, data.branches.find(row => row.main)!.sessionId)}>合并与同步</WorkflowButton>}
          </> : <div role="status">状态未知：{branch.notice}</div>}
        </div>)}
      </div>
      {data.omittedBranches > 0 && <p>还有 {data.omittedBranches} 个分支未显示；从对应分支进入可优先查看。</p>}
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
            {!!heads.length && <text x={node.x} y={node.y - 16} textAnchor="middle" fill={colors[node.lane % colors.length]} fontSize={11}>{heads[0].main ? '主干' : heads[0].title.slice(0, 8)}{heads.length > 1 ? ` +${heads.length - 1}` : ''}</text>}
          </g>; })}
        </svg>
      </div>
      {data.hasMore && <p style={{ fontSize: 12 }}>仅显示最近 {data.limit} 条提交；虚线连接到范围外的父提交。</p>}
      <div ref={records} style={{ overflow: 'auto', maxHeight: 280, marginTop: 12 }}>
        <table aria-label="提交记录" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, color: 'var(--theme-text)' }}>
          <thead><tr><th style={{ width: 90, textAlign: 'left' }}>提交</th><th style={{ textAlign: 'left' }}>说明</th><th style={{ width: '25%', textAlign: 'left' }}>作者／时间</th></tr></thead>
          <tbody>{data.commits.map(commit => <tr key={commit.hash} data-commit={commit.hash} style={{ background: selected === commit.hash ? 'var(--theme-bg-secondary)' : undefined, borderTop: '1px solid var(--theme-border)' }}>
            <td style={{ padding: '8px 0' }}><WorkflowButton tone="quiet" aria-pressed={selected === commit.hash} onClick={() => choose(commit.hash)}>{commit.hash.slice(0, 8)}</WorkflowButton></td>
            <td style={{ overflowWrap: 'anywhere' }}>{commit.message}{commit.parents.length > 1 && <span> · 合并提交</span>}</td>
            <td style={{ overflowWrap: 'anywhere' }}>{commit.author}<br />{new Date(commit.date).toLocaleDateString()}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {selected && <section aria-label="提交详情" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
        <strong>{selected}</strong>{detailError ? <p role="alert">{detailError}</p> : !detail ? <p>正在读取提交详情…</p> : <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{detail.message}</p>
          {detail.files.map(row => <WorkflowButton key={row.path} tone="quiet" aria-pressed={file === row.path} onClick={() => setFile(row.path)}>{row.path} · +{row.added} −{row.deleted}</WorkflowButton>)}
          {!detail.files.length && <p>此提交没有可显示的文件差异。</p>}
        </>}
        {file && (!diff ? <p>正在读取文件差异…</p> : diff.error ? <p role="alert">{diff.error}</p> : diff.binary ? <p>二进制文件</p> : <DiffViewer diff={diff.diff} filename={file} />)}
      </section>}
      <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>核对于 {new Date(data.checkedAt * 1000).toLocaleTimeString()} · 图只包含已提交历史，不能证明没有代码冲突。</p>
    </>}
  </section>;
};

/**
 * GitPanel — Git 操作管理面板。
 * 三栏布局：Changes / Diff / Commit，底部 Tabs（Log / Branches / Stash）。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { DiffViewer } from './DiffViewer';
import type { GitFileStatus, GitFileStatusType, GitLogCommit, GitBranch, GitStashEntry } from '../types/git';

interface Props {
  workingDir: string;
  execKey?: string;
  execLabel?: string;
  execMode?: 'local' | 'relay';
  backendId?: string;
  open: boolean;
  onClose: () => void;
  onCommitComplete?: () => void;
}

type TabKey = 'changes' | 'log' | 'branches' | 'stash';

const STATUS_COLORS: Record<GitFileStatusType, string> = {
  modified: '#e3b341', added: '#3fb950', deleted: '#f85149',
  renamed: '#a371f7', copied: '#a371f7', untracked: '#8b949e', conflicted: '#f85149',
};
const STATUS_LABELS: Record<GitFileStatusType, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!',
};

export const GitPanel: React.FC<Props> = ({
  workingDir, execKey, execLabel, execMode, backendId, open, onClose, onCommitComplete,
}) => {
  const [tab, setTab] = useState<TabKey>('changes');
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState('');
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState({ diff: '', stat: '', binary: false });
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [log, setLog] = useState<GitLogCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logHasMore, setLogHasMore] = useState(false);
  const [logLoadingMore, setLogLoadingMore] = useState(false);
  const [branches, setBranches] = useState<{ current: string; local: GitBranch[]; remote: { name: string }[] }>({ current: '', local: [], remote: [] });
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchActionBusy, setBranchActionBusy] = useState('');
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [commitAll, setCommitAll] = useState(false);
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 加载文件状态
  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.gitStatus(workingDir, execKey);
      setFiles(res.files || []);
      setBranch(res.branch || '');
      setAhead(res.ahead || 0);
      setBehind(res.behind || 0);
    } finally {
      setLoading(false);
    }
  }, [workingDir, execKey]);

  // 自动刷新
  useEffect(() => {
    if (!open) return;
    loadStatus();
    pollRef.current = setInterval(loadStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, loadStatus]);

  // 加载 diff
  const loadDiff = useCallback(async (path: string, staged: boolean) => {
    setDiffLoading(true);
    setSelectedFile(path);
    try {
      const res = await api.gitDiff(workingDir, path, staged, execKey);
      setDiff(res);
    } finally {
      setDiffLoading(false);
    }
  }, [workingDir, execKey]);

  // Stage / Unstage
  const handleStage = useCallback(async (path: string) => {
    await api.gitStage(workingDir, [path], execKey);
    loadStatus();
    if (selectedFile === path) loadDiff(path, true);
  }, [workingDir, execKey, loadStatus, selectedFile, loadDiff]);

  const handleUnstage = useCallback(async (path: string) => {
    await api.gitUnstage(workingDir, [path], execKey);
    loadStatus();
    if (selectedFile === path) loadDiff(path, false);
  }, [workingDir, execKey, loadStatus, selectedFile, loadDiff]);

  const handleStageAll = useCallback(async () => {
    const unstaged = files.filter((f) => !f.staged).map((f) => f.path);
    if (unstaged.length) { await api.gitStage(workingDir, unstaged, execKey); loadStatus(); }
  }, [files, workingDir, execKey, loadStatus]);

  const handleUnstageAll = useCallback(async () => {
    const staged = files.filter((f) => f.staged).map((f) => f.path);
    if (staged.length) { await api.gitUnstage(workingDir, staged, execKey); loadStatus(); }
  }, [files, workingDir, execKey, loadStatus]);

  // Discard — 丢弃文件改动（需确认）
  const handleDiscard = useCallback(async (path: string) => {
    if (!window.confirm(`确定丢弃「${path}」的所有改动？此操作不可撤销。`)) return;
    try {
      const res = await api.gitDiscard(workingDir, [path], execKey);
      if (res.status === 'ok' || res.status === 'partial') {
        showToast(`✅ 已丢弃 ${path}`);
        if (selectedFile === path) { setSelectedFile(null); setDiff({ diff: '', stat: '', binary: false }); }
        loadStatus();
      } else {
        showToast(`❌ 丢弃失败: ${path}`);
      }
    } catch {
      showToast('❌ 丢弃操作异常');
    }
  }, [workingDir, execKey, loadStatus, selectedFile]);

  // Commit
  const handleCommit = useCallback(async () => {
    const msg = commitMsg.trim() || aiMsg.trim();
    if (!msg) { showToast('请输入 commit message'); return; }
    setCommitting(true);
    try {
      const res = await api.gitCommit(workingDir, msg, commitAll, execKey);
      if (res.status === 'ok') {
        showToast(`✅ Committed: ${res.commitHash || 'ok'} (${res.filesChanged} files)`);
        setCommitMsg('');
        setAiMsg('');
        setSelectedFile(null);
        setDiff({ diff: '', stat: '', binary: false });
        loadStatus();
        onCommitComplete?.();
      } else {
        showToast(`❌ ${res.message || 'Commit failed'}`);
      }
    } finally {
      setCommitting(false);
    }
  }, [commitMsg, aiMsg, commitAll, workingDir, execKey, loadStatus, onCommitComplete]);

  // AI 生成 commit message
  const handleAiGenerate = useCallback(() => {
    setAiGenerating(true);
    setAiMsg('');
    let accumulated = '';
    const unsub1 = api.onGitCommitMsgDelta((data) => {
      if (data.workingDir === workingDir && data.text) {
        accumulated += data.text;
        setAiMsg(accumulated);
      }
    });
    const unsub2 = api.onGitCommitMsgReady((data) => {
      if (data.workingDir === workingDir) {
        if (data.error) showToast(`❌ ${data.error}`);
        setAiGenerating(false);
      }
    });
    api.gitGenerateCommitMessage(workingDir, true, execKey, backendId).catch(() => {
      setAiGenerating(false);
      showToast('AI 生成失败');
    });
    // 30s 超时保护
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    aiTimerRef.current = setTimeout(() => {
      unsub1(); unsub2();
      setAiGenerating(false);
    }, 30000);
    // 完成后清理
    setTimeout(() => { unsub1(); unsub2(); }, 35000);
  }, [workingDir, execKey, backendId]);

  // Push / Pull
  const handlePush = useCallback(async () => {
    setPushing(true);
    try {
      const res = await api.gitPush(workingDir, 'origin', '', false, execKey);
      showToast(res.status === 'ok' ? '✅ Push 成功' : `❌ ${res.message || res.output}`);
      loadStatus();
    } finally { setPushing(false); }
  }, [workingDir, execKey, loadStatus]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    try {
      const res = await api.gitPull(workingDir, 'origin', '', false, execKey);
      showToast(res.status === 'ok' ? '✅ Pull 成功' : `❌ ${res.message || res.output}`);
      loadStatus();
    } finally { setPulling(false); }
  }, [workingDir, execKey, loadStatus]);

  // Load log (initial)
  const loadLog = useCallback(async () => {
    setLogLoading(true);
    setLog([]);
    setLogHasMore(false);
    try {
      const res = await api.gitLog(workingDir, 50, 0, execKey);
      setLog(res.commits || []);
      setLogHasMore(res.hasMore ?? false);
    } finally {
      setLogLoading(false);
    }
  }, [workingDir, execKey]);

  // Load more log entries
  const loadMoreLog = useCallback(async () => {
    if (logLoadingMore || !logHasMore) return;
    setLogLoadingMore(true);
    try {
      const res = await api.gitLog(workingDir, 50, log.length, execKey);
      setLog((prev) => [...prev, ...(res.commits || [])]);
      setLogHasMore(res.hasMore ?? false);
    } finally {
      setLogLoadingMore(false);
    }
  }, [workingDir, execKey, log.length, logLoadingMore, logHasMore]);

  useEffect(() => {
    if (tab !== 'log' || !open) return;
    loadLog();
  }, [tab, open, loadLog]);

  // Copy hash to clipboard
  const copyHash = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash).then(() => showToast(`📋 ${hash.slice(0, 7)} 已复制`));
  }, []);

  // Load branches
  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      const res = await api.gitBranches(workingDir, execKey);
      setBranches(res);
    } finally {
      setBranchesLoading(false);
    }
  }, [workingDir, execKey]);

  useEffect(() => {
    if (tab !== 'branches' || !open) return;
    loadBranches();
  }, [tab, open, loadBranches]);

  // Branch actions
  const handleBranchSwitch = useCallback(async (name: string) => {
    if (name === branches.current) return;
    setBranchActionBusy(`switch:${name}`);
    try {
      const res = await api.gitBranchSwitch(workingDir, name, execKey);
      if (res.status === 'ok') {
        showToast(`✅ 已切换到 ${name}`);
        loadBranches();
        loadStatus();
      } else {
        showToast(`❌ 切换失败: ${name}`);
      }
    } finally { setBranchActionBusy(''); }
  }, [workingDir, execKey, branches.current, loadBranches, loadStatus]);

  const handleBranchDelete = useCallback(async (name: string) => {
    if (name === branches.current) { showToast('❌ 不能删除当前分支'); return; }
    if (!window.confirm(`确定删除分支「${name}」？`)) return;
    setBranchActionBusy(`delete:${name}`);
    try {
      const res = await api.gitBranchDelete(workingDir, name, false, execKey);
      if (res.status === 'ok') {
        showToast(`✅ 已删除 ${name}`);
        loadBranches();
      } else {
        // 安全删除失败 → 询问强制删除
        if (window.confirm(`安全删除失败（分支未完全合并）。是否强制删除「${name}」？`)) {
          const res2 = await api.gitBranchDelete(workingDir, name, true, execKey);
          if (res2.status === 'ok') { showToast(`✅ 已强制删除 ${name}`); loadBranches(); }
          else { showToast(`❌ 强制删除失败`); }
        }
      }
    } finally { setBranchActionBusy(''); }
  }, [workingDir, execKey, branches.current, loadBranches]);

  const handleBranchCreate = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) { showToast('请输入分支名'); return; }
    if (!/^[a-zA-Z0-9._/\-]+$/.test(name)) { showToast('❌ 分支名包含非法字符'); return; }
    setBranchActionBusy('create');
    try {
      const res = await api.gitBranchCreate(workingDir, name, true, execKey);
      if (res.status === 'ok') {
        showToast(`✅ 已创建并切换到 ${name}`);
        setNewBranchName('');
        loadBranches();
        loadStatus();
      } else {
        showToast(`❌ 创建失败`);
      }
    } finally { setBranchActionBusy(''); }
  }, [workingDir, execKey, newBranchName, loadBranches, loadStatus]);

  // Load stashes
  useEffect(() => {
    if (tab !== 'stash' || !open) return;
    setStashesLoading(true);
    api.gitStashList(workingDir, execKey).then((res) => setStashes(res.stashes || [])).finally(() => setStashesLoading(false));
  }, [tab, open, workingDir, execKey]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => !f.staged);

  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <style>{`
          .git-file-row:hover .git-file-discard-btn { opacity: 1 !important; }
        `}</style>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}></span>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Git</span>
            {branch && <span style={branchBadgeStyle}>🔀 {branch}</span>}
            {ahead > 0 && <span style={{ ...badgeStyle, background: '#238636' }}>{ahead}</span>}
            {behind > 0 && <span style={{ ...badgeStyle, background: '#1f6feb' }}>{behind}</span>}
            {execLabel && execMode === 'relay' && <span style={nodeBadgeStyle}>🌐 {execLabel}</span>}
          </div>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* Tabs */}
        <div style={tabBarStyle}>
          {(['changes', 'log', 'branches', 'stash'] as TabKey[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              ...tabStyle, ...(tab === t ? tabActiveStyle : {}),
            }}>{t === 'changes' ? `Changes${files.length ? ` (${files.length})` : ''}` : t === 'log' ? 'Log' : t === 'branches' ? 'Branches' : 'Stash'}</button>
          ))}
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {tab === 'changes' && (
            <div style={changesLayoutStyle}>
              {/* Left: file list */}
              <div style={fileListStyle}>
                {/* Ready to Commit Summary Box - TortoiseGit style */}
                {stagedFiles.length > 0 && (
                  <div style={readyToCommitStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 14 }}>📦</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#3fb950' }}>准备提交</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text-muted, #8b949e)' }}>
                        {stagedFiles.length} 个文件，
                        +{stagedFiles.reduce((s, f) => s + (f.addedLines || 0), 0)} 行增加，
                        -{stagedFiles.reduce((s, f) => s + (f.deletedLines || 0), 0)} 行删除
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #8b949e)' }}>
                      {ahead > 0 && <span style={{ color: '#3fb950', marginRight: 12 }}>⬆ {ahead} 个提交待推送</span>}
                      {behind > 0 && <span style={{ color: '#1f6feb' }}>⬇ {behind} 个提交待拉取</span>}
                      {ahead === 0 && behind === 0 && <span>与远端同步 ✓</span>}
                    </div>
                  </div>
                )}

                <div style={sectionHeaderStyle}>
                  <span
                    style={{ cursor: stagedFiles.length > 0 ? 'pointer' : 'default', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => stagedFiles.length > 0 && setStagedCollapsed((v) => !v)}
                  >
                    {stagedFiles.length > 0 && <span style={{ fontSize: 9, transition: 'transform 0.15s', transform: stagedCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', display: 'inline-block' }}>▾</span>}
                    <span style={{ color: '#3fb950', fontWeight: 700 }}>✓ Staged</span> <span style={{ color: 'var(--theme-text-muted, #8b949e)' }}>({stagedFiles.length})</span>{(() => {
                      const sa = stagedFiles.reduce((s, f) => s + (f.addedLines || 0), 0);
                      const sd = stagedFiles.reduce((s, f) => s + (f.deletedLines || 0), 0);
                      return sa || sd ? ` +${sa} -${sd}` : '';
                    })()}
                  </span>
                  {stagedFiles.length > 0 && <button onClick={handleUnstageAll} style={smallBtnStyle}>Unstage All</button>}
                </div>
                {!stagedCollapsed && stagedFiles.map((f) => (
                  <FileRow key={f.path} file={f} isSelected={selectedFile === f.path}
                    onClick={() => loadDiff(f.path, true)}
                    onToggleStage={() => handleUnstage(f.path)}
                    onDiscard={() => handleDiscard(f.path)} />
                ))}
                <div style={{ ...sectionHeaderStyle, marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--theme-border, rgba(255,255,255,0.1))' }}>
                  <span
                    style={{ cursor: unstagedFiles.length > 0 ? 'pointer' : 'default', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => unstagedFiles.length > 0 && setUnstagedCollapsed((v) => !v)}
                  >
                    {unstagedFiles.length > 0 && <span style={{ fontSize: 9, transition: 'transform 0.15s', transform: unstagedCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', display: 'inline-block' }}>▾</span>}
                    <span style={{ color: '#e3b341', fontWeight: 700 }}>○ Unstaged</span> <span style={{ color: 'var(--theme-text-muted, #8b949e)' }}>({unstagedFiles.length})</span>{(() => {
                      const ua = unstagedFiles.reduce((s, f) => s + (f.addedLines || 0), 0);
                      const ud = unstagedFiles.reduce((s, f) => s + (f.deletedLines || 0), 0);
                      return ua || ud ? ` +${ua} -${ud}` : '';
                    })()}
                  </span>
                  {unstagedFiles.length > 0 && <button onClick={handleStageAll} style={smallBtnStyle}>Stage All</button>}
                </div>
                {!unstagedCollapsed && unstagedFiles.map((f) => (
                  <FileRow key={f.path} file={f} isSelected={selectedFile === f.path}
                    onClick={() => loadDiff(f.path, false)}
                    onToggleStage={() => handleStage(f.path)}
                    onDiscard={() => handleDiscard(f.path)} />
                ))}
                {files.length === 0 && <div style={emptyStyle}>工作区干净 ✓</div>}
                {loading && files.length === 0 && <div style={emptyStyle}>加载中…</div>}
              </div>
              {/* Center: diff */}
              <div style={diffAreaStyle}>
                {diffLoading ? <div style={emptyStyle}>加载 diff…</div> :
                  selectedFile ? <DiffViewer diff={diff.diff} filename={selectedFile} binary={diff.binary} /> :
                    <div style={emptyStyle}>点击文件查看差异</div>}
              </div>
              {/* Right: commit */}
              <div style={commitAreaStyle}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--theme-text, #c9d1d9)' }}>Commit Message</div>
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="输入 commit message…"
                  style={commitInputStyle}
                  rows={4}
                />
                <button onClick={handleAiGenerate} disabled={aiGenerating} style={{
                  ...actionBtnStyle, background: aiGenerating ? '#555' : '#8b5cf6',
                }}>{aiGenerating ? '⏳ AI 生成中…' : '✨ AI 生成'}</button>
                {aiMsg && (
                  <div style={aiMsgStyle}>
                    <div style={{ fontSize: 10, color: 'var(--theme-text-muted, #8b949e)', marginBottom: 4 }}>AI 建议：</div>
                    <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>{aiMsg}</div>
                    <button onClick={() => setCommitMsg(aiMsg)} style={{ ...smallBtnStyle, marginTop: 4 }}>采纳</button>
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: 'var(--theme-text-muted, #8b949e)', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={commitAll} onChange={(e) => setCommitAll(e.target.checked)} style={{ cursor: 'pointer', accentColor: '#3fb950' }} />
                  <span title="自动 stage 所有已跟踪文件的修改（git commit -a），无需手动 stage">Commit All（包含已跟踪文件修改）</span>
                </label>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={handleCommit} disabled={committing || (!commitMsg.trim() && !aiMsg.trim())} style={{
                    ...actionBtnStyle, flex: 1, background: '#238636',
                    opacity: committing || (!commitMsg.trim() && !aiMsg.trim()) ? 0.5 : 1,
                  }}>{committing ? '⏳' : '✅'} Commit</button>
                  <button onClick={handlePush} disabled={pushing || ahead === 0} style={{
                    ...actionBtnStyle, background: '#1f6feb',
                    opacity: pushing || ahead === 0 ? 0.5 : 1,
                  }}>{pushing ? '⏳' : '⬆'} Push</button>
                  <button onClick={handlePull} disabled={pulling} style={{
                    ...actionBtnStyle, background: '#8957e5',
                    opacity: pulling ? 0.5 : 1,
                  }}>{pulling ? '⏳' : '⬇'} Pull</button>
                </div>
              </div>
            </div>
          )}

          {tab === 'log' && (
            <div style={logStyle}>
              {logLoading ? <div style={emptyStyle}>加载历史…</div> :
                log.length === 0 ? <div style={emptyStyle}>无提交记录</div> :
                  <>
                    {log.map((c) => (
                      <div key={c.hash} style={logItemStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            onClick={() => copyHash(c.hash)}
                            style={{
                              fontFamily: 'monospace', fontSize: 11, color: 'var(--theme-accent, #58a6ff)',
                              background: 'var(--theme-accent-bg, rgba(88,166,255,0.1))', padding: '1px 6px',
                              borderRadius: 4, cursor: 'pointer', userSelect: 'all',
                              transition: 'background 0.15s',
                            }}
                            title="点击复制完整 hash"
                            onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.background = 'var(--theme-accent-bg, rgba(88,166,255,0.25))'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.background = 'var(--theme-accent-bg, rgba(88,166,255,0.1))'; }}
                          >{c.shortHash}</span>
                          <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #8b949e)' }}>{c.author}</span>
                          <span style={{ fontSize: 10, color: 'var(--theme-text-muted, #6e7681)' }}>{new Date(c.date).toLocaleString()}</span>
                        </div>
                        <div style={{ fontSize: 13, marginTop: 4, color: 'var(--theme-text, #c9d1d9)' }}>{c.message}</div>
                        {c.body && <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #8b949e)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                      </div>
                    ))}
                    {logHasMore && (
                      <div style={{ textAlign: 'center', padding: '12px 0' }}>
                        <button
                          onClick={loadMoreLog}
                          disabled={logLoadingMore}
                          style={{
                            padding: '6px 20px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                            color: 'var(--theme-accent, #58a6ff)', background: 'var(--theme-accent-bg, rgba(88,166,255,0.08))',
                            border: '1px solid var(--theme-accent-bg, rgba(88,166,255,0.2))', cursor: logLoadingMore ? 'wait' : 'pointer',
                            opacity: logLoadingMore ? 0.6 : 1, transition: 'all 0.15s',
                          }}
                        >
                          {logLoadingMore ? '⏳ 加载中…' : '📜 加载更多'}
                        </button>
                      </div>
                    )}
                  </>}
            </div>
          )}

          {tab === 'branches' && (
            <div style={logStyle}>
              {branchesLoading ? <div style={emptyStyle}>加载分支…</div> : (
                <>
                  {/* 创建新分支 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <input
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleBranchCreate(); }}
                      placeholder="新分支名（基于当前分支创建并切换）"
                      style={branchInputStyle}
                      disabled={!!branchActionBusy}
                    />
                    <button
                      onClick={handleBranchCreate}
                      disabled={!!branchActionBusy || !newBranchName.trim()}
                      style={{
                        ...actionBtnStyle,
                        background: branchActionBusy === 'create' ? '#555' : '#238636',
                        opacity: !newBranchName.trim() ? 0.5 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {branchActionBusy === 'create' ? '⏳' : '＋ 创建分支'}
                    </button>
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#3fb950' }}>本地分支</div>
                  {branches.local.length === 0 && <div style={emptyStyle}>无本地分支</div>}
                  {branches.local.map((b) => {
                    const isCurrent = b.name === branches.current;
                    const busy = branchActionBusy === `switch:${b.name}` || branchActionBusy === `delete:${b.name}`;
                    return (
                      <div key={b.name} style={{ ...logItemStyle, ...(isCurrent ? { background: 'rgba(63,185,80,0.1)', borderColor: 'rgba(63,185,80,0.3)' } : {}) }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {isCurrent && <span title="当前分支">✅</span>}
                          <span style={{ fontSize: 13, fontWeight: isCurrent ? 700 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                          {b.upstream && <span style={{ fontSize: 10, color: 'var(--theme-text-muted, #8b949e)', flexShrink: 0 }}>→ {b.upstream}</span>}
                          {(b.ahead || 0) > 0 && <span style={{ fontSize: 10, color: '#3fb950', flexShrink: 0 }}>⬆{b.ahead}</span>}
                          {(b.behind || 0) > 0 && <span style={{ fontSize: 10, color: '#f85149', flexShrink: 0 }}>⬇{b.behind}</span>}
                          {!isCurrent && (
                            <button onClick={() => handleBranchSwitch(b.name)} disabled={busy} style={branchActionBtnStyle} title={`切换到 ${b.name}`}>
                              {busy && branchActionBusy.startsWith('switch:') ? '⏳' : '🔀 切换'}
                            </button>
                          )}
                          {!isCurrent && (
                            <button onClick={() => handleBranchDelete(b.name)} disabled={busy}
                              style={{ ...branchActionBtnStyle, color: '#f85149', borderColor: 'rgba(248,81,73,0.3)' }} title={`删除 ${b.name}`}>
                              {busy && branchActionBusy.startsWith('delete:') ? '⏳' : '🗑'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 16, marginBottom: 8, color: 'var(--theme-accent, #58a6ff)' }}>远端分支</div>
                  {branches.remote.length === 0 && <div style={emptyStyle}>无远端分支</div>}
                  {branches.remote.map((b) => (
                    <div key={b.name} style={logItemStyle}>
                      <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #8b949e)' }}>{b.name}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {tab === 'stash' && (
            <div style={logStyle}>
              {stashesLoading ? <div style={emptyStyle}>加载 stash…</div> :
                stashes.length === 0 ? <div style={emptyStyle}>无 stash</div> :
                  stashes.map((s) => (
                    <div key={s.index} style={logItemStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--theme-accent, #58a6ff)' }}>stash@{'{' + s.index + '}'}</span>
                        <span style={{ fontSize: 10, color: 'var(--theme-text-muted, #6e7681)' }}>{new Date(s.date).toLocaleString()}</span>
                      </div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>{s.message}</div>
                    </div>
                  ))}
            </div>
          )}
        </div>

        {/* Toast */}
        {toast && <div style={toastStyle}>{toast}</div>}
      </div>
    </div>
  );
};

// ── 子组件：文件行（TortoiseGit 风格） ──────────────────────────
const FileRow: React.FC<{
  file: GitFileStatus; isSelected: boolean;
  onClick: () => void; onToggleStage: () => void; onDiscard: () => void;
}> = ({ file, isSelected, onClick, onToggleStage, onDiscard }) => {
  // 拆分路径：目录(灰) + 文件名(亮)
  const lastSlash = file.path.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
  const namePart = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;

  return (
    <div className="git-file-row" style={{
      ...fileRowStyle,
      ...(isSelected ? fileRowSelectedStyle : {}),
    }} onClick={onClick}>
      {/* Checkbox: 点击切换 stage/unstage */}
      <span
        onClick={(e) => { e.stopPropagation(); onToggleStage(); }}
        style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0, cursor: 'pointer',
          border: file.staged ? '2px solid #3fb950' : '2px solid var(--theme-border, rgba(255,255,255,0.25))',
          background: file.staged ? 'rgba(63,185,80,0.2)' : 'transparent',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: '#3fb950', transition: 'all 0.12s',
        }}
        title={file.staged ? '取消暂存' : '暂存'}
      >
        {file.staged ? '✓' : ''}
      </span>
      {/* 状态徽章 */}
      <span style={{
        width: 18, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0,
        background: STATUS_COLORS[file.status],
      }}>{STATUS_LABELS[file.status]}</span>
      {/* 文件路径: 目录灰 + 文件名亮（CSS变量适配主题） */}
      <span style={{
        flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 12,
        display: 'flex', alignItems: 'center', minWidth: 0,
      }}>
        {dirPart && <span style={{ color: 'var(--theme-text-muted, #6e7681)', flexShrink: 0 }}>{dirPart}</span>}
        <span style={{ color: 'var(--theme-text, #e6edf3)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{namePart}</span>
      </span>
      {/* 增删行数 */}
      {(file.addedLines != null || file.deletedLines != null) && (
        <span style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          {file.addedLines != null && file.addedLines > 0 && <span style={{ color: '#3fb950' }}>+{file.addedLines}</span>}
          {file.deletedLines != null && file.deletedLines > 0 && <span style={{ color: '#f85149' }}>-{file.deletedLines}</span>}
        </span>
      )}
      {/* Discard 按钮 (hover 显示) */}
      <button
        className="git-file-discard-btn"
        onClick={(e) => { e.stopPropagation(); onDiscard(); }}
        title="丢弃改动 (Discard)"
        style={discardBtnStyle}
      >🗑</button>
    </div>
  );
};

// ── 样式 ────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const panelStyle: React.CSSProperties = {
  width: '92vw', maxWidth: 1260, height: '80vh', maxHeight: 700,
  background: 'var(--theme-bg-secondary, #161b22)',
  borderRadius: 14, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
  animation: 'dialogSlideIn 0.25s cubic-bezier(0.22,0.61,0.36,1)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '12px 16px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};
const branchBadgeStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--theme-accent, #58a6ff)', background: 'var(--theme-accent-bg, rgba(88,166,255,0.12))',
  padding: '2px 8px', borderRadius: 10, fontWeight: 500,
};
const badgeStyle: React.CSSProperties = {
  fontSize: 11, color: '#fff', padding: '2px 7px', borderRadius: 10, fontWeight: 600,
};
const nodeBadgeStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-text-muted, #8b949e)', background: 'var(--theme-border, rgba(255,255,255,0.06))',
  padding: '2px 6px', borderRadius: 8,
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted, #8b949e)', fontSize: 16, cursor: 'pointer', padding: '4px 8px',
};
const tabBarStyle: React.CSSProperties = {
  display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  padding: '0 16px',
};
const tabStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  background: 'none', border: 'none', borderBottom: '2px solid transparent',
  color: 'var(--theme-text-muted, #8b949e)', transition: 'all 0.15s',
};
const tabActiveStyle: React.CSSProperties = {
  color: 'var(--theme-accent, #58a6ff)', borderBottomColor: 'var(--theme-accent, #58a6ff)',
};
const contentStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
};
const changesLayoutStyle: React.CSSProperties = {
  display: 'flex', flex: 1, overflow: 'hidden',
};
const readyToCommitStyle: React.CSSProperties = {
  padding: '10px 12px', marginBottom: 12, borderRadius: 8,
  background: 'linear-gradient(135deg, rgba(63,185,80,0.12) 0%, rgba(63,185,80,0.06) 100%)',
  border: '1px solid rgba(63,185,80,0.25)',
  boxShadow: '0 2px 8px rgba(63,185,80,0.08)',
};
const fileListStyle: React.CSSProperties = {
  width: 350, borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  overflowY: 'auto', overflowX: 'hidden', padding: 8, flexShrink: 0,
};
const diffAreaStyle: React.CSSProperties = {
  flex: 1, overflow: 'auto', padding: 8,
};
const commitAreaStyle: React.CSSProperties = {
  width: 260, borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  padding: 12, overflowY: 'auto', flexShrink: 0,
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 11, fontWeight: 600, color: 'var(--theme-text-muted, #8b949e)', marginBottom: 6, padding: '0 4px',
};
const fileRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px',
  borderRadius: 6, cursor: 'pointer', transition: 'background 0.1s',
};
const discardBtnStyle: React.CSSProperties = {
  flexShrink: 0, width: 22, height: 20, borderRadius: 4, cursor: 'pointer',
  border: '1px solid rgba(248,81,73,0.3)', background: 'rgba(248,81,73,0.08)',
  color: '#f85149', fontSize: 12, lineHeight: 1, padding: 0,
  opacity: 0, transition: 'opacity 0.12s',
};
const fileRowSelectedStyle: React.CSSProperties = {
  background: 'var(--theme-accent-bg, rgba(88,166,255,0.12))',
};
const smallBtnStyle: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
  background: 'var(--theme-border, rgba(255,255,255,0.08))', border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  color: 'var(--theme-text-muted, #8b949e)',
};
const actionBtnStyle: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  color: '#fff', border: 'none', cursor: 'pointer', transition: 'opacity 0.15s',
};
const commitInputStyle: React.CSSProperties = {
  width: '100%', padding: 8, borderRadius: 6, fontSize: 12,
  background: 'var(--theme-bg, rgba(0,0,0,0.3))', color: 'var(--theme-text, #c9d1d9)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
  fontFamily: 'inherit', resize: 'vertical', outline: 'none',
  boxSizing: 'border-box' as const,
};
const aiMsgStyle: React.CSSProperties = {
  marginTop: 8, padding: 8, borderRadius: 6, fontSize: 12,
  background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)',
};
const logStyle: React.CSSProperties = {
  padding: 12, overflowY: 'auto', flex: 1,
};
const branchInputStyle: React.CSSProperties = {
  flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 12,
  background: 'var(--theme-bg, rgba(0,0,0,0.3))', color: 'var(--theme-text, #c9d1d9)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
  outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' as const,
};
const branchActionBtnStyle: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 500,
  color: 'var(--theme-accent, #58a6ff)', background: 'var(--theme-accent-bg, rgba(88,166,255,0.08))',
  border: '1px solid var(--theme-accent-bg, rgba(88,166,255,0.25))', cursor: 'pointer',
  whiteSpace: 'nowrap', flexShrink: 0, transition: 'all 0.12s',
};
const logItemStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 8, marginBottom: 4,
  background: 'var(--theme-bg, rgba(0,0,0,0.2))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
};
const emptyStyle: React.CSSProperties = {
  padding: 24, textAlign: 'center', color: 'var(--theme-text-muted, #8b949e)', fontSize: 12,
};
const toastStyle: React.CSSProperties = {
  position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 500,
  background: 'rgba(0,0,0,0.85)', color: '#fff', zIndex: 10,
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  animation: 'dialogSlideIn 0.2s ease',
};

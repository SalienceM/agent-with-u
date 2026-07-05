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
  workingDir, execKey, execLabel, execMode, open, onClose, onCommitComplete,
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
  const [branches, setBranches] = useState<{ current: string; local: GitBranch[]; remote: { name: string }[] }>({ current: '', local: [], remote: [] });
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [toast, setToast] = useState('');
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

  // Commit
  const handleCommit = useCallback(async () => {
    const msg = commitMsg.trim() || aiMsg.trim();
    if (!msg) { showToast('请输入 commit message'); return; }
    setCommitting(true);
    try {
      const res = await api.gitCommit(workingDir, msg, false, execKey);
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
  }, [commitMsg, aiMsg, workingDir, execKey, loadStatus, onCommitComplete]);

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
    api.gitGenerateCommitMessage(workingDir, true, execKey).catch(() => {
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
  }, [workingDir, execKey]);

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

  // Load log
  useEffect(() => {
    if (tab !== 'log' || !open) return;
    setLogLoading(true);
    api.gitLog(workingDir, 50, 0, execKey).then((res) => setLog(res.commits || [])).finally(() => setLogLoading(false));
  }, [tab, open, workingDir, execKey]);

  // Load branches
  useEffect(() => {
    if (tab !== 'branches' || !open) return;
    setBranchesLoading(true);
    api.gitBranches(workingDir, execKey).then((res) => setBranches(res)).finally(() => setBranchesLoading(false));
  }, [tab, open, workingDir, execKey]);

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
                <div style={sectionHeaderStyle}>
                  <span>Staged ({stagedFiles.length})</span>
                  {stagedFiles.length > 0 && <button onClick={handleUnstageAll} style={smallBtnStyle}>Unstage All</button>}
                </div>
                {stagedFiles.map((f) => (
                  <FileRow key={f.path} file={f} isSelected={selectedFile === f.path}
                    onClick={() => loadDiff(f.path, true)}
                    onAction={() => handleUnstage(f.path)} actionLabel="Unstage" />
                ))}
                <div style={{ ...sectionHeaderStyle, marginTop: 12 }}>
                  <span>Unstaged ({unstagedFiles.length})</span>
                  {unstagedFiles.length > 0 && <button onClick={handleStageAll} style={smallBtnStyle}>Stage All</button>}
                </div>
                {unstagedFiles.map((f) => (
                  <FileRow key={f.path} file={f} isSelected={selectedFile === f.path}
                    onClick={() => loadDiff(f.path, false)}
                    onAction={() => handleStage(f.path)} actionLabel="Stage" />
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
                    <div style={{ fontSize: 10, color: '#8b949e', marginBottom: 4 }}>AI 建议：</div>
                    <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>{aiMsg}</div>
                    <button onClick={() => setCommitMsg(aiMsg)} style={{ ...smallBtnStyle, marginTop: 4 }}>采纳</button>
                  </div>
                )}
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
                  log.map((c) => (
                    <div key={c.hash} style={logItemStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#58a6ff', background: 'rgba(88,166,255,0.1)', padding: '1px 6px', borderRadius: 4 }}>{c.shortHash}</span>
                        <span style={{ fontSize: 12, color: '#8b949e' }}>{c.author}</span>
                        <span style={{ fontSize: 10, color: '#6e7681' }}>{new Date(c.date).toLocaleString()}</span>
                      </div>
                      <div style={{ fontSize: 13, marginTop: 4, color: 'var(--theme-text, #c9d1d9)' }}>{c.message}</div>
                      {c.body && <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                    </div>
                  ))}
            </div>
          )}

          {tab === 'branches' && (
            <div style={logStyle}>
              {branchesLoading ? <div style={emptyStyle}>加载分支…</div> : (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#3fb950' }}>本地分支</div>
                  {branches.local.map((b) => (
                    <div key={b.name} style={{ ...logItemStyle, ...(b.name === branches.current ? { background: 'rgba(63,185,80,0.1)' } : {}) }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {b.name === branches.current && <span>✅</span>}
                        <span style={{ fontSize: 13, fontWeight: b.name === branches.current ? 700 : 400 }}>{b.name}</span>
                        {b.upstream && <span style={{ fontSize: 10, color: '#8b949e' }}>→ {b.upstream}</span>}
                        {(b.ahead || 0) > 0 && <span style={{ fontSize: 10, color: '#3fb950' }}>⬆{b.ahead}</span>}
                        {(b.behind || 0) > 0 && <span style={{ fontSize: 10, color: '#f85149' }}>⬇{b.behind}</span>}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 16, marginBottom: 8, color: '#58a6ff' }}>远端分支</div>
                  {branches.remote.map((b) => (
                    <div key={b.name} style={logItemStyle}>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>{b.name}</span>
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
                        <span style={{ fontSize: 11, color: '#58a6ff' }}>stash@{'{' + s.index + '}'}</span>
                        <span style={{ fontSize: 10, color: '#6e7681' }}>{new Date(s.date).toLocaleString()}</span>
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

// ── 子组件：文件行 ──────────────────────────────────────────────
const FileRow: React.FC<{
  file: GitFileStatus; isSelected: boolean;
  onClick: () => void; onAction: () => void; actionLabel: string;
}> = ({ file, isSelected, onClick, onAction, actionLabel }) => (
  <div style={{
    ...fileRowStyle,
    ...(isSelected ? fileRowSelectedStyle : {}),
  }} onClick={onClick}>
    <span style={{
      width: 18, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0,
      background: STATUS_COLORS[file.status],
    }}>{STATUS_LABELS[file.status]}</span>
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{file.path}</span>
    <button onClick={(e) => { e.stopPropagation(); onAction(); }} style={actionBtnSmallStyle}>{actionLabel}</button>
  </div>
);

// ── 样式 ────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const panelStyle: React.CSSProperties = {
  width: '92vw', maxWidth: 1100, height: '80vh', maxHeight: 700,
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
  fontSize: 12, color: '#58a6ff', background: 'rgba(88,166,255,0.12)',
  padding: '2px 8px', borderRadius: 10, fontWeight: 500,
};
const badgeStyle: React.CSSProperties = {
  fontSize: 11, color: '#fff', padding: '2px 7px', borderRadius: 10, fontWeight: 600,
};
const nodeBadgeStyle: React.CSSProperties = {
  fontSize: 10, color: '#8b949e', background: 'rgba(255,255,255,0.06)',
  padding: '2px 6px', borderRadius: 8,
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#8b949e', fontSize: 16, cursor: 'pointer', padding: '4px 8px',
};
const tabBarStyle: React.CSSProperties = {
  display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  padding: '0 16px',
};
const tabStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  background: 'none', border: 'none', borderBottom: '2px solid transparent',
  color: '#8b949e', transition: 'all 0.15s',
};
const tabActiveStyle: React.CSSProperties = {
  color: '#58a6ff', borderBottomColor: '#58a6ff',
};
const contentStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
};
const changesLayoutStyle: React.CSSProperties = {
  display: 'flex', flex: 1, overflow: 'hidden',
};
const fileListStyle: React.CSSProperties = {
  width: 260, borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  overflowY: 'auto', padding: 8, flexShrink: 0,
};
const diffAreaStyle: React.CSSProperties = {
  flex: 1, overflow: 'auto', padding: 8,
};
const commitAreaStyle: React.CSSProperties = {
  width: 240, borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  padding: 12, overflowY: 'auto', flexShrink: 0,
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 6, padding: '0 4px',
};
const fileRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px',
  borderRadius: 6, cursor: 'pointer', transition: 'background 0.1s',
};
const fileRowSelectedStyle: React.CSSProperties = {
  background: 'rgba(88,166,255,0.12)',
};
const smallBtnStyle: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)',
  color: '#8b949e',
};
const actionBtnSmallStyle: React.CSSProperties = {
  ...smallBtnStyle, color: '#58a6ff', borderColor: 'rgba(88,166,255,0.3)',
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
const logItemStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 8, marginBottom: 4,
  background: 'var(--theme-bg, rgba(0,0,0,0.2))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
};
const emptyStyle: React.CSSProperties = {
  padding: 24, textAlign: 'center', color: '#8b949e', fontSize: 12,
};
const toastStyle: React.CSSProperties = {
  position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 500,
  background: 'rgba(0,0,0,0.85)', color: '#fff', zIndex: 10,
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  animation: 'dialogSlideIn 0.2s ease',
};

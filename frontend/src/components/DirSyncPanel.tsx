/**
 * DirSyncPanel — 远端工作目录 ↔ 本机副本目录的同步面板。
 *
 * 远程执行模式下会话工作目录在执行节点上。本面板让用户在本机选一个
 * 「副本目录」，然后增量地「拉取」（远端→本地）或「推送」（本地→远端）。
 * 应用前先做三向比对并展示变更预览；两端都改过的文件标记为冲突，由
 * 用户决定覆盖还是跳过。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  DirSyncSession,
  pickLocalDir,
  restoreLocalDir,
  type ApplyProgress,
  type ApplyResult,
  type DiffEntry,
  type LocalFs,
  type PreparedSync,
  type SyncDirection,
} from '../utils/dirSync';

interface Props {
  workingDir: string;
  onClose: () => void;
  execKey?: string;   // 会话归属的执行节点;远端工作目录在它上面(不传则发到 home)
}

type Phase = 'idle' | 'preparing' | 'preview' | 'applying' | 'done';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ACTION_META: Record<DiffEntry['action'], { label: string; color: string }> = {
  add: { label: '新增', color: '#22c55e' },
  update: { label: '更新', color: '#3b82f6' },
  delete: { label: '删除', color: '#ef4444' },
};

export const DirSyncPanel: React.FC<Props> = ({ workingDir, onClose, execKey }) => {
  const [localFs, setLocalFs] = useState<LocalFs | null>(null);
  const [ignore, setIgnore] = useState<string[]>([]);
  const [ignoreText, setIgnoreText] = useState('');
  const [defaultIgnore, setDefaultIgnore] = useState<string[]>([]);
  const [showIgnore, setShowIgnore] = useState(false);
  const [savingIgnore, setSavingIgnore] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState<PreparedSync | null>(null);
  const [conflictChoice, setConflictChoice] = useState<'overwrite' | 'skip'>('skip');
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState('');

  const sessionRef = useRef<DirSyncSession | null>(null);

  // 初始化：读忽略清单 + 恢复上次选择的副本目录
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.getSyncConfig();
        if (cancelled) return;
        setIgnore(cfg.ignore || []);
        setIgnoreText((cfg.ignore || []).join('\n'));
        setDefaultIgnore(cfg.defaultIgnore || []);
      } catch {
        /* 忽略 */
      }
      try {
        const fs = await restoreLocalDir();
        if (!cancelled && fs) setLocalFs(fs);
      } catch {
        /* 浏览器侧可能需要重新授权，留给用户手动选择 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetRun = useCallback(() => {
    setPhase('idle');
    setPrepared(null);
    setProgress(null);
    setResult(null);
    setError('');
  }, []);

  const handlePickDir = useCallback(async () => {
    setError('');
    try {
      const fs = await pickLocalDir();
      if (fs) {
        setLocalFs(fs);
        resetRun();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [resetRun]);

  const handlePrepare = useCallback(
    async (direction: SyncDirection) => {
      if (!localFs || !workingDir) return;
      setError('');
      setResult(null);
      setPhase('preparing');
      const session = new DirSyncSession(localFs, workingDir, ignore, execKey);
      sessionRef.current = session;
      try {
        const p = await session.prepare(direction);
        setPrepared(p);
        setConflictChoice('skip');
        setPhase('preview');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('idle');
      }
    },
    [localFs, workingDir, ignore, execKey],
  );

  const selectedEntries = useMemo<DiffEntry[]>(() => {
    if (!prepared) return [];
    return conflictChoice === 'overwrite'
      ? prepared.diff.entries
      : prepared.diff.entries.filter((e) => !e.conflict);
  }, [prepared, conflictChoice]);

  const handleApply = useCallback(async () => {
    if (!prepared || !sessionRef.current) return;
    setPhase('applying');
    setProgress({ done: 0, total: selectedEntries.length, rel: '' });
    try {
      const r = await sessionRef.current.apply(prepared, selectedEntries, setProgress);
      setResult(r);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('preview');
    }
  }, [prepared, selectedEntries]);

  const handleSaveIgnore = useCallback(async () => {
    const list = ignoreText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    setSavingIgnore(true);
    try {
      await api.setSyncConfig(list);
      setIgnore(list);
      resetRun();
    } finally {
      setSavingIgnore(false);
    }
  }, [ignoreText, resetRun]);

  const diff = prepared?.diff;
  const counts = useMemo(() => {
    const c = { add: 0, update: 0, delete: 0, conflict: 0 };
    for (const e of diff?.entries || []) {
      c[e.action]++;
      if (e.conflict) c.conflict++;
    }
    return c;
  }, [diff]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>🔄 目录同步</span>
          <button style={closeBtnStyle} onClick={onClose}>
            ✕
          </button>
        </div>

        <p style={hintStyle}>
          远程执行模式下工作目录在执行节点上。选一个本机副本目录，即可增量
          拉取 / 推送；两端都改过的文件会标为冲突，由你决定。
        </p>

        {/* 远端工作目录 */}
        <div style={rowStyle}>
          <span style={labelStyle}>远端工作目录</span>
          <span style={pathStyle}>{workingDir || '（未打开会话）'}</span>
        </div>

        {/* 本机副本目录 */}
        <div style={rowStyle}>
          <span style={labelStyle}>本机副本目录</span>
          <span style={pathStyle}>{localFs ? localFs.label() : '（未选择）'}</span>
          <button style={smallBtnStyle} onClick={handlePickDir}>
            {localFs ? '更换' : '选择'}
          </button>
        </div>

        {/* 方向按钮 */}
        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <button
            style={{ ...actionBtnStyle, ...(!localFs || !workingDir ? disabledStyle : {}) }}
            disabled={!localFs || !workingDir || phase === 'preparing' || phase === 'applying'}
            onClick={() => handlePrepare('pull')}
          >
            ⬇ 拉取（远端 → 本地）
          </button>
          <button
            style={{ ...actionBtnStyle, ...(!localFs || !workingDir ? disabledStyle : {}) }}
            disabled={!localFs || !workingDir || phase === 'preparing' || phase === 'applying'}
            onClick={() => handlePrepare('push')}
          >
            ⬆ 推送（本地 → 远端）
          </button>
        </div>

        {/* 忽略清单编辑器 */}
        <div>
          <button style={linkBtnStyle} onClick={() => setShowIgnore((v) => !v)}>
            {showIgnore ? '▾' : '▸'} 忽略清单（{ignore.length} 项）
          </button>
          {showIgnore && (
            <div style={{ marginTop: 6 }}>
              <textarea
                value={ignoreText}
                onChange={(e) => setIgnoreText(e.target.value)}
                spellCheck={false}
                placeholder="每行一条，支持 * ? 通配，例如 node_modules / *.log"
                style={ignoreTextareaStyle}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button style={smallBtnStyle} onClick={handleSaveIgnore} disabled={savingIgnore}>
                  {savingIgnore ? '保存中…' : '保存'}
                </button>
                <button
                  style={smallBtnStyle}
                  onClick={() => setIgnoreText(defaultIgnore.join('\n'))}
                >
                  恢复默认
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <div style={errorStyle}>⚠ {error}</div>}

        {phase === 'preparing' && <div style={statusStyle}>正在扫描两端并比对…</div>}

        {/* 变更预览 */}
        {phase === 'preview' && diff && (
          <div style={previewStyle}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              {diff.direction === 'pull' ? '拉取' : '推送'}预览
            </div>
            {diff.entries.length === 0 ? (
              <div style={statusStyle}>两端已一致，无需同步。</div>
            ) : (
              <>
                <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--theme-text-muted)' }}>
                  新增 {counts.add} · 更新 {counts.update} · 删除 {counts.delete}
                  {counts.conflict > 0 && (
                    <span style={{ color: '#f59e0b', fontWeight: 600 }}>
                      {' '}
                      · 冲突 {counts.conflict}
                    </span>
                  )}
                </div>
                <div style={listStyle}>
                  {diff.entries.map((e) => {
                    const m = ACTION_META[e.action];
                    return (
                      <div key={e.rel} style={entryRowStyle}>
                        <span style={{ ...badgeStyle, background: m.color }}>{m.label}</span>
                        <span style={entryPathStyle}>{e.rel}</span>
                        {e.conflict && <span style={conflictBadgeStyle}>冲突</span>}
                        {e.action !== 'delete' && (
                          <span style={sizeStyle}>{formatBytes(e.size)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {counts.conflict > 0 && (
                  <div style={conflictBoxStyle}>
                    <div style={{ fontSize: 12, marginBottom: 4, color: '#f59e0b' }}>
                      检测到 {counts.conflict} 个文件两端都改过：
                    </div>
                    <label style={radioLabelStyle}>
                      <input
                        type="radio"
                        checked={conflictChoice === 'skip'}
                        onChange={() => setConflictChoice('skip')}
                      />
                      跳过冲突项（仅同步无冲突的文件）
                    </label>
                    <label style={radioLabelStyle}>
                      <input
                        type="radio"
                        checked={conflictChoice === 'overwrite'}
                        onChange={() => setConflictChoice('overwrite')}
                      />
                      强制覆盖（用{diff.direction === 'pull' ? '远端' : '本地'}内容覆盖目标）
                    </label>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button style={smallBtnStyle} onClick={resetRun}>
                    取消
                  </button>
                  <button
                    style={{ ...primaryBtnStyle, ...(selectedEntries.length === 0 ? disabledStyle : {}) }}
                    disabled={selectedEntries.length === 0}
                    onClick={handleApply}
                  >
                    应用（{selectedEntries.length} 项）
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* 应用进度 */}
        {phase === 'applying' && progress && (
          <div style={previewStyle}>
            <div style={statusStyle}>
              同步中 {progress.done}/{progress.total}
            </div>
            <div style={progressTrackStyle}>
              <div
                style={{
                  ...progressBarStyle,
                  width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <div style={entryPathStyle}>{progress.rel}</div>
          </div>
        )}

        {/* 结果 */}
        {phase === 'done' && result && (
          <div style={previewStyle}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              ✅ 同步完成：成功 {result.applied} 项
              {result.failed.length > 0 && `，失败 ${result.failed.length} 项`}
            </div>
            {result.failed.length > 0 && (
              <div style={{ ...listStyle, maxHeight: 120 }}>
                {result.failed.map((f) => (
                  <div key={f.rel} style={entryRowStyle}>
                    <span style={{ ...badgeStyle, background: '#ef4444' }}>失败</span>
                    <span style={entryPathStyle} title={f.error}>
                      {f.rel} — {f.error}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button style={primaryBtnStyle} onClick={resetRun}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── 样式 ──────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100,
};
const dialogStyle: React.CSSProperties = {
  width: 560,
  maxWidth: '94vw',
  maxHeight: '88vh',
  overflowY: 'auto',
  padding: 18,
  borderRadius: 12,
  background: 'var(--theme-bg-secondary, #1f2030)',
  color: 'var(--theme-text, rgba(255,255,255,0.9))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
};
const closeBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
  background: 'transparent',
  color: 'var(--theme-text-muted, #aaa)',
  cursor: 'pointer',
  fontSize: 13,
};
const hintStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--theme-text-muted, #8b8b9b)',
  margin: '0 0 12px',
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
};
const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--theme-text-muted, #8b8b9b)',
  width: 96,
  flexShrink: 0,
};
const pathStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontFamily: 'monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  background: 'var(--theme-bg, rgba(0,0,0,0.3))',
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};
const smallBtnStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
  background: 'var(--theme-bg, rgba(255,255,255,0.06))',
  color: 'var(--theme-text, #fff)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
};
const actionBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '9px 12px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  background: 'var(--theme-bg, rgba(255,255,255,0.06))',
  color: 'var(--theme-text, #fff)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
};
const primaryBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  background: 'var(--theme-accent, #7aa2f7)',
  color: '#fff',
  border: 'none',
};
const disabledStyle: React.CSSProperties = {
  opacity: 0.45,
  cursor: 'not-allowed',
};
const linkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--theme-text-muted, #8b8b9b)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 0',
};
const ignoreTextareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  height: 110,
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: 'monospace',
  resize: 'vertical',
  background: 'var(--theme-bg, rgba(0,0,0,0.3))',
  color: 'var(--theme-text, #fff)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
};
const errorStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '7px 10px',
  borderRadius: 6,
  fontSize: 12,
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.3)',
  color: '#f87171',
};
const statusStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--theme-text-muted, #8b8b9b)',
  padding: '6px 0',
};
const previewStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 8,
  background: 'var(--theme-bg, rgba(0,0,0,0.25))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};
const listStyle: React.CSSProperties = {
  maxHeight: 220,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const entryRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 0',
};
const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: '#fff',
  padding: '1px 6px',
  borderRadius: 4,
  flexShrink: 0,
};
const conflictBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: '#fff',
  padding: '1px 6px',
  borderRadius: 4,
  background: '#f59e0b',
  flexShrink: 0,
};
const entryPathStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontFamily: 'monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const sizeStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--theme-text-muted, #8b8b9b)',
  flexShrink: 0,
};
const conflictBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 8,
  borderRadius: 6,
  background: 'rgba(245,158,11,0.08)',
  border: '1px solid rgba(245,158,11,0.25)',
};
const radioLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  cursor: 'pointer',
  padding: '2px 0',
};
const progressTrackStyle: React.CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--theme-border, rgba(255,255,255,0.12))',
  overflow: 'hidden',
  margin: '4px 0',
};
const progressBarStyle: React.CSSProperties = {
  height: '100%',
  background: 'var(--theme-accent, #7aa2f7)',
  transition: 'width 0.15s',
};

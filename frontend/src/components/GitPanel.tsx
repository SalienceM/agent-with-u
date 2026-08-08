/**
 * GitPanel — Git 日志查看面板（参照 TortoiseGit 日志信息对话框）
 * 专注查看提交历史，不涉及提交操作
 * v2: 支持按日期筛选 + 点击文件查看 diff 详情（双窗口对比）
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { DiffViewer } from './DiffViewer';
import { AppModalPortal } from './AppModalPortal';
import type { GitLogCommit } from '../types/git';

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

interface CommitFile {
  path: string;
  status: string;
  added: number;
  deleted: number;
}

const STATUS_COLORS: Record<string, string> = {
  modified: '#e3b341',
  added: '#3fb950',
  deleted: '#f85149',
  renamed: '#a371f7',
};

const STATUS_LABELS: Record<string, string> = {
  modified: '已修改',
  added: '已添加',
  deleted: '已删除',
  renamed: '已重命名',
};

export const GitPanel: React.FC<Props> = ({
  workingDir, execKey, execLabel, execMode, backendId, open, onClose, onCommitComplete,
}) => {
  const [log, setLog] = useState<GitLogCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logHasMore, setLogHasMore] = useState(false);
  const [logOffset, setLogOffset] = useState(0);
  const [selectedCommit, setSelectedCommit] = useState<GitLogCommit | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);
  const [authorFilter, setAuthorFilter] = useState('');
  const [toast, setToast] = useState('');

  // v2: 日期筛选 + 文件 diff 查看
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState('');
  const [fileDiffBinary, setFileDiffBinary] = useState(false);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);

  // 加载 commit 列表（带日期筛选）
  const loadLog = useCallback(async (offset = 0, append = false) => {
    setLogLoading(true);
    try {
      const res = await api.gitLog(workingDir, 50, offset, execKey, sinceDate || undefined, untilDate || undefined);
      if (append) {
        setLog((prev) => [...prev, ...res.commits]);
      } else {
        setLog(res.commits);
      }
      setLogHasMore(res.hasMore);
      setLogOffset(offset + (res.commits.length || 0));
    } finally {
      setLogLoading(false);
    }
  }, [workingDir, execKey, sinceDate, untilDate]);

  // 加载 commit 的文件变更
  const loadCommitFiles = useCallback(async (hash: string) => {
    setCommitFilesLoading(true);
    setSelectedCommit(log.find((c) => c.hash === hash) || null);
    setSelectedFile(null);
    setFileDiff('');
    try {
      const res = await api.gitShow(workingDir, hash, execKey);
      setCommitFiles(res.files || []);
    } finally {
      setCommitFilesLoading(false);
    }
  }, [workingDir, execKey, log]);

  // 加载文件 diff 内容
  const loadFileDiff = useCallback(async (filePath: string) => {
    if (!selectedCommit) return;
    setSelectedFile(filePath);
    setFileDiffLoading(true);
    setFileDiff('');
    setFileDiffBinary(false);
    try {
      const res = await api.gitCommitFileDiff(workingDir, selectedCommit.hash, filePath, execKey);
      setFileDiff(res.diff || '');
      setFileDiffBinary(res.binary || false);
    } finally {
      setFileDiffLoading(false);
    }
  }, [workingDir, execKey, selectedCommit]);

  // 初始加载
  useEffect(() => {
    if (open && workingDir) {
      loadLog(0, false);
      setSelectedCommit(null);
      setCommitFiles([]);
      setSelectedFile(null);
      setFileDiff('');
    }
  }, [open, workingDir, loadLog]);

  // 加载更多
  const loadMore = () => {
    if (!logHasMore || logLoading) return;
    loadLog(logOffset, true);
  };

  // 复制 hash
  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash).then(() => {
      setToast('已复制 SHA-1');
      setTimeout(() => setToast(''), 2000);
    });
  };

  // 日期变化时重新加载（重置分页和选中状态）
  const handleDateChange = (setter: React.Dispatch<React.SetStateAction<string>>) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value);
    setSelectedCommit(null);
    setCommitFiles([]);
    setSelectedFile(null);
    setFileDiff('');
  };

  if (!open) return null;

  return (
    <AppModalPortal>
      <div style={overlayStyle} onClick={onClose}>
        <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 顶栏 */}
        <div style={headerStyle}>
          <span style={{ fontSize: 15 }}>📋</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#c9d1d9' }}>Git 日志</span>
          {execLabel && <span style={tagStyle}>{execLabel}</span>}
          <div style={{ flex: 1 }} />
          {/* 作者筛选 */}
          <input
            type="text"
            placeholder="作者筛选..."
            value={authorFilter}
            onChange={(e) => setAuthorFilter(e.target.value)}
            style={filterInputStyle}
          />
          {/* 日期筛选 */}
          <span style={{ fontSize: 10, color: '#6e7681' }}>从</span>
          <input
            type="date"
            value={sinceDate}
            onChange={handleDateChange(setSinceDate)}
            style={dateInputStyle}
          />
          <span style={{ fontSize: 10, color: '#6e7681' }}>至</span>
          <input
            type="date"
            value={untilDate}
            onChange={handleDateChange(setUntilDate)}
            style={dateInputStyle}
          />
          <button style={closeBtnStyle} onClick={onClose}>✕</button>
        </div>

        {/* Commit 列表 */}
        <div style={logListStyle}>
          {logLoading && log.length === 0 ? (
            <div style={emptyStyle}>加载提交历史…</div>
          ) : log.length === 0 ? (
            <div style={emptyStyle}>
              {sinceDate || untilDate ? '所选日期范围内无提交记录' : '无提交记录'}
            </div>
          ) : (
            <>
              {log
                .filter((c) => !authorFilter || c.author.toLowerCase().includes(authorFilter.toLowerCase()))
                .map((c) => (
                  <div
                    key={c.hash}
                    style={{
                      ...logItemStyle,
                      ...(selectedCommit?.hash === c.hash ? { background: 'rgba(9,105,218,0.15)' } : {}),
                    }}
                    onClick={() => loadCommitFiles(c.hash)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        onClick={(e) => { e.stopPropagation(); copyHash(c.hash); }}
                        style={hashStyle}
                        title="点击复制完整 hash"
                      >
                        {c.shortHash}
                      </span>
                      <span style={authorStyle}>{c.author}</span>
                      <span style={dateStyle}>{new Date(c.date).toLocaleString('zh-CN')}</span>
                    </div>
                    <div style={messageStyle}>{c.message}</div>
                  </div>
                ))}
              {logHasMore && (
                <div style={{ textAlign: 'center', padding: '12px 0' }}>
                  <button onClick={loadMore} disabled={logLoading} style={loadMoreBtnStyle}>
                    {logLoading ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 选中 commit 的详情：文件列表 OR 文件 diff */}
        {selectedCommit && (
          <div style={detailSectionStyle}>
            {/* 详情头：commit 信息 + 返回按钮 */}
            <div style={detailHeaderStyle}>
              {selectedFile ? (
                <>
                  <button
                    onClick={() => { setSelectedFile(null); setFileDiff(''); }}
                    style={backBtnStyle}
                    title="返回文件列表"
                  >
                    ← 文件列表
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#c9d1d9', fontFamily: 'monospace' }}>
                    {selectedFile}
                  </span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#c9d1d9' }}>
                    文件变更 ({commitFiles.length})
                  </span>
                  <span style={{ fontSize: 11, color: '#8b949e', marginLeft: 8, fontFamily: 'monospace' }}>
                    {selectedCommit.shortHash} {selectedCommit.message}
                  </span>
                </>
              )}
            </div>

            {selectedFile ? (
              /* ── 文件 diff 视图 ── */
              <div style={diffViewerWrapStyle}>
                {fileDiffLoading ? (
                  <div style={emptyStyle}>加载差异…</div>
                ) : fileDiff ? (
                  <DiffViewer diff={fileDiff} filename={selectedFile} binary={fileDiffBinary} />
                ) : (
                  <div style={emptyStyle}>无差异内容</div>
                )}
              </div>
            ) : (
              /* ── 文件列表 ── */
              <div style={fileListStyle}>
                {commitFilesLoading ? (
                  <div style={emptyStyle}>加载文件变更…</div>
                ) : commitFiles.length === 0 ? (
                  <div style={emptyStyle}>无文件变更</div>
                ) : (
                  <>
                    {/* 表头 */}
                    <div style={fileHeaderStyle}>
                      <span style={{ flex: 2 }}>路径</span>
                      <span style={{ flex: 1, textAlign: 'center' }}>状态</span>
                      <span style={{ flex: 0.8, textAlign: 'right' }}>添加</span>
                      <span style={{ flex: 0.8, textAlign: 'right' }}>删除</span>
                    </div>
                    {commitFiles.map((f, i) => (
                      <div
                        key={i}
                        style={fileRowStyle}
                        onClick={() => loadFileDiff(f.path)}
                        title="点击查看文件差异"
                      >
                        <span style={{ flex: 2, fontFamily: 'monospace', fontSize: 11, color: '#c9d1d9' }}>{f.path}</span>
                        <span style={{ flex: 1, textAlign: 'center', color: STATUS_COLORS[f.status] || '#8b949e', fontSize: 11 }}>
                          {STATUS_LABELS[f.status] || f.status}
                        </span>
                        <span style={{ flex: 0.8, textAlign: 'right', color: '#3fb950', fontSize: 11 }}>+{f.added}</span>
                        <span style={{ flex: 0.8, textAlign: 'right', color: '#f85149', fontSize: 11 }}>-{f.deleted}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* 底部栏 */}
        <div style={footerStyle}>
          <span style={{ fontSize: 11, color: '#8b949e' }}>
            已显示 {log.length} 个提交
            {authorFilter && <span> · 作者: {authorFilter}</span>}
            {(sinceDate || untilDate) && <span> · {sinceDate || '…'} ~ {untilDate || '…'}</span>}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => loadLog(0, false)} style={footerBtnStyle}>刷新</button>
        </div>

        {/* Toast 提示 */}
        {toast && <div style={toastStyle}>{toast}</div>}
        </div>
      </div>
    </AppModalPortal>
  );
};

// ── 样式 ──

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9000,
  background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const panelStyle: React.CSSProperties = {
  width: '85vw', maxWidth: 1200, height: '85vh',
  background: '#161b22', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)', flexShrink: 0,
};

const tagStyle: React.CSSProperties = {
  fontSize: 10, color: '#8b949e', background: 'rgba(255,255,255,0.06)',
  padding: '2px 6px', borderRadius: 4,
};

const filterInputStyle: React.CSSProperties = {
  padding: '4px 8px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)',
  color: '#c9d1d9', width: 120,
};

const dateInputStyle: React.CSSProperties = {
  padding: '3px 6px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)',
  color: '#c9d1d9', width: 120,
  colorScheme: 'dark',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#8b949e',
  cursor: 'pointer', fontSize: 16, padding: '0 4px',
};

const logListStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', borderBottom: '1px solid rgba(255,255,255,0.08)',
};

const logItemStyle: React.CSSProperties = {
  padding: '8px 16px', cursor: 'pointer',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  transition: 'background 0.12s',
};

const hashStyle: React.CSSProperties = {
  fontFamily: 'monospace', fontSize: 11, color: '#58a6ff',
  background: 'rgba(88,166,255,0.1)', padding: '1px 6px',
  borderRadius: 4, cursor: 'pointer', userSelect: 'all',
};

const authorStyle: React.CSSProperties = {
  fontSize: 12, color: '#8b949e',
};

const dateStyle: React.CSSProperties = {
  fontSize: 10, color: '#6e7681',
};

const messageStyle: React.CSSProperties = {
  fontSize: 13, marginTop: 4, color: '#c9d1d9',
};

const detailSectionStyle: React.CSSProperties = {
  maxHeight: '45%', flexShrink: 0,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
};

const detailHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 16px', background: 'rgba(255,255,255,0.02)',
  flexShrink: 0,
};

const backBtnStyle: React.CSSProperties = {
  padding: '2px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)',
  color: '#58a6ff', cursor: 'pointer', whiteSpace: 'nowrap',
};

const fileListStyle: React.CSSProperties = {
  padding: '0 16px 8px',
  overflowY: 'auto', flex: 1,
};

const fileHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '4px 0', fontSize: 10, color: '#8b949e',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const fileRowStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 0', fontSize: 11,
  borderBottom: '1px solid rgba(255,255,255,0.03)',
  cursor: 'pointer', borderRadius: 4,
  transition: 'background 0.1s',
};

const diffViewerWrapStyle: React.CSSProperties = {
  flex: 1, minHeight: 250, overflow: 'hidden',
};

const footerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 16px', background: 'rgba(255,255,255,0.02)', flexShrink: 0,
};

const footerBtnStyle: React.CSSProperties = {
  padding: '4px 12px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};

const loadMoreBtnStyle: React.CSSProperties = {
  padding: '6px 16px', fontSize: 12, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};

const emptyStyle: React.CSSProperties = {
  padding: '24px 0', textAlign: 'center', color: '#8b949e', fontSize: 13,
};

const toastStyle: React.CSSProperties = {
  position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
  padding: '6px 14px', fontSize: 12, borderRadius: 6,
  background: 'rgba(63,185,80,0.9)', color: '#fff',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
};

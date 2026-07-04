/**
 * ServerDirPicker — 服务器端文件/目录选择器。
 *
 * C/S 架构下，会话的工作目录、导入导出的文件都在「服务器」上，不能用客户端
 * 原生文件对话框（那会选到手机/浏览器本机的目录）。本组件通过后端
 * listDirectory / getDirRoots RPC 浏览服务器文件系统。
 *
 * 三种模式：
 *  - 'dir'  选择一个目录（默认）
 *  - 'open' 选择一个已存在的文件
 *  - 'save' 选择目录并输入文件名，返回拼接后的完整路径
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api, getExecutors } from '../api';

type PickerMode = 'dir' | 'open' | 'save';

interface Props {
  initialPath?: string;
  mode?: PickerMode;
  /** 指定执行节点：浏览该节点的文件系统；缺省 = home 节点。
   *  Tauri 远端也用它（替代本机原生目录对话框）。
   */
  execKey?: string;
  /** save 模式下预填的文件名 */
  saveFilename?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface Entry { name: string; path: string; isDir: boolean }

export const ServerDirPicker: React.FC<Props> = ({
  initialPath, mode = 'dir', execKey, saveFilename, onSelect, onCancel,
}) => {
  const [sep, setSep] = useState('/');
  const [roots, setRoots] = useState<{ home: string; cwd: string; roots: string[] }>({
    home: '', cwd: '', roots: [],
  });
  const [cur, setCur] = useState(initialPath || '');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [filename, setFilename] = useState(saveFilename || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const showFiles = mode !== 'dir';

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    setSelectedFile('');
    try {
      const list = await api.listDirectory(path, '', execKey);
      // listDirectory 出错时返回 []；用 getDirRoots 的路径兜底则不会到这
      setEntries(showFiles ? list : list.filter((e) => e.isDir));
      setCur(path);
    } finally {
      setLoading(false);
    }
  }, [showFiles, execKey]);

  useEffect(() => {
    (async () => {
      const r = await api.getDirRoots(execKey);
      setRoots({ home: r.home, cwd: r.cwd, roots: r.roots });
      setSep(r.sep || '/');
      await browse(initialPath || r.cwd || r.home || (r.roots[0] || '/'));
    })();
  }, [browse, initialPath, execKey]);

  const goUp = useCallback(() => {
    const trimmed = cur.replace(/[/\\]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (idx <= 0) {
      // 到达盘符根 / 文件系统根
      browse(trimmed.match(/^[A-Za-z]:$/) ? trimmed + '\\' : (idx === 0 ? '/' : trimmed));
      return;
    }
    browse(trimmed.slice(0, idx) || sep);
  }, [cur, sep, browse]);

  const joinPath = useCallback((dir: string, name: string) => {
    return dir.replace(/[/\\]+$/, '') + sep + name;
  }, [sep]);

  const handleEntryClick = useCallback((e: Entry) => {
    if (e.isDir) {
      browse(e.path);
    } else if (mode === 'open') {
      setSelectedFile(e.path);
    } else if (mode === 'save') {
      setFilename(e.name);
    }
  }, [browse, mode]);

  const confirmDisabled =
    (mode === 'open' && !selectedFile) ||
    (mode === 'save' && !filename.trim());

  const handleConfirm = useCallback(() => {
    if (mode === 'open') {
      if (selectedFile) onSelect(selectedFile);
    } else if (mode === 'save') {
      if (filename.trim()) onSelect(joinPath(cur, filename.trim()));
    } else {
      onSelect(cur);
    }
  }, [mode, selectedFile, filename, cur, joinPath, onSelect]);

  const title =
    mode === 'open' ? '选择服务器文件'
      : mode === 'save' ? '保存到服务器'
        : '选择服务器目录';
  const confirmLabel =
    mode === 'open' ? '选择此文件'
      : mode === 'save' ? '保存'
        : '选择此目录';

  // 远端节点时显示节点标签，让用户知道正在浏览哪台机器
  const executors = getExecutors();
  const currentNode = executors.find((ex) => ex.key === execKey);
  const nodeLabel = currentNode
    ? (currentNode.isHome ? '' : ` 🌐 ${currentNode.label}`)
    : '';

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
          {title}{nodeLabel && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--theme-text-muted, #aaa)', marginLeft: 8 }}>{nodeLabel}</span>}
        </div>

        {/* 快捷入口 */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {roots.home && <button style={chipStyle} onClick={() => browse(roots.home)}>🏠 Home</button>}
          {roots.cwd && <button style={chipStyle} onClick={() => browse(roots.cwd)}>📂 工作区</button>}
          {roots.roots.map((r) => (
            <button key={r} style={chipStyle} onClick={() => browse(r)}>💾 {r}</button>
          ))}
        </div>

        {/* 当前路径（可手输）+ 上级 */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button style={btnStyle} onClick={goUp} title="上级目录">⬆</button>
          <input
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') browse(cur); }}
            style={inputStyle}
            spellCheck={false}
          />
          <button style={btnStyle} onClick={() => browse(cur)}>转到</button>
        </div>

        {/* 目录/文件列表 */}
        <div style={listStyle}>
          {loading && <div style={hintStyle}>加载中…</div>}
          {!loading && error && <div style={{ ...hintStyle, color: '#f85149' }}>{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div style={hintStyle}>{showFiles ? '（空目录）' : '（无子目录）'}</div>
          )}
          {!loading && entries.map((e) => (
            <div
              key={e.path}
              style={{
                ...rowStyle,
                ...(e.path === selectedFile ? rowSelectedStyle : {}),
                ...(!e.isDir && mode === 'dir' ? rowDisabledStyle : {}),
              }}
              onClick={() => handleEntryClick(e)}
              onDoubleClick={() => e.isDir && browse(e.path)}
            >
              {e.isDir ? '📁' : '📄'} {e.name}
            </div>
          ))}
        </div>

        {/* save 模式：文件名输入 */}
        {mode === 'save' && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #aaa)' }}>文件名</span>
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              style={inputStyle}
              spellCheck={false}
              placeholder="export.tar.gz"
            />
          </div>
        )}

        {/* 操作 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button style={btnStyle} onClick={onCancel}>取消</button>
          <button
            style={{
              ...btnStyle,
              background: 'var(--theme-accent, #7aa2f7)', color: '#fff', border: 'none',
              ...(confirmDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
            }}
            disabled={confirmDisabled}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── 样式 ──────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const dialogStyle: React.CSSProperties = {
  width: 480, maxWidth: '92vw', padding: 16, borderRadius: 12,
  background: 'var(--theme-bg-secondary, #1f2030)',
  color: 'var(--theme-text, rgba(255,255,255,0.9))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
};
const listStyle: React.CSSProperties = {
  height: 260, overflowY: 'auto', borderRadius: 8,
  background: 'var(--theme-bg, rgba(0,0,0,0.25))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  padding: 4,
};
const rowStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const rowSelectedStyle: React.CSSProperties = {
  background: 'var(--theme-accent, #7aa2f7)', color: '#fff',
};
const rowDisabledStyle: React.CSSProperties = {
  opacity: 0.4, cursor: 'default',
};
const hintStyle: React.CSSProperties = {
  padding: '16px 8px', textAlign: 'center', fontSize: 12,
  color: 'var(--theme-text-muted, #656d76)',
};
const inputStyle: React.CSSProperties = {
  flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 12,
  background: 'var(--theme-bg, rgba(0,0,0,0.3))',
  color: 'var(--theme-text, #fff)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
  fontFamily: 'monospace',
};
const btnStyle: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
  background: 'var(--theme-bg, rgba(255,255,255,0.06))',
  color: 'var(--theme-text, #fff)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.15))',
};
const chipStyle: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 14, fontSize: 11, cursor: 'pointer',
  background: 'var(--theme-bg, rgba(255,255,255,0.06))',
  color: 'var(--theme-text-muted, #aaa)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))',
};

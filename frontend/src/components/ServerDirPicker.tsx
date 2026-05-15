/**
 * ServerDirPicker — 服务器端目录选择器。
 *
 * C/S 架构下，会话的工作目录是「服务器」上的路径，不能用客户端原生
 * 文件对话框（那会选到手机/浏览器本机的目录）。本组件通过后端
 * listDirectory / getDirRoots RPC 浏览服务器文件系统。
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface Entry { name: string; path: string; isDir: boolean }

export const ServerDirPicker: React.FC<Props> = ({ initialPath, onSelect, onCancel }) => {
  const [sep, setSep] = useState('/');
  const [roots, setRoots] = useState<{ home: string; cwd: string; roots: string[] }>({
    home: '', cwd: '', roots: [],
  });
  const [cur, setCur] = useState(initialPath || '');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const list = await api.listDirectory(path, '');
      // listDirectory 出错时返回 []；用 getDirRoots 的路径兜底则不会到这
      setEntries(list.filter((e) => e.isDir));
      setCur(path);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api.getDirRoots();
      setRoots({ home: r.home, cwd: r.cwd, roots: r.roots });
      setSep(r.sep || '/');
      await browse(initialPath || r.cwd || r.home || (r.roots[0] || '/'));
    })();
  }, [browse, initialPath]);

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

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
          选择服务器目录
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

        {/* 子目录列表 */}
        <div style={listStyle}>
          {loading && <div style={hintStyle}>加载中…</div>}
          {!loading && error && <div style={{ ...hintStyle, color: '#f85149' }}>{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div style={hintStyle}>（无子目录）</div>
          )}
          {!loading && entries.map((e) => (
            <div
              key={e.path}
              style={rowStyle}
              onClick={() => browse(e.path)}
              onDoubleClick={() => browse(e.path)}
            >
              📁 {e.name}
            </div>
          ))}
        </div>

        {/* 操作 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button style={btnStyle} onClick={onCancel}>取消</button>
          <button
            style={{ ...btnStyle, background: 'var(--theme-accent, #7aa2f7)', color: '#fff', border: 'none' }}
            onClick={() => onSelect(cur)}
          >
            选择此目录
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

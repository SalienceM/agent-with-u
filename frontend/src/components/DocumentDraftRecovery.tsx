import React, { useEffect, useRef, useState } from 'react';
import { getCurrentUserProfile, onCurrentUserChanged } from '../api';
import { documentDrafts, inspectStoredDraft, type StoredDocumentDraft } from '../utils/documentDrafts';
import { AppModalPortal } from './AppModalPortal';

interface Props {
  owner: string;
  onClose: () => void;
  onExport: (text: string, filename: string, mime: string) => Promise<unknown>;
}

/** 不依赖执行端在线，不把旧身份草稿附到新文件。读取只由打开/刷新触发。 */
export const DocumentDraftRecovery: React.FC<Props> = ({ owner, onClose, onExport }) => {
  const [rows, setRows] = useState<StoredDocumentDraft[]>([]);
  const [selected, setSelected] = useState<StoredDocumentDraft | null>(null);
  const [message, setMessage] = useState('正在读取本设备草稿…');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), alive = useRef(true);
  const current = () => alive.current && getCurrentUserProfile().userId === owner;
  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await documentDrafts.listOwner(owner);
      if (current() && request === generation.current) { setRows(result); setSelected(null); setMessage(result.length ? '' : '本设备没有此账号的持久草稿。'); }
    } catch { if (current() && request === generation.current) setMessage('草稿存储不可用，未删除任何记录。编辑器中的内容仍可导出。'); }
    finally { if (current() && request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void refresh();
    const stop = onCurrentUserChanged((_profile, changed) => {
      if (changed) { alive.current = false; generation.current++; setRows([]); setSelected(null); onClose(); }
    });
    return () => { alive.current = false; generation.current++; stop(); };
    // 以 owner 为隔离边界；换账号卸载，不将旧请求的返回值写入新视图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  if (!current()) return null;
  const content = selected ? inspectStoredDraft(selected, owner) : null;
  return <AppModalPortal><div style={overlayStyle} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <section role="dialog" aria-modal="true" aria-label="本设备草稿恢复" style={panelStyle}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong style={{ flex: 1 }}>本设备草稿</strong>
        <button disabled={busy} onClick={() => void refresh()}>刷新草稿列表</button>
        <button autoFocus onClick={onClose}>关闭草稿恢复</button>
      </div>
      <p>仅此账号 · 未加密 · 不自动保存或上传。执行端重启、目录变化或离线时，可在这里只读恢复并导出；不会重绑写目标。未知保存须回到原文档核对。</p>
      {message && <div role="status">{message}</div>}
      <div style={{ overflowY: 'auto', maxHeight: '30vh' }}>
        {rows.map(row => {
          let label = '无法解析的草稿';
          try { const identity = JSON.parse(row.documentKey); label = `${identity[5] === 'local-copy' ? '本机副本' : '执行端'} · ${identity[6]} · ${identity[3]} · ${identity[1]}`; } catch { /* 原始记录可导出 */ }
          return <div key={row.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--theme-border)' }}>
            <div style={{ overflowWrap: 'anywhere' }}>{label}</div>
            <small>{new Date(row.updatedAt).toLocaleString()} · 窗口 {row.branch.slice(0, 8)}</small>{' '}
            <button onClick={() => setSelected(row)}>只读恢复草稿</button>{' '}
            <button disabled={busy} onClick={async () => {
              if (!current() || !window.confirm('只删除这条本设备草稿记录？不会修改磁盘文件；建议先导出。其他窗口可能仍持有自己的草稿。')) return;
              setBusy(true);
              try { await documentDrafts.removeStored(row, owner, current); if (current()) await refresh(); }
              catch (error: any) { if (current()) setMessage(`未删除：${error?.message || '存储不可用或记录已变化'}。请核对保存、放弃编辑器草稿或刷新列表。`); }
              finally { if (current()) setBusy(false); }
            }}>删除此草稿记录</button>
          </div>;
        })}
      </div>
      {selected && content && <div>
        <p>{content.valid ? '已只读恢复；未保存文件。' : '记录损坏：显示原始数据供导出，不自动修复或丢弃。'}{content.pending && ' 此草稿有尚未核对的保存请求。'}</p>
        <textarea aria-label="离线恢复的草稿（只读）" readOnly value={content.text} rows={10} style={{ width: '100%', boxSizing: 'border-box' }} />
        <button onClick={() => { if (current()) void onExport(content.text, content.filename, 'text/plain;charset=utf-8').catch(() => { if (current()) setMessage('导出失败，原草稿仍保留。'); }); }}>导出恢复草稿</button>
      </div>}
    </section>
  </div></AppModalPortal>;
};

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1300, background: '#0009', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const panelStyle: React.CSSProperties = { background: 'var(--theme-bg, #1a1a2e)', color: 'var(--theme-text, #eee)', padding: 18, borderRadius: 10, width: 840, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', fontSize: 13 };

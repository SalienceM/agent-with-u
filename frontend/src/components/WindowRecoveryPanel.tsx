import React, { useState } from 'react';
import { getCurrentUserProfile } from '../api';
import { handoffJournal, type HandoffJournalRecord } from '../utils/workbenchHandoffState';
import { WorkbenchButton } from './WorkbenchChrome';

/** 有界恢复记录按用户列出；清理仅在显式确认后进行，不从 URL 读取正文。 */
export const WindowRecoveryPanel: React.FC<{ user: string }> = ({ user }) => {
  const [rows, setRows] = useState<HandoffJournalRecord[] | null>(null), [error, setError] = useState('');
  const current = () => getCurrentUserProfile().userId === user;
  const load = async () => { try { const result = await handoffJournal.list(user); if (current()) { setRows(result); setError(''); } }
    catch (e) { if (current()) setError(String(e)); } };
  const exportRow = (row: HandoffJournalRecord) => {
    if (!current() || row.owner !== user) return;
    const url = URL.createObjectURL(new Blob([row.payload], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `awu-window-recovery-${row.requestId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const remove = async (row: HandoffJournalRecord) => {
    if (!current() || !window.confirm('永久清理此本机交接恢复包？未保存代码和附件可能只存在于这个记录中。请先导出；清理不会保存文件或停止任务。')) return;
    try { await handoffJournal.remove(row, user); if (current()) await load(); } catch (e) { if (current()) setError(String(e)); }
  };
  return <div style={{ fontSize: 12, borderTop: '1px solid var(--theme-border)', marginTop: 6, paddingTop: 6 }}>
    <WorkbenchButton className="awu-wb-menu-action" icon="archive" aria-expanded={!!rows} onClick={() => rows ? setRows(null) : void load()}>交接恢复包</WorkbenchButton>
    {error && <span role="alert">{error}</span>}
    {rows && <div role="region" aria-label="交接恢复记录" style={{ padding: '0 8px' }}><p style={{ color: 'var(--theme-text-muted)' }}>仅本账号、本浏览器的有界记录。包含代码与草稿，不是加密保险库；不包含一次性委托。</p>
      {!rows.length && <p>没有已保存交接包。</p>}
      {rows.map(row => <div key={row.key} style={{ padding: '10px 0', borderTop: '1px solid var(--theme-border)' }}>
        <div style={{ marginBottom: 8 }}>{new Date(row.updatedAt).toLocaleString()} · {row.state} · {row.requestId.slice(0, 8)}</div>
        <div style={{ display: 'flex', gap: 6 }}><WorkbenchButton onClick={() => exportRow(row)}>导出恢复包</WorkbenchButton><WorkbenchButton onClick={() => void remove(row)}>清理此记录</WorkbenchButton></div></div>)}
    </div>}
  </div>;
};

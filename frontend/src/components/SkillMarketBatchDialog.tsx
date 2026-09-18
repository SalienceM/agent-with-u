import React, { useEffect, useRef, useState } from 'react';
import { api, onCurrentUserChanged, type SkillMarketItem } from '../api';
import { AppModalPortal } from './AppModalPortal';
import { uuid } from '../utils/uuid';

interface Props {
  items: SkillMarketItem[];
  sourceName: string;
  execKey: string;
  targetName: string;
  libraryPath: string;
  visible: boolean;
  onClose: () => void;
  onFinish: () => void;
  onInstalled: () => void;
  onPrepare?: (names: string[], execKey: string) => void;
}
const statusLabels: Record<string, string> = {
  pending: '待处理', running: '导入中', installed: '已导入', skipped: '已跳过', failed: '失败',
};

export const SkillMarketBatchDialog: React.FC<Props> = ({ items, sourceName, execKey, targetName, libraryPath, visible, onClose, onFinish, onInstalled, onPrepare }) => {
  const [approved, setApproved] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [batch, setBatch] = useState<any>(null);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState('');
  const alive = useRef(true);
  // 相同批次的网络重试复用 ID；仅重试失败条目时创建新的明确批次。
  const request = useRef<{ items: SkillMarketItem[]; replace: boolean; retry: boolean; id: string }>();
  const [uncertain, setUncertain] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    alive.current = true;
    const unsubscribe = onCurrentUserChanged((_profile, changed) => { if (changed) { alive.current = false; closeRef.current(); } });
    return () => { alive.current = false; unsubscribe(); };
  }, []);

  const rows = batch?.items || items.map(item => ({ ...item, status: 'pending', message: '' }));
  const installed = rows.filter((item: any) => item.status === 'installed');
  const skipped = rows.filter((item: any) => item.status === 'skipped');
  const failed = rows.filter((item: any) => ['failed', 'pending', 'running'].includes(item.status));
  const conflicts = items.filter(item => item.conflict || item.localModified).length;
  const start = async (retry: boolean) => {
    if (busyRef.current || (!batch && !approved)) return;
    // 回执不明确时重查原始请求，不从局部进度推断终态后再提交另一个批次。
    const chosen = request.current?.items || (retry ? items.filter(item => failed.some((row: any) => row.path === item.path)) : items);
    if (!chosen.length) return;
    if (!request.current) request.current = { items: chosen, replace, retry, id: uuid() };
    const submitted = request.current;
    retry = submitted.retry;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await api.skillMarketInstallBatch(items[0].sourceId,
        chosen.map(({ path, digest }) => ({ path, digest })), submitted.replace, submitted.id, execKey,
        (value, id) => {
          if (!alive.current) return;
          setJobId(id);
          setBatch((previous: any) => {
            if (!retry || !previous) return value;
            const updates = new Map(value.items.map((row: any) => [row.path, row]));
            return { ...value, items: previous.items.map((row: any) => updates.get(row.path) || row) };
          });
        });
      if (!alive.current) return;
      if (result.batch) {
        setBatch((previous: any) => {
          const updates = new Map(result.batch.items.map((row: any) => [row.path, row]));
          return retry && previous ? { ...result.batch, items: previous.items.map((row: any) => updates.get(row.path) || row) } : result.batch;
        });
      }
      if (result.status === 'error') setError(result.message || '批量安装失败，请核对结果');
      if (result.batch?.items?.some((row: any) => row.status === 'installed')) onInstalled();
      // 收到明确终态后下一次“重试失败项”应建立新批次，不复用已终结回执。
      request.current = undefined;
      setUncertain(false);
    } catch (reason) {
      if (alive.current) { setUncertain(true); setError(reason instanceof Error ? reason.message : '无法确认批次结果'); }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  if (!visible) return null;
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 17500, background: '#0009', display: 'grid', placeItems: 'center', padding: 12 }}>
    <section role="dialog" aria-modal="true" aria-label="安装仓库全部 Skill" style={{ width: 'min(900px, 100%)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', gap: 10, padding: 16, boxSizing: 'border-box', borderRadius: 12, background: 'var(--theme-bg)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)' }}>
      <header style={{ display: 'flex', gap: 10, alignItems: 'center' }}><strong style={{ flex: 1 }}>安装仓库全部 Skill · {items.length} 项</strong><button style={button} onClick={onClose} aria-label="关闭批量安装">✕</button></header>
      <div style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sourceName} → {targetName}<br />包含该来源全部已扫描的兼容 Skill，不受搜索过滤；不含仓库中不合规或未扫描到的目录。</div>
      <div style={{ fontSize: 12, overflowWrap: 'anywhere' }}>文件导入目录：{libraryPath}</div>
      <div style={{ fontSize: 12 }}>已是当前版本的条目会跳过；仓库内重名条目需单独选择。仅导入文件，不安装依赖、不自动启用。</div>
      {!batch && !busy && !uncertain && <>
        <label style={label}><input type="checkbox" checked={replace} onChange={event => { setReplace(event.target.checked); setApproved(false); }} />允许覆盖同名 Skill / 本地修改（检测到 {conflicts} 项，默认保留）</label>
        <label style={label}><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />我已核对本批全部条目、来源、安装节点及覆盖策略；Skill 可指导 Agent 执行命令。</label>
      </>}
      <div style={{ minHeight: 100, overflow: 'auto', border: '1px solid var(--theme-border)', borderRadius: 6 }}>
        {rows.map((row: any) => {
          const item = items.find(item => item.path === row.path);
          return <div key={row.path} style={{ display: 'flex', gap: 10, padding: '7px 10px', borderBottom: '1px solid var(--theme-border)', fontSize: 12 }}>
            <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><strong>{item?.name || row.name}</strong><div style={{ color: 'var(--theme-text-muted)' }}>{row.path || '仓库根目录'}{item?.risk?.level === 'high' ? ' · 高风险提示' : ''}</div>{row.message && <div>{row.message}</div>}
              {!batch && <div>{item?.conflict || item?.localModified ? replace ? '将覆盖现有内容' : '将保留并跳过' : item?.installed && item.sameSource && !item.updateAvailable ? '已是当前版本，将跳过' : item?.updateAvailable ? '将更新' : '将安装'}</div>}
            </div><span style={{ flexShrink: 0, color: row.status === 'failed' ? '#ef6b73' : 'var(--theme-text-muted)' }}>{statusLabels[row.status] || row.status}</span>
          </div>;
        })}
      </div>
      {batch && <div role="status" style={{ fontSize: 12 }}>{busy ? '执行端正在逐项导入' : '批次结果'}：成功 {installed.length} · 跳过 {skipped.length} · {busy ? '剩余' : '失败 / 未完成'} {failed.length}</div>}
      {error && <div role="alert" style={{ color: '#ef6b73', fontSize: 12 }}>{error}</div>}
      {jobId && <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere' }}>批次 {jobId} · 关闭窗口不取消已提交任务；依赖准备需另行确认。</div>}
      <footer style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {uncertain && !busy && <button style={primary} onClick={() => void start(false)}>重查原批次结果</button>}
        {!batch && !uncertain && <button style={primary} disabled={!approved || busy} onClick={() => void start(false)}>{busy ? '提交中…' : '确认安装全部'}</button>}
        {batch && !busy && !uncertain && failed.length > 0 && <button style={primary} onClick={() => void start(true)}>仅重试失败 / 未完成项</button>}
        {!busy && installed.length > 0 && onPrepare && <button style={button} onClick={() => onPrepare(installed.map((row: any) => row.name), execKey)}>查看运行准备（{installed.length}）</button>}
        <button style={button} onClick={onClose}>{busy ? '关闭窗口，后台继续' : '关闭'}</button>
        {!busy && !uncertain && <button style={button} onClick={onFinish}>{batch ? '完成查看，返回市场' : '取消此批次'}</button>}
      </footer>
    </section>
  </div></AppModalPortal>;
};
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', borderRadius: 6, padding: '7px 10px', minHeight: 36, cursor: 'pointer' };
const primary: React.CSSProperties = { ...button, background: 'var(--theme-accent)', color: '#fff' };
const label: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, lineHeight: 1.5 };

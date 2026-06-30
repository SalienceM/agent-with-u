/**
 * FileTreePanel — 本地 / 远端 双根目录树（替代原弹窗式目录同步）。
 *
 * 像 VSCode 左侧资源管理器那样直接看到目录树,作为侧栏的一个可切换视图：
 *   🖥️ 本地（本机副本目录,File System Access / Tauri）
 *   ☁️ 远端（会话所在执行节点上的工作目录）
 *
 * 浏览是**懒加载**的：每个目录在展开时才拉它的直接子项（远端 `listDirectory`、
 * 本地 `LocalFs.listDir`,都不算哈希）,所以超大目录也能秒开、逐层下钻。
 *
 * 「🔍 比对」是显式动作：才会全量拉两端清单(含哈希)做三向比对,给每个文件标
 * 已同步 / 不同 / 冲突 / 仅本地 / 仅远端,并在树上高亮。不点比对就不做这件重活。
 *
 * 每个文件 / 整个目录都能就地同步：本地节点 ⬆ 推送到远端,远端节点 ⬇ 拉取到本地。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  pickLocalDir, restoreLocalDir, loadBaseline, saveBaseline,
  type LocalFs, type Manifest,
} from '../utils/dirSync';

interface Props {
  workingDir: string;    // 远端工作目录（当前会话）
  execKey?: string;      // 远端执行节点；缺省回落 home
  execLabel?: string;    // 远端节点显示名
}

interface TNode {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
}

type Side = 'local' | 'remote';
const ck = (side: Side, rel: string) => `${side}:${rel}`;

function relsUnder(manifest: Manifest, rel: string, isDir: boolean): string[] {
  if (!isDir) return [rel];
  const prefix = rel ? `${rel}/` : '';
  return Object.keys(manifest).filter((r) => !rel || r === rel || r.startsWith(prefix));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── 比对状态（仅在「比对」模式下计算）────────────────────────────────
type FileStatus = 'synced' | 'differs' | 'conflict' | 'local-only' | 'remote-only';
type NodeStatus = FileStatus | 'changed';

const STATUS_COLOR: Record<NodeStatus, string> = {
  synced: '#9ca3af', differs: '#f59e0b', conflict: '#ef4444',
  'local-only': '#22c55e', 'remote-only': '#3b82f6', changed: '#f59e0b',
};
const STATUS_LABEL: Record<NodeStatus, string> = {
  synced: '已同步', differs: '两端内容不同', conflict: '冲突：两端都改过',
  'local-only': '仅本地有', 'remote-only': '仅远端有', changed: '内有变更',
};

function computeStatus(local: Manifest | null, remote: Manifest | null, baseline: Manifest): Record<string, FileStatus> {
  const out: Record<string, FileStatus> = {};
  const rels = new Set<string>([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const rel of rels) {
    const L = local?.[rel]?.hash;
    const R = remote?.[rel]?.hash;
    const B = baseline[rel]?.hash;
    if (L && R) out[rel] = L === R ? 'synced' : (L !== B && R !== B ? 'conflict' : 'differs');
    else if (L) out[rel] = 'local-only';
    else if (R) out[rel] = 'remote-only';
  }
  return out;
}

function aggregateStatus(rels: string[], statusMap: Record<string, FileStatus>): NodeStatus {
  let changed = false;
  for (const r of rels) {
    const s = statusMap[r];
    if (s === 'conflict') return 'conflict';
    if (s && s !== 'synced') changed = true;
  }
  return changed ? 'changed' : 'synced';
}

export const FileTreePanel: React.FC<Props> = ({ workingDir, execKey, execLabel }) => {
  const [localFs, setLocalFs] = useState<LocalFs | null>(null);
  // 懒加载层级缓存：key=`${side}:${rel}` → 直接子项
  const [children, setChildren] = useState<Record<string, TNode[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 比对（显式、全量）
  const [compareOn, setCompareOn] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [localManifest, setLocalManifest] = useState<Manifest | null>(null);
  const [remoteManifest, setRemoteManifest] = useState<Manifest | null>(null);
  const [baseline, setBaseline] = useState<Manifest>({});

  // ── 懒加载某目录的直接子项 ───────────────────────────────────────
  const loadChildren = useCallback(async (side: Side, rel: string): Promise<void> => {
    const key = ck(side, rel);
    setLoading((p) => ({ ...p, [key]: true }));
    try {
      let nodes: TNode[];
      if (side === 'remote') {
        if (!workingDir) { nodes = []; }
        else {
          const ents = await api.listDirectory(rel, workingDir, execKey);
          nodes = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
        }
      } else {
        if (!localFs) { nodes = []; }
        else {
          const ents = await localFs.listDir(rel);
          nodes = ents.map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, isDir: e.isDir, size: e.size }));
        }
      }
      nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      setChildren((p) => ({ ...p, [key]: nodes }));
    } catch (e: any) {
      setMsg({ kind: 'err', text: `${side === 'remote' ? '远端' : '本地'}目录读取失败：${e?.message ?? e}` });
      setChildren((p) => ({ ...p, [key]: [] }));
    } finally {
      setLoading((p) => ({ ...p, [key]: false }));
    }
  }, [workingDir, execKey, localFs]);

  // 重新加载某一侧所有已展开层级（同步后刷新结构）
  const reloadSide = useCallback(async (side: Side) => {
    const keys = Object.keys(children).filter((k) => k.startsWith(`${side}:`));
    await Promise.all(keys.map((k) => loadChildren(side, k.slice(side.length + 1))));
  }, [children, loadChildren]);

  // 远端根：随会话切换重载
  useEffect(() => {
    setChildren((p) => { const n = { ...p }; for (const k of Object.keys(n)) if (k.startsWith('remote:')) delete n[k]; return n; });
    if (workingDir) loadChildren('remote', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, execKey]);

  // 本地：恢复上次目录并加载根
  useEffect(() => {
    let cancelled = false;
    restoreLocalDir().then((fs) => {
      if (cancelled || !fs) return;
      setLocalFs(fs);
    }).catch(() => { /* 需重新授权 */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (localFs) loadChildren('local', ''); /* eslint-disable-next-line */ }, [localFs]);

  const handlePickLocal = useCallback(async () => {
    setMsg(null);
    try {
      const fs = await pickLocalDir();
      if (fs) { setLocalFs(fs); setChildren((p) => { const n = { ...p }; for (const k of Object.keys(n)) if (k.startsWith('local:')) delete n[k]; return n; }); }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? String(e) });
    }
  }, []);

  const toggle = useCallback((side: Side, node: TNode) => {
    if (!node.isDir) return;
    const key = ck(side, node.rel);
    const willOpen = !expanded[key];
    setExpanded((p) => ({ ...p, [key]: willOpen }));
    if (willOpen && children[key] === undefined) loadChildren(side, node.rel);
  }, [expanded, children, loadChildren]);

  // ── 比对（显式全量）─────────────────────────────────────────────
  const runCompare = useCallback(async () => {
    if (!workingDir) { setMsg({ kind: 'err', text: '请先打开一个会话' }); return; }
    if (!localFs) { setMsg({ kind: 'err', text: '请先在「本地」选择一个目录' }); return; }
    setComparing(true);
    setMsg(null);
    try {
      const [lm, rm] = await Promise.all([
        localFs.scan([]),
        api.syncManifest(workingDir, execKey).then((r) => (r.status === 'ok' && r.files) ? r.files : {}),
      ]);
      setLocalManifest(lm);
      setRemoteManifest(rm);
      setBaseline(loadBaseline(localFs.id(), workingDir));
      setCompareOn(true);
    } catch (e: any) {
      setMsg({ kind: 'err', text: `比对失败：${e?.message ?? e}` });
    } finally {
      setComparing(false);
    }
  }, [workingDir, execKey, localFs]);

  const exitCompare = useCallback(() => {
    setCompareOn(false);
    setLocalManifest(null);
    setRemoteManifest(null);
  }, []);

  const statusMap = useMemo(
    () => (compareOn ? computeStatus(localManifest, remoteManifest, baseline) : {}),
    [compareOn, localManifest, remoteManifest, baseline],
  );
  const summary = useMemo(() => {
    const c = { conflict: 0, differs: 0, 'local-only': 0, 'remote-only': 0, synced: 0 } as Record<FileStatus, number>;
    for (const s of Object.values(statusMap)) c[s]++;
    return c;
  }, [statusMap]);

  const nodeStatus = useCallback((side: Side, n: TNode): NodeStatus | null => {
    if (!compareOn) return null;
    if (!n.isDir) return statusMap[n.rel] ?? null;
    const m = side === 'local' ? localManifest : remoteManifest;
    if (!m) return null;
    return aggregateStatus(relsUnder(m, n.rel, true), statusMap);
  }, [compareOn, statusMap, localManifest, remoteManifest]);

  const bumpBaseline = useCallback((rels: string[], src: Manifest | null) => {
    if (!localFs || !workingDir || !src) return;
    setBaseline((prev) => {
      const next = { ...prev };
      for (const rel of rels) if (src[rel]) next[rel] = src[rel];
      saveBaseline(localFs.id(), workingDir, next);
      return next;
    });
  }, [localFs, workingDir]);

  // 收集某节点下所有文件 rel：比对模式用清单,否则递归逐层列。
  const collectFiles = useCallback(async (side: Side, node: TNode): Promise<string[]> => {
    if (!node.isDir) return [node.rel];
    if (compareOn) {
      const m = side === 'local' ? localManifest : remoteManifest;
      if (m) return relsUnder(m, node.rel, true);
    }
    const out: string[] = [];
    const walk = async (rel: string) => {
      let kids = children[ck(side, rel)];
      if (kids === undefined) {
        // 未加载过：临时列一层
        if (side === 'remote') {
          const ents = workingDir ? await api.listDirectory(rel, workingDir, execKey) : [];
          kids = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
        } else {
          const ents = localFs ? await localFs.listDir(rel) : [];
          kids = ents.map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, isDir: e.isDir, size: e.size }));
        }
      }
      for (const k of kids) { if (k.isDir) await walk(k.rel); else out.push(k.rel); }
    };
    await walk(node.rel);
    return out;
  }, [compareOn, localManifest, remoteManifest, children, workingDir, execKey, localFs]);

  const pushNode = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir) { setMsg({ kind: 'err', text: '需要本地目录与已打开的会话' }); return; }
    setMsg(null); setBusy('准备推送…');
    try {
      const rels = await collectFiles('local', node);
      if (node.isDir && !window.confirm(`把「${node.name || '根'}」下的 ${rels.length} 个文件推送到远端？`)) { setBusy(''); return; }
      const okRels: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`推送 ${i + 1}/${rels.length}：${rels[i]}`);
        const b64 = await localFs.readFile(rels[i]);
        const r = await api.syncWriteFile(workingDir, rels[i], b64, execKey);
        if (r.status === 'ok') okRels.push(rels[i]);
      }
      bumpBaseline(okRels, localManifest);
      setMsg({ kind: 'ok', text: `✓ 已推送 ${okRels.length}/${rels.length} 个文件到远端` });
      reloadSide('remote');
      if (compareOn) runCompare();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `推送失败：${e?.message ?? e}` });
    } finally { setBusy(''); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, localManifest, reloadSide, compareOn, runCompare]);

  const pullNode = useCallback(async (node: TNode) => {
    if (!localFs) { setMsg({ kind: 'err', text: '请先在「本地」选择一个目录作为落地处' }); return; }
    if (!workingDir) return;
    setMsg(null); setBusy('准备拉取…');
    try {
      const rels = await collectFiles('remote', node);
      if (node.isDir && !window.confirm(`把远端「${node.name || '根'}」下的 ${rels.length} 个文件拉取到本地？`)) { setBusy(''); return; }
      const okRels: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`拉取 ${i + 1}/${rels.length}：${rels[i]}`);
        const r = await api.syncReadFile(workingDir, rels[i], execKey);
        if (r.status === 'ok' && r.data != null) { await localFs.writeFile(rels[i], r.data); okRels.push(rels[i]); }
      }
      bumpBaseline(okRels, remoteManifest);
      setMsg({ kind: 'ok', text: `✓ 已拉取 ${okRels.length}/${rels.length} 个文件到本地` });
      reloadSide('local');
      if (compareOn) runCompare();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `拉取失败：${e?.message ?? e}` });
    } finally { setBusy(''); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, remoteManifest, reloadSide, compareOn, runCompare]);

  // ── 渲染 ─────────────────────────────────────────────────────────
  const renderDir = (side: Side, rel: string, depth: number): React.ReactNode => {
    const key = ck(side, rel);
    const nodes = children[key];
    if (nodes === undefined) {
      return loading[key] ? <div style={{ ...emptyStyle, paddingLeft: 8 + depth * 14 }}>加载中…</div> : null;
    }
    if (nodes.length === 0 && depth === 0) return <Empty text="（空目录）" />;
    return nodes.map((n) => {
      const nk = ck(side, n.rel);
      const open = !!expanded[nk];
      const st = nodeStatus(side, n);
      const hot = st && st !== 'synced' ? st : null;
      return (
        <div key={nk}>
          <div className="ftp-row" style={{ ...rowStyle, paddingLeft: 8 + depth * 14 }} onClick={() => toggle(side, n)}>
            <span style={{ width: 12, flexShrink: 0, color: 'var(--theme-text-muted)' }}>
              {n.isDir ? (open ? '▾' : '▸') : ''}
            </span>
            <span style={{ flexShrink: 0 }}>{n.isDir ? (open ? '📂' : '📁') : '📄'}</span>
            <span style={{ ...nameStyle, ...(hot ? { color: STATUS_COLOR[hot], fontWeight: 600 } : {}) }}>{n.name}</span>
            {hot && <span title={STATUS_LABEL[hot]} style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[hot], flexShrink: 0 }} />}
            {!n.isDir && n.size > 0 && <span style={sizeStyle}>{formatBytes(n.size)}</span>}
            <button
              className="ftp-act" style={actBtnStyle}
              title={side === 'local' ? '推送到远端' : '拉取到本地'}
              onClick={(e) => { e.stopPropagation(); side === 'local' ? pushNode(n) : pullNode(n); }}
            >
              {side === 'local' ? '⬆' : '⬇'}
            </button>
          </div>
          {n.isDir && open && renderDir(side, n.rel, depth + 1)}
        </div>
      );
    });
  };

  const noneDiff = summary.conflict + summary.differs + summary['local-only'] + summary['remote-only'] === 0;

  return (
    <div style={wrapStyle}>
      <style>{`
        .ftp-row:hover { background: var(--theme-bg-tertiary, rgba(255,255,255,0.05)); }
        .ftp-act { opacity: 0; }
        .ftp-row:hover .ftp-act { opacity: 1; }
      `}</style>

      {/* 比对工具条 */}
      <div style={summaryStyle}>
        {!compareOn ? (
          <button style={cmpBtnStyle} onClick={runCompare} disabled={comparing || !workingDir || !localFs}
            title={!localFs ? '先在「本地」选择目录' : !workingDir ? '先打开会话' : '全量比对两端内容（含哈希），标出差异/冲突'}>
            {comparing ? '比对中…' : '🔍 比对两端'}
          </button>
        ) : (
          <>
            {noneDiff ? <span style={{ color: 'var(--theme-success, #2da44e)' }}>✓ 两端一致</span> : (
              <>
                {summary.conflict > 0 && <Chip color={STATUS_COLOR.conflict} text={`冲突 ${summary.conflict}`} />}
                {summary.differs > 0 && <Chip color={STATUS_COLOR.differs} text={`不同 ${summary.differs}`} />}
                {summary['local-only'] > 0 && <Chip color={STATUS_COLOR['local-only']} text={`仅本地 ${summary['local-only']}`} />}
                {summary['remote-only'] > 0 && <Chip color={STATUS_COLOR['remote-only']} text={`仅远端 ${summary['remote-only']}`} />}
              </>
            )}
            <div style={{ flex: 1 }} />
            <button style={cmpBtnStyle} onClick={runCompare} disabled={comparing} title="重新比对">↻</button>
            <button style={cmpBtnStyle} onClick={exitCompare} title="退出比对">✕</button>
          </>
        )}
      </div>

      {/* ☁️ 远端 */}
      <SectionHeader icon="☁️" title={`远端${execLabel ? `（${execLabel}）` : ''}`}
        sub={workingDir ? shortDir(workingDir) : '（未打开会话）'}
        open={!!expanded['remote:root']} loading={loading[ck('remote', '')]}
        onToggle={() => setExpanded((p) => ({ ...p, 'remote:root': !p['remote:root'] }))}
        onRefresh={() => reloadSide('remote')} />
      {expanded['remote:root'] !== false && (
        <div style={treeBoxStyle}>
          {!workingDir ? <Empty text="打开一个会话后显示其远端工作目录" /> : renderDir('remote', '', 0)}
        </div>
      )}

      {/* 🖥️ 本地 */}
      <SectionHeader icon="🖥️" title="本地"
        sub={localFs ? localFs.label() : '（未选择本机目录）'}
        open={!!expanded['local:root']} loading={loading[ck('local', '')]}
        onToggle={() => setExpanded((p) => ({ ...p, 'local:root': !p['local:root'] }))}
        onRefresh={localFs ? () => reloadSide('local') : undefined}
        onPick={handlePickLocal} pickLabel={localFs ? '更换' : '选择目录'} />
      {expanded['local:root'] !== false && (
        <div style={treeBoxStyle}>
          {!localFs ? <Empty text="选择一个本机目录作为副本（推送/拉取的落地处）" /> : renderDir('local', '', 0)}
        </div>
      )}

      {(busy || msg) && (
        <div style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.5, borderTop: '1px solid var(--theme-border)',
          color: busy ? 'var(--theme-text-muted)' : msg?.kind === 'ok' ? 'var(--theme-success, #2da44e)' : '#f87171',
          background: 'var(--theme-bg-secondary)',
        }}>
          {busy || msg?.text}
        </div>
      )}
    </div>
  );
};

const SectionHeader: React.FC<{
  icon: string; title: string; sub: string; open: boolean; loading?: boolean;
  onToggle: () => void; onRefresh?: () => void; onPick?: () => void; pickLabel?: string;
}> = ({ icon, title, sub, open, loading, onToggle, onRefresh, onPick, pickLabel }) => (
  <div style={sectionHeaderStyle} onClick={onToggle}>
    <span style={{ width: 12, color: 'var(--theme-text-muted)' }}>{open ? '▾' : '▸'}</span>
    <span style={{ fontSize: 14 }}>{icon}</span>
    <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text)' }}>{title}</span>
    <span style={sectionSubStyle} title={sub}>{sub}</span>
    {loading && <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>…</span>}
    <div style={{ flex: 1 }} />
    {onPick && <button style={hdrBtnStyle} title="选择/更换本机目录" onClick={(e) => { e.stopPropagation(); onPick(); }}>{pickLabel || '选择'}</button>}
    {onRefresh && <button style={hdrBtnStyle} title="刷新" onClick={(e) => { e.stopPropagation(); onRefresh(); }}>↻</button>}
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={emptyStyle}>{text}</div>
);

const Chip: React.FC<{ color: string; text: string }> = ({ color, text }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
    <span>{text}</span>
  </span>
);

function shortDir(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 2 ? dir : '.../' + parts.slice(-2).join('/');
}

const wrapStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0,
};
const summaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '6px 10px', fontSize: 11, color: 'var(--theme-text-muted)',
  borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
};
const cmpBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px', cursor: 'pointer', userSelect: 'none',
  borderBottom: '1px solid var(--theme-border)', position: 'sticky', top: 0,
  background: 'var(--theme-sidebar-bg, #f6f8fa)', zIndex: 1,
};
const sectionSubStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-text-muted)', fontFamily: 'monospace',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90,
};
const hdrBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)',
};
const treeBoxStyle: React.CSSProperties = {
  padding: '2px 0 6px', borderBottom: '1px solid var(--theme-border)',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px 2px 0', fontSize: 12, color: 'var(--theme-text)',
};
const nameStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const sizeStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-text-muted)', flexShrink: 0,
};
const actBtnStyle: React.CSSProperties = {
  flexShrink: 0, width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)',
  color: 'var(--theme-accent)', fontSize: 11, lineHeight: 1,
};
const emptyStyle: React.CSSProperties = {
  padding: '10px 12px', fontSize: 11, color: 'var(--theme-text-muted)',
};

/**
 * FileTreePanel — 本地 / 远端 双根目录树（替代原弹窗式目录同步）。
 *
 * 像 VSCode 左侧资源管理器那样直接看到目录树,作为侧栏的一个可切换视图：
 *   🖥️ 本地（本机副本目录,File System Access / Tauri）
 *   ☁️ 远端（会话所在执行节点上的工作目录）
 *
 * 每个文件 / 整个目录都能就地选择同步：
 *   本地节点 → ⬆ 推送到远端（push）
 *   远端节点 → ⬇ 拉取到本地（pull）
 * 复用 dirSync 的本地文件系统抽象与 sync* RPC（按会话归属节点路由）。
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
  children: TNode[];
}

function buildTree(manifest: Manifest): TNode[] {
  const root: TNode = { name: '', rel: '', isDir: true, size: 0, children: [] };
  const dirMap = new Map<string, TNode>([['', root]]);
  const ensureDir = (rel: string): TNode => {
    const hit = dirMap.get(rel);
    if (hit) return hit;
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const parent = ensureDir(parts.slice(0, -1).join('/'));
    const node: TNode = { name, rel, isDir: true, size: 0, children: [] };
    parent.children.push(node);
    dirMap.set(rel, node);
    return node;
  };
  for (const rel of Object.keys(manifest)) {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const parent = ensureDir(parts.slice(0, -1).join('/'));
    parent.children.push({ name, rel, isDir: false, size: manifest[rel].size, children: [] });
  }
  const sortRec = (n: TNode) => {
    n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function relsUnder(manifest: Manifest, node: TNode): string[] {
  if (!node.isDir) return [node.rel];
  const prefix = node.rel ? `${node.rel}/` : '';
  return Object.keys(manifest).filter((r) => !node.rel || r === node.rel || r.startsWith(prefix));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Side = 'local' | 'remote';

// 文件级状态：基于 本地/远端 哈希 + 上次同步基线(三向)判定。
type FileStatus = 'synced' | 'differs' | 'conflict' | 'local-only' | 'remote-only';
// 目录聚合：synced / changed(内有非冲突变更) / conflict
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
    if (L && R) {
      if (L === R) { out[rel] = 'synced'; continue; }
      // 两端都存在但内容不同：若都相对基线改过 → 冲突,否则只是一端较新
      out[rel] = (L !== B && R !== B) ? 'conflict' : 'differs';
    } else if (L && !R) {
      out[rel] = 'local-only';
    } else if (R && !L) {
      out[rel] = 'remote-only';
    }
  }
  return out;
}

// 目录节点状态 = 其下文件里最严重的那个(冲突 > 任意变更 > 已同步)。
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
  const [localManifest, setLocalManifest] = useState<Manifest | null>(null);
  const [remoteManifest, setRemoteManifest] = useState<Manifest | null>(null);
  const [baseline, setBaseline] = useState<Manifest>({});
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ 'local:': true, 'remote:': true });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const localTree = useMemo(() => (localManifest ? buildTree(localManifest) : []), [localManifest]);
  const remoteTree = useMemo(() => (remoteManifest ? buildTree(remoteManifest) : []), [remoteManifest]);

  // 上次同步基线(三向比对用):随 本地目录 + 远端工作目录 变化而载入。
  useEffect(() => {
    if (localFs && workingDir) setBaseline(loadBaseline(localFs.id(), workingDir));
    else setBaseline({});
  }, [localFs, workingDir]);

  const statusMap = useMemo(
    () => computeStatus(localManifest, remoteManifest, baseline),
    [localManifest, remoteManifest, baseline],
  );
  const summary = useMemo(() => {
    const c = { conflict: 0, differs: 0, 'local-only': 0, 'remote-only': 0, synced: 0 } as Record<FileStatus, number>;
    for (const s of Object.values(statusMap)) c[s]++;
    return c;
  }, [statusMap]);

  // 某节点的展示状态(文件直接取;目录聚合其下文件)。
  const nodeStatus = useCallback((side: Side, n: TNode): NodeStatus | null => {
    if (!n.isDir) return statusMap[n.rel] ?? null;
    const m = side === 'local' ? localManifest : remoteManifest;
    if (!m) return null;
    return aggregateStatus(relsUnder(m, n), statusMap);
  }, [statusMap, localManifest, remoteManifest]);

  // 同步成功后,把传输过的文件并入基线 → 状态翻为「已同步」,后续冲突判定也准确。
  const bumpBaseline = useCallback((rels: string[], src: Manifest | null) => {
    if (!localFs || !workingDir || !src) return;
    setBaseline((prev) => {
      const next = { ...prev };
      for (const rel of rels) if (src[rel]) next[rel] = src[rel];
      saveBaseline(localFs.id(), workingDir, next);
      return next;
    });
  }, [localFs, workingDir]);

  const refreshLocal = useCallback(async (fs: LocalFs | null) => {
    if (!fs) { setLocalManifest(null); return; }
    setLoadingLocal(true);
    try {
      const m = await fs.scan([]);
      setLocalManifest(m);
    } catch (e: any) {
      setMsg({ kind: 'err', text: `本地扫描失败：${e?.message ?? e}` });
    } finally {
      setLoadingLocal(false);
    }
  }, []);

  const refreshRemote = useCallback(async () => {
    if (!workingDir) { setRemoteManifest(null); return; }
    setLoadingRemote(true);
    try {
      const r = await api.syncManifest(workingDir, execKey);
      if (r.status === 'ok' && r.files) setRemoteManifest(r.files);
      else { setRemoteManifest({}); setMsg({ kind: 'err', text: r.message || '远端目录读取失败' }); }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `远端读取失败：${e?.message ?? e}` });
    } finally {
      setLoadingRemote(false);
    }
  }, [workingDir, execKey]);

  // 初始：恢复上次的本地目录 + 拉远端清单
  useEffect(() => {
    let cancelled = false;
    restoreLocalDir().then((fs) => {
      if (cancelled || !fs) return;
      setLocalFs(fs);
      refreshLocal(fs);
    }).catch(() => { /* 需用户重新授权 */ });
    return () => { cancelled = true; };
  }, [refreshLocal]);

  useEffect(() => { refreshRemote(); }, [refreshRemote]);

  const handlePickLocal = useCallback(async () => {
    setMsg(null);
    try {
      const fs = await pickLocalDir();
      if (fs) { setLocalFs(fs); refreshLocal(fs); }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? String(e) });
    }
  }, [refreshLocal]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // 推送：本地 → 远端
  const pushNode = useCallback(async (node: TNode) => {
    if (!localFs || !localManifest || !workingDir) return;
    const rels = relsUnder(localManifest, node);
    if (node.isDir && !window.confirm(`把目录「${node.name || '根'}」下的 ${rels.length} 个文件推送到远端？`)) return;
    setMsg(null);
    const okRels: string[] = [];
    try {
      for (let i = 0; i < rels.length; i++) {
        setBusy(`推送 ${i + 1}/${rels.length}：${rels[i]}`);
        const b64 = await localFs.readFile(rels[i]);
        const r = await api.syncWriteFile(workingDir, rels[i], b64, execKey);
        if (r.status === 'ok') okRels.push(rels[i]);
      }
      bumpBaseline(okRels, localManifest);
      setMsg({ kind: 'ok', text: `✓ 已推送 ${okRels.length}/${rels.length} 个文件到远端` });
      refreshRemote();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `推送失败：${e?.message ?? e}` });
    } finally {
      setBusy('');
    }
  }, [localFs, localManifest, workingDir, execKey, refreshRemote, bumpBaseline]);

  // 拉取：远端 → 本地
  const pullNode = useCallback(async (node: TNode) => {
    if (!localFs) { setMsg({ kind: 'err', text: '请先在「本地」选择一个目录作为落地处' }); return; }
    if (!remoteManifest || !workingDir) return;
    const rels = relsUnder(remoteManifest, node);
    if (node.isDir && !window.confirm(`把远端目录「${node.name || '根'}」下的 ${rels.length} 个文件拉取到本地？`)) return;
    setMsg(null);
    const okRels: string[] = [];
    try {
      for (let i = 0; i < rels.length; i++) {
        setBusy(`拉取 ${i + 1}/${rels.length}：${rels[i]}`);
        const r = await api.syncReadFile(workingDir, rels[i], execKey);
        if (r.status === 'ok' && r.data != null) { await localFs.writeFile(rels[i], r.data); okRels.push(rels[i]); }
      }
      bumpBaseline(okRels, remoteManifest);
      setMsg({ kind: 'ok', text: `✓ 已拉取 ${okRels.length}/${rels.length} 个文件到本地` });
      refreshLocal(localFs);
    } catch (e: any) {
      setMsg({ kind: 'err', text: `拉取失败：${e?.message ?? e}` });
    } finally {
      setBusy('');
    }
  }, [localFs, remoteManifest, workingDir, execKey, refreshLocal, bumpBaseline]);

  const renderNodes = (side: Side, nodes: TNode[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      const key = `${side}:${n.rel}`;
      const open = !!expanded[key];
      const st = nodeStatus(side, n);
      const hot = st && st !== 'synced' ? st : null;   // 非「已同步」才高亮
      return (
        <div key={key}>
          <div
            className="ftp-row"
            style={{ ...rowStyle, paddingLeft: 8 + depth * 14 }}
            onClick={() => n.isDir && toggle(key)}
          >
            <span style={{ width: 12, flexShrink: 0, color: 'var(--theme-text-muted)' }}>
              {n.isDir ? (open ? '▾' : '▸') : ''}
            </span>
            <span style={{ flexShrink: 0 }}>{n.isDir ? (open ? '📂' : '📁') : '📄'}</span>
            <span style={{ ...nameStyle, ...(hot ? { color: STATUS_COLOR[hot], fontWeight: 600 } : {}) }}>
              {n.name}
            </span>
            {hot && (
              <span
                title={STATUS_LABEL[hot]}
                style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[hot], flexShrink: 0 }}
              />
            )}
            {!n.isDir && <span style={sizeStyle}>{formatBytes(n.size)}</span>}
            <button
              className="ftp-act"
              style={actBtnStyle}
              title={side === 'local' ? '推送到远端' : '拉取到本地'}
              onClick={(e) => { e.stopPropagation(); side === 'local' ? pushNode(n) : pullNode(n); }}
            >
              {side === 'local' ? '⬆' : '⬇'}
            </button>
          </div>
          {n.isDir && open && renderNodes(side, n.children, depth + 1)}
        </div>
      );
    });

  return (
    <div style={wrapStyle}>
      <style>{`
        .ftp-row { cursor: default; }
        .ftp-row:hover { background: var(--theme-bg-tertiary, rgba(255,255,255,0.05)); }
        .ftp-act { opacity: 0; }
        .ftp-row:hover .ftp-act { opacity: 1; }
      `}</style>

      {/* 两端差异概览（需本地+远端都已载入才有意义） */}
      {localManifest && remoteManifest && (
        <div style={summaryStyle}>
          {summary.conflict + summary.differs + summary['local-only'] + summary['remote-only'] === 0 ? (
            <span style={{ color: 'var(--theme-success, #2da44e)' }}>✓ 两端一致</span>
          ) : (
            <>
              {summary.conflict > 0 && <Chip color={STATUS_COLOR.conflict} text={`冲突 ${summary.conflict}`} />}
              {summary.differs > 0 && <Chip color={STATUS_COLOR.differs} text={`不同 ${summary.differs}`} />}
              {summary['local-only'] > 0 && <Chip color={STATUS_COLOR['local-only']} text={`仅本地 ${summary['local-only']}`} />}
              {summary['remote-only'] > 0 && <Chip color={STATUS_COLOR['remote-only']} text={`仅远端 ${summary['remote-only']}`} />}
            </>
          )}
        </div>
      )}

      {/* ☁️ 远端 */}
      <SectionHeader
        icon="☁️"
        title={`远端${execLabel ? `（${execLabel}）` : ''}`}
        sub={workingDir ? shortDir(workingDir) : '（未打开会话）'}
        open={!!expanded['remote:']}
        loading={loadingRemote}
        onToggle={() => toggle('remote:')}
        onRefresh={refreshRemote}
      />
      {expanded['remote:'] && (
        <div style={treeBoxStyle}>
          {!workingDir ? <Empty text="打开一个会话后显示其远端工作目录" />
            : remoteTree.length === 0 ? <Empty text={loadingRemote ? '读取中…' : '（空目录）'} />
              : renderNodes('remote', remoteTree, 0)}
        </div>
      )}

      {/* 🖥️ 本地 */}
      <SectionHeader
        icon="🖥️"
        title="本地"
        sub={localFs ? localFs.label() : '（未选择本机目录）'}
        open={!!expanded['local:']}
        loading={loadingLocal}
        onToggle={() => toggle('local:')}
        onRefresh={localFs ? () => refreshLocal(localFs) : undefined}
        onPick={handlePickLocal}
        pickLabel={localFs ? '更换' : '选择目录'}
      />
      {expanded['local:'] && (
        <div style={treeBoxStyle}>
          {!localFs ? <Empty text="选择一个本机目录作为副本（推送/拉取的落地处）" />
            : localTree.length === 0 ? <Empty text={loadingLocal ? '扫描中…' : '（空目录）'} />
              : renderNodes('local', localTree, 0)}
        </div>
      )}

      {/* 底部状态 */}
      {(busy || msg) && (
        <div style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.5,
          borderTop: '1px solid var(--theme-border)',
          color: busy ? 'var(--theme-text-muted)'
            : msg?.kind === 'ok' ? 'var(--theme-success, #2da44e)' : '#f87171',
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
    {onPick && (
      <button style={hdrBtnStyle} title="选择/更换本机目录" onClick={(e) => { e.stopPropagation(); onPick(); }}>
        {pickLabel || '选择'}
      </button>
    )}
    {onRefresh && (
      <button style={hdrBtnStyle} title="刷新" onClick={(e) => { e.stopPropagation(); onRefresh(); }}>↻</button>
    )}
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--theme-text-muted)' }}>{text}</div>
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
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px',
  cursor: 'pointer', userSelect: 'none',
  borderBottom: '1px solid var(--theme-border)',
  position: 'sticky', top: 0, background: 'var(--theme-sidebar-bg, #f6f8fa)', zIndex: 1,
};
const sectionSubStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-text-muted)', fontFamily: 'monospace',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90,
};
const hdrBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--theme-border)', background: 'transparent',
  color: 'var(--theme-text-muted)',
};
const treeBoxStyle: React.CSSProperties = {
  padding: '2px 0 6px', borderBottom: '1px solid var(--theme-border)',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px 2px 0',
  fontSize: 12, color: 'var(--theme-text)',
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

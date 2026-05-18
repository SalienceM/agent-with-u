/**
 * AssetPanel — 素材中转池面板。
 *
 * 展示后端 Asset Pool 中暂存的图片/文件，支持：
 *   - 缩略图预览（走 getAsset 数据通道，本地直连/经中继均可）
 *   - pin / unpin（pinned 不被滚动淘汰）
 *   - 删除
 *   - 跟随后端 assetChanged 事件自动刷新
 *
 * 共屏右侧列模式，由 App.tsx 控制显隐。
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api, loadAssetDataUrl } from '../api';

interface AssetMeta {
  id: string;
  filename: string;
  ext: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  source?: string;
  tags?: string[];
  desc?: string;
  pinned?: boolean;
  created_at?: number;
}

interface AssetPanelProps {
  visible: boolean;
  onClose?: () => void;
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 缩略图：通过 getAsset RPC 走数据通道按需加载，兼容本地直连 / 经中继。 */
const AssetThumb: React.FC<{ asset: AssetMeta }> = ({ asset }) => {
  const isImage = !!asset.mime?.startsWith('image/');
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    loadAssetDataUrl(asset.id, true)
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [asset.id, isImage]);

  if (!isImage || failed) {
    return (
      <span style={{ fontSize: 22, opacity: 0.6 }}>
        {asset.mime?.includes('pdf') ? '📄' : isImage ? '🖼' : '📎'}
      </span>
    );
  }
  if (!src) return <span style={{ fontSize: 16, opacity: 0.4 }}>⋯</span>;
  return <img src={src} alt={asset.desc || asset.id} style={thumbImgStyle} loading="lazy" />;
};

export const AssetPanel: React.FC<AssetPanelProps> = ({ visible, onClose }) => {
  const [items, setItems] = useState<AssetMeta[]>([]);
  const [stats, setStats] = useState<any>({ count: 0, pinned: 0, bytes: 0, max_items: 0, max_bytes: 0 });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.assetList(100, 0, '');
      setItems(r.items);
      setStats(r.stats);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  // 后端素材池变化 → 自动刷新（仅在面板可见时）
  useEffect(() => {
    if (!visible) return;
    const off = api.onAssetChanged(() => refresh());
    return off;
  }, [visible, refresh]);

  const togglePin = useCallback(async (a: AssetMeta) => {
    await api.assetPin(a.id, !a.pinned);
    // assetChanged 事件会触发 refresh；这里不重复拉取
  }, []);

  const remove = useCallback(async (a: AssetMeta) => {
    await api.assetDelete(a.id);
  }, []);

  if (!visible) return null;

  return (
    <div style={panelStyle}>
      {/* 头部 */}
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>素材池 / Asset Pool</span>
        <div style={{ flex: 1 }} />
        <button onClick={refresh} title="刷新" style={iconBtnStyle}>⟳</button>
        {onClose && <button onClick={onClose} title="关闭" style={iconBtnStyle}>✕</button>}
      </div>

      {/* 统计 */}
      <div style={statsStyle}>
        {stats.count} 项{stats.pinned ? ` · ${stats.pinned} 已固定` : ''} ·{' '}
        {fmtBytes(stats.bytes || 0)}
        {stats.max_items ? ` / 上限 ${stats.max_items} 项 ${fmtBytes(stats.max_bytes || 0)}` : ''}
      </div>

      {/* 列表 */}
      <div style={listStyle}>
        {items.length === 0 && (
          <div style={emptyStyle}>
            {loading ? '加载中…' : '素材池为空。粘贴或截图的图片会自动暂存到这里。'}
          </div>
        )}
        {items.map((a) => {
          return (
            <div key={a.id} style={cardStyle}>
              <div style={thumbBoxStyle}>
                <AssetThumb asset={a} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={titleStyle} title={a.desc || a.source || a.id}>
                  {a.desc || a.source || a.id.slice(0, 8)}
                </div>
                <div style={subStyle}>
                  {a.mime}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ''} · {fmtBytes(a.size)}
                </div>
                <div style={subStyle}>{fmtTime(a.created_at)}</div>
                {a.tags && a.tags.length > 0 && (
                  <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {a.tags.map((t) => (
                      <span key={t} style={tagStyle}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  onClick={() => togglePin(a)}
                  title={a.pinned ? '取消固定' : '固定（不被淘汰）'}
                  style={{ ...iconBtnStyle, ...(a.pinned ? { color: 'var(--theme-accent, #7aa2f7)' } : {}) }}
                >
                  {a.pinned ? '📌' : '📍'}
                </button>
                <button onClick={() => remove(a)} title="删除" style={iconBtnStyle}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── 样式 ──────────────────────────────────────────────────────────────
const panelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
  background: 'var(--theme-sidebar-bg, #1a1a2e)',
  color: 'var(--theme-text, rgba(255,255,255,0.9))',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
};
const statsStyle: React.CSSProperties = {
  padding: '6px 10px', fontSize: 11,
  color: 'var(--theme-text-muted, #656d76)',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.07))',
};
const listStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: 8, display: 'flex',
  flexDirection: 'column', gap: 6,
};
const emptyStyle: React.CSSProperties = {
  padding: '24px 12px', textAlign: 'center', fontSize: 12,
  color: 'var(--theme-text-muted, #656d76)', lineHeight: 1.6,
};
const cardStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: 8, borderRadius: 8,
  background: 'var(--theme-bg, rgba(255,255,255,0.04))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};
const thumbBoxStyle: React.CSSProperties = {
  width: 56, height: 56, flexShrink: 0, borderRadius: 6,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.25)', overflow: 'hidden',
};
const thumbImgStyle: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'cover',
};
const titleStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};
const subStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-text-muted, #656d76)', marginTop: 1,
};
const tagStyle: React.CSSProperties = {
  fontSize: 9, padding: '1px 5px', borderRadius: 4,
  background: 'var(--theme-accent-bg, rgba(122,162,247,0.15))',
  color: 'var(--theme-accent, #7aa2f7)',
};
const iconBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--theme-text-muted, #999)', fontSize: 13, padding: 2,
  lineHeight: 1,
};

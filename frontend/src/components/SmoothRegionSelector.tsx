import React, { useCallback, useEffect, useRef, useState } from 'react';

export const isSmoothRegionSelector =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('smooth-region');

interface Rect { x: number; y: number; width: number; height: number; }
type DragMode = 'move' | 'new' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const MIN_SIZE = 80;

export const SmoothRegionSelector: React.FC = () => {
  const params = new URLSearchParams(location.search);
  const [rect, setRect] = useState<Rect>({ x: 120, y: 100, width: 800, height: 450 });
  const [ready, setReady] = useState(false);
  const finishingRef = useRef(false);
  const originRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<null | { mode: DragMode; sx: number; sy: number; rect: Rect }>(null);

  useEffect(() => {
    document.title = 'Smooth 截图区域';
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const [position, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
        if (cancelled) return;
        originRef.current = { x: position.x, y: position.y, scale };
        const gx = Number(params.get('x'));
        const gy = Number(params.get('y'));
        const gw = Number(params.get('width'));
        const gh = Number(params.get('height'));
        if ([gx, gy, gw, gh].every(Number.isFinite) && gw > 0 && gh > 0) {
          setRect({
            x: Math.max(0, (gx - position.x) / scale),
            y: Math.max(0, (gy - position.y) / scale),
            width: Math.max(MIN_SIZE, gw / scale),
            height: Math.max(MIN_SIZE, gh / scale),
          });
        } else {
          setRect({ x: innerWidth * .15, y: innerHeight * .16, width: innerWidth * .7, height: innerHeight * .62 });
        }
      } catch {
        // Browser development fallback uses CSS pixels directly.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const destroyFallback = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      // Stop hit-testing before destruction. Even if destruction is delayed,
      // the transparent overlay can no longer block the desktop underneath.
      await win.setIgnoreCursorEvents(true).catch(() => {});
      await win.destroy();
    } catch { window.close(); }
  }, []);

  const finish = useCallback(async (selection: null | { x: number; y: number; width: number; height: number }) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    // Disable the selector UI immediately; native destruction follows below.
    document.documentElement.style.pointerEvents = 'none';
    const fallbackTimer = window.setTimeout(() => { void destroyFallback(); }, 800);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('finish_smooth_region', { selection });
      window.clearTimeout(fallbackTimer);
    } catch (error) {
      window.clearTimeout(fallbackTimer);
      console.error('[smooth] native selector finish failed:', error);
      await destroyFallback();
    }
  }, [destroyFallback]);

  const close = useCallback(async () => {
    await finish(null);
  }, [finish]);

  const confirm = useCallback(async () => {
    const { x, y, scale } = originRef.current;
    const selected = {
      x: Math.round(x + rect.x * scale),
      y: Math.round(y + rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };
    await finish(selected);
  }, [finish, rect]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void close();
      if (event.key === 'Enter') void confirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, confirm]);

  const begin = (mode: DragMode, event: React.PointerEvent, startRect = rect) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = { mode, sx: event.clientX, sy: event.clientY, rect: startRect };
  };

  const onBackdropDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const start = { x: event.clientX, y: event.clientY, width: MIN_SIZE, height: MIN_SIZE };
    setRect(start);
    begin('new', event, start);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    let { x, y, width, height } = drag.rect;
    if (drag.mode === 'move') {
      x = Math.max(0, Math.min(innerWidth - width, x + dx));
      y = Math.max(0, Math.min(innerHeight - height, y + dy));
    } else if (drag.mode === 'new') {
      const right = Math.max(0, Math.min(innerWidth, event.clientX));
      const bottom = Math.max(0, Math.min(innerHeight, event.clientY));
      x = Math.min(drag.sx, right);
      y = Math.min(drag.sy, bottom);
      width = Math.max(MIN_SIZE, Math.abs(right - drag.sx));
      height = Math.max(MIN_SIZE, Math.abs(bottom - drag.sy));
    } else {
      if (drag.mode.includes('e')) width = Math.max(MIN_SIZE, Math.min(innerWidth - x, width + dx));
      if (drag.mode.includes('s')) height = Math.max(MIN_SIZE, Math.min(innerHeight - y, height + dy));
      if (drag.mode.includes('w')) {
        const nx = Math.max(0, Math.min(x + width - MIN_SIZE, x + dx));
        width += x - nx; x = nx;
      }
      if (drag.mode.includes('n')) {
        const ny = Math.max(0, Math.min(y + height - MIN_SIZE, y + dy));
        height += y - ny; y = ny;
      }
    }
    setRect({ x, y, width, height });
  };

  const info = (() => {
    const o = originRef.current;
    return {
      x: Math.round(o.x + rect.x * o.scale), y: Math.round(o.y + rect.y * o.scale),
      width: Math.round(rect.width * o.scale), height: Math.round(rect.height * o.scale),
    };
  })();

  if (!ready) return null;
  return (
    <div style={rootStyle} onPointerDown={onBackdropDown} onPointerMove={onPointerMove}
      onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      <div style={toolbarStyle} onPointerDown={(e) => e.stopPropagation()}>
        <div><b style={{ color: '#67e8f9' }}>〰 Smooth 区域</b><span style={hintStyle}>拖动框体移动 · 拖动节点缩放 · 空白处拖出新区域</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={cancelStyle} onClick={() => void close()}>取消 Esc</button>
          <button style={confirmStyle} onClick={() => void confirm()}>✓ 使用此区域 Enter</button>
        </div>
      </div>

      <div style={{ ...frameStyle, left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        onPointerDown={(e) => begin('move', e)}>
        <div style={coordStyle}>X {info.x} · Y {info.y} · {info.width} × {info.height}</div>
        <div style={crossHStyle} /><div style={crossVStyle} />
        {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as DragMode[]).map((mode) => (
          <div key={mode} style={{ ...handleStyle, ...handlePosition(mode), cursor: cursorFor(mode) }}
            onPointerDown={(e) => begin(mode, e)} />
        ))}
      </div>
    </div>
  );
};

function handlePosition(mode: DragMode): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    nw: { left: -6, top: -6 }, n: { left: '50%', top: -6, transform: 'translateX(-50%)' }, ne: { right: -6, top: -6 },
    e: { right: -6, top: '50%', transform: 'translateY(-50%)' }, se: { right: -6, bottom: -6 },
    s: { left: '50%', bottom: -6, transform: 'translateX(-50%)' }, sw: { left: -6, bottom: -6 },
    w: { left: -6, top: '50%', transform: 'translateY(-50%)' },
  };
  return map[mode] || {};
}
function cursorFor(mode: DragMode) { return ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' } as any)[mode]; }

const rootStyle: React.CSSProperties = { position: 'fixed', inset: 0, overflow: 'hidden', userSelect: 'none', cursor: 'crosshair', background: 'transparent' };
const toolbarStyle: React.CSSProperties = { position: 'fixed', zIndex: 20, left: '50%', top: 18, transform: 'translateX(-50%)', minWidth: 620, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '10px 12px 10px 16px', border: '1px solid rgba(103,232,249,.5)', borderRadius: 12, background: 'rgba(8,15,28,.92)', boxShadow: '0 12px 36px rgba(0,0,0,.42)', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif', cursor: 'default' };
const hintStyle: React.CSSProperties = { marginLeft: 12, fontSize: 11, color: '#94a3b8' };
const frameStyle: React.CSSProperties = { position: 'absolute', zIndex: 5, boxSizing: 'border-box', border: '2px solid #22d3ee', background: 'rgba(34,211,238,.035)', boxShadow: '0 0 0 9999px rgba(2,6,23,.52), 0 0 24px rgba(34,211,238,.45)', cursor: 'move' };
const coordStyle: React.CSSProperties = { position: 'absolute', left: -2, bottom: '100%', marginBottom: 6, padding: '4px 8px', borderRadius: 6, background: 'rgba(8,15,28,.92)', color: '#67e8f9', font: '600 11px ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' };
const handleStyle: React.CSSProperties = { position: 'absolute', zIndex: 8, width: 12, height: 12, borderRadius: 3, border: '2px solid #ecfeff', background: '#06b6d4', boxShadow: '0 0 7px rgba(34,211,238,.8)' };
const crossHStyle: React.CSSProperties = { position: 'absolute', left: 'calc(50% - 10px)', top: '50%', width: 20, height: 1, background: 'rgba(103,232,249,.55)', pointerEvents: 'none' };
const crossVStyle: React.CSSProperties = { position: 'absolute', left: '50%', top: 'calc(50% - 10px)', width: 1, height: 20, background: 'rgba(103,232,249,.55)', pointerEvents: 'none' };
const cancelStyle: React.CSSProperties = { padding: '7px 11px', borderRadius: 7, border: '1px solid #475569', background: '#182235', color: '#cbd5e1', cursor: 'pointer' };
const confirmStyle: React.CSSProperties = { padding: '7px 12px', borderRadius: 7, border: '1px solid #22d3ee', background: 'rgba(8,145,178,.28)', color: '#cffafe', fontWeight: 700, cursor: 'pointer' };

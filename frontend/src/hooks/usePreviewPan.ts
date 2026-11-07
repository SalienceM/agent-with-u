import { useEffect, useRef, useState, type RefObject } from 'react';

/** 只把鼠标主键转换为滚动；触摸仍交给浏览器（包含惯性和缩放）。 */
export function usePreviewPan(ref: RefObject<HTMLElement>, enabled = true, resetKey?: unknown) {
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ id: number; type: string; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let suppressUntil = 0;
    const finish = (cancel = false) => {
      const old = gesture.current; gesture.current = null;
      if (cancel) suppressUntil = 0;
      else if (old?.moved) suppressUntil = performance.now() + 600;
      if (old && el.hasPointerCapture(old.id)) el.releasePointerCapture(old.id);
      setDragging(false);
    };
    const down = (e: PointerEvent) => {
      suppressUntil = 0;
      if (e.button !== 0 || !e.isPrimary || (e.target as Element).closest('button, input, select, textarea, a, [contenteditable="true"]')) return;
      if (e.pointerType === 'mouse' && !enabled) return;
      gesture.current = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    };
    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= 6 && !g.moved) {
        g.moved = true;
        if (g.type === 'mouse') { el.setPointerCapture(g.id); setDragging(true); }
      }
      if (g.moved && g.type === 'mouse') {
        e.preventDefault();
        el.scrollLeft = g.left + g.x - e.clientX; el.scrollTop = g.top + g.y - e.clientY;
      }
    };
    const up = (e: PointerEvent) => { if (gesture.current?.id === e.pointerId) finish(); };
    const cancel = () => finish(true);
    const lost = () => { if (gesture.current) finish(true); };
    const click = (e: MouseEvent) => {
      if (e.detail > 0 && performance.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
      suppressUntil = 0;
    };
    const select = (e: Event) => { if (enabled && gesture.current?.type === 'mouse') e.preventDefault(); };
    el.addEventListener('pointerdown', down); el.addEventListener('click', click, true);
    el.addEventListener('selectstart', select); el.addEventListener('lostpointercapture', lost);
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    return () => { finish(true); el.removeEventListener('pointerdown', down); el.removeEventListener('click', click, true);
      el.removeEventListener('selectstart', select); el.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); };
  }, [ref, enabled, resetKey]);
  return dragging;
}

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';

interface FileRow { rel: string }
interface Box { left: number; top: number; width: number; height: number }

/** 只选择已经显示的行，不扫描目录；选择与拖框不会打开文件。 */
export function useFileTreeSelection<T extends FileRow>(container: RefObject<HTMLDivElement>, canSelect: (node: T) => boolean, disabled: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [checked, setChecked] = useState<Map<string, T>>(new Map());
  const [box, setBox] = useState<Box | null>(null);
  const rows = useRef(new Map<string, { node: T; element: HTMLElement }>());
  const anchor = useRef('');
  const suppressClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();
  const drag = useRef<{ id: number; x: number; y: number; started: boolean; base: Map<string, T>; additive: boolean;
    rows: Array<{ node: T; left: number; top: number; right: number; bottom: number }> } | null>(null);
  const clear = useCallback(() => { drag.current = null; suppressClick.current = false; setBox(null); setChecked(new Map()); anchor.current = ''; }, []);
  const cancelDrag = useCallback(() => { drag.current = null; setBox(null); }, []);
  useEffect(() => { if (!enabled || disabled) { suppressClick.current = false; cancelDrag(); } }, [enabled, disabled, cancelDrag]);
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current); }, []);

  const visibleRows = () => Array.from(container.current?.querySelectorAll<HTMLElement>('[data-file-select]') || [])
    .map(element => rows.current.get(element.dataset.fileSelect!)).filter((row): row is { node: T; element: HTMLElement } => !!row && canSelect(row.node));
  const select = (node: T, shift = false) => {
    if (disabled || !canSelect(node)) return;
    const visible = visibleRows();
    const start = visible.findIndex(row => row.node.rel === anchor.current);
    const end = visible.findIndex(row => row.node.rel === node.rel);
    setChecked(previous => {
      const next = new Map(previous);
      if (shift && start >= 0 && end >= 0) {
        for (const row of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) next.set(row.node.rel, row.node);
      } else if (next.has(node.rel)) next.delete(node.rel);
      else next.set(node.rel, node);
      return next;
    });
    anchor.current = node.rel;
  };
  const selectAll = () => { if (!disabled) setChecked(new Map(visibleRows().map(row => [row.node.rel, row.node]))); };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const tree = event.currentTarget, bounds = tree.getBoundingClientRect();
    return { x: Math.max(0, Math.min(tree.clientWidth, event.clientX - bounds.left)) + tree.scrollLeft,
      y: Math.max(0, Math.min(tree.clientHeight, event.clientY - bounds.top)) + tree.scrollTop };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || disabled || event.button !== 0 || event.pointerType === 'touch'
      || (event.target as HTMLElement).closest('button,input,a')) return;
    const tree = event.currentTarget, bounds = tree.getBoundingClientRect(), start = point(event);
    drag.current = { id: event.pointerId, ...start, started: false, base: checked, additive: event.ctrlKey || event.metaKey || event.shiftKey,
      rows: visibleRows().map(({ node, element }) => {
        const rect = element.getBoundingClientRect();
        return { node, left: rect.left - bounds.left + tree.scrollLeft, right: rect.right - bounds.left + tree.scrollLeft,
          top: rect.top - bounds.top + tree.scrollTop, bottom: rect.bottom - bounds.top + tree.scrollTop };
      }) };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || disabled) return;
    if (event.buttons !== 1) { suppressClick.current = false; cancelDrag(); return; }
    const end = point(event);
    if (!current.started && Math.hypot(end.x - current.x, end.y - current.y) < 5) return;
    event.preventDefault();
    if (!current.started) { current.started = true; event.currentTarget.setPointerCapture(event.pointerId); }
    suppressClick.current = true;
    const nextBox = { left: Math.min(current.x, end.x), top: Math.min(current.y, end.y), width: Math.abs(end.x - current.x), height: Math.abs(end.y - current.y) };
    setBox(nextBox);
    const next = new Map(current.additive ? current.base : []);
    for (const row of current.rows) {
      if (row.left < nextBox.left + nextBox.width && row.right > nextBox.left
        && row.top < nextBox.top + nextBox.height && row.bottom > nextBox.top) next.set(row.node.rel, row.node);
    }
    setChecked(previous => previous.size === next.size && [...next.keys()].every(key => previous.has(key)) ? previous : next);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    cancelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
  };
  return { enabled, checked, box, clear, select, selectAll,
    toggle: () => { cancelDrag(); clear(); setEnabled(value => !value); },
    remove: (contains: (path: string) => boolean) => setChecked(previous => new Map([...previous].filter(([path]) => !contains(path)))),
    bind: (node: T, element: HTMLElement | null) => { if (element) rows.current.set(node.rel, { node, element }); else rows.current.delete(node.rel); },
    handlers: { onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerUp,
      onPointerCancel: () => { suppressClick.current = false; cancelDrag(); },
      onLostPointerCapture: () => { if (drag.current) { suppressClick.current = false; cancelDrag(); } },
      onClickCapture: (event: MouseEvent) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } },
    },
  };
}

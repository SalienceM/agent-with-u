import React, { useRef } from 'react';

interface Props { label: string; value: number; min: number; max: number; onChange: (value: number) => void; horizontal?: boolean; reverse?: boolean }
/** Pointer capture keeps mouse/touch drag local; keyboard follows the same bounded setter. */
export const WorkbenchResizeHandle: React.FC<Props> = ({ label, value, min, max, onChange, horizontal = false, reverse = false }) => {
  const drag = useRef<{ coordinate: number; value: number } | null>(null);
  const change = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return <div className="awu-wb-resize" role="separator" aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0}
    style={{ flex: `0 0 5px`, cursor: horizontal ? 'row-resize' : 'col-resize', touchAction: 'none', background: 'var(--theme-sidebar-solid, var(--theme-bg-secondary))', transition: 'background .15s' }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus();
      drag.current = { coordinate: horizontal ? event.clientY : event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (drag.current) change(drag.current.value + ((horizontal ? event.clientY : event.clientX) - drag.current.coordinate) * (reverse ? -1 : 1)); }}
    onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const direction = event.key === (horizontal ? 'ArrowDown' : 'ArrowRight') ? 1 : event.key === (horizontal ? 'ArrowUp' : 'ArrowLeft') ? -1 : 0;
      if (direction) { event.preventDefault(); change(value + direction * (reverse ? -16 : 16)); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); change(event.key === 'Home' ? min : max); }
    }} />;
};

import React, { useEffect, useRef, useState } from 'react';

/** 场景与内容各占独立区域；滚动审计内容不会带走沙盘。 */
export const AimeinSceneDock: React.FC<{
  scene: React.ReactNode; children: React.ReactNode; open: boolean; panelRef?: React.Ref<HTMLDivElement>; balanced?: boolean; live?: boolean;
}> = ({ scene, children, open, panelRef, balanced, live }) => {
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 900));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={root} data-testid="aimein-scene-dock" data-narrow={narrow} style={{ display: 'grid', flex: 1, minWidth: 0, minHeight: 0, gap: 10,
    gridTemplateColumns: open && !narrow ? 'minmax(0, 1fr) minmax(320px, 38%)' : 'minmax(0, 1fr)',
    gridTemplateRows: open && narrow ? live ? 'minmax(0, .9fr) minmax(0, 1.1fr)' : `minmax(0, ${balanced ? 1 : 2}fr) minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
    <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{scene}</div>
    <div ref={panelRef} data-testid="aimein-scene-panel" hidden={!open} style={{ position: 'relative', display: open ? live ? 'flex' : 'block' : 'none', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: live ? 'hidden' : 'auto', overscrollBehavior: 'contain', border: '1px solid #456654', borderRadius: 12, background: 'var(--theme-bg-secondary)', padding: live ? 0 : 12 }}>{children}</div>
  </div>;
};

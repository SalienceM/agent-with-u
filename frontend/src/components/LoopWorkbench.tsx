import React, { useEffect, useRef, useState } from 'react';
import type { WorkbenchSection } from '../utils/loopWorkbenchView';

export const WORKBENCH_SECTIONS: Record<WorkbenchSection, string> = {
  process: '过程与历史', evidence: '成果与证据', goal: '目标与补充', source: '任务来源', environment: '运行诊断', policy: '策略与心智', issues: '需要处理',
};
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 7, padding: '7px 10px',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', fontSize: 12 };

/** 只负责布局与焦点，不持有任何执行/控制权状态。草稿所在 slot 关闭时不卸载。 */
export const LoopWorkbench: React.FC<{
  header: React.ReactNode; children: React.ReactNode; details: React.ReactNode;
  section: WorkbenchSection | null; onSection: (section: WorkbenchSection | null) => void;
  trigger: React.MutableRefObject<HTMLElement | null>;
  title?: string; immersive?: boolean;
}> = ({ header, children, details, section, onSection, trigger, title, immersive }) => {
  const root = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 1000));
    observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const dismiss = () => { onSection(null); requestAnimationFrame(() => trigger.current?.focus()); };
  useEffect(() => { if (section) { close.current?.focus(); detail.current?.scrollTo(0, 0); } }, [section]);
  return <div ref={root} data-testid="loop-workbench" style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex',
    flexDirection: 'column', color: 'var(--theme-text)', overflow: 'hidden', overflowWrap: 'anywhere' }}>
    <div style={{ position: 'relative', zIndex: 1, flexShrink: 0, padding: immersive ? '6px 10px' : '12px 14px', maxHeight: immersive ? '22%' : undefined, overflowY: immersive ? 'auto' : undefined, borderBottom: '1px solid var(--theme-border)' }}>{header}</div>
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: immersive && narrow ? 'column' : 'row', position: immersive ? 'relative' : undefined }}>
      <main aria-label="LOOP 当前任务" aria-hidden={!immersive && section ? true : undefined} style={{ position: 'relative', zIndex: 0, display: immersive ? 'flex' : narrow && section ? 'none' : 'block', flexDirection: 'column',
        flex: 1, minHeight: 0, minWidth: 0, overflow: immersive ? 'hidden' : 'auto', padding: immersive ? 8 : 14 }}>{children}</main>
      <aside role="dialog" aria-modal={immersive ? false : true} aria-label={title || (section && WORKBENCH_SECTIONS[section]) || 'LOOP 详情'} hidden={!section}
        style={{ display: section ? 'flex' : 'none', position: immersive ? 'relative' : 'absolute', inset: immersive ? undefined : narrow ? 0 : '12px 12px 12px auto', zIndex: 10,
          flexDirection: 'column', width: narrow ? '100%' : 'min(580px, 90%)', minWidth: 0,
          ...(immersive ? { width: narrow ? 'auto' : '38%', flex: narrow ? .65 : undefined, minHeight: 0, margin: 8 } : {}),
          border: '1px solid var(--theme-border)', borderRadius: narrow ? 0 : 12, background: 'var(--theme-bg-secondary)', boxShadow: '0 8px 40px #0005' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
          if (event.key === 'Tab' && !immersive) {
            const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, [tabindex="0"]')).filter(el => !el.hasAttribute('disabled') && el.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          } }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 10, borderBottom: '1px solid var(--theme-border)' }}>
          <button ref={close} type="button" style={button} onClick={dismiss} aria-label="关闭详情，返回工作台">← 返回</button>
          <strong style={{ fontSize: 13 }}>{title || (section && WORKBENCH_SECTIONS[section])}</strong>
        </div>
        <div ref={detail} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', padding: 12 }}>{details}</div>
      </aside>
    </div>
  </div>;
};

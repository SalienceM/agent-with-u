import React, { useEffect, useRef, useState } from 'react';
import type { WorkbenchSection } from '../utils/loopWorkbenchView';

export const WORKBENCH_SECTIONS: Record<WorkbenchSection, string> = {
  process: '过程与历史', evidence: '成果与证据', goal: '目标与补充', settings: '任务设置', issues: '需要处理',
};
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 7, padding: '7px 10px',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', fontSize: 12 };

/** 只负责布局与焦点，不持有任何执行/控制权状态。草稿所在 slot 关闭时不卸载。 */
export const LoopWorkbench: React.FC<{
  header: React.ReactNode; children: React.ReactNode; details: React.ReactNode;
  section: WorkbenchSection | null; onSection: (section: WorkbenchSection | null) => void;
  trigger: React.MutableRefObject<HTMLElement | null>;
}> = ({ header, children, details, section, onSection, trigger }) => {
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
  return <div ref={root} data-testid="loop-workbench" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex',
    flexDirection: 'column', color: 'var(--theme-text)', overflow: 'hidden', overflowWrap: 'anywhere' }}>
    <div style={{ flexShrink: 0, padding: '12px 14px', borderBottom: '1px solid var(--theme-border)' }}>{header}</div>
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      <main aria-label="LOOP 当前任务" style={{ display: narrow && section ? 'none' : 'block',
        flex: 1, minWidth: 0, overflow: 'auto', padding: 14 }}>{children}</main>
      <aside aria-label="LOOP 详情" hidden={!section} style={{ display: section ? 'flex' : 'none', flexDirection: 'column',
        width: narrow ? '100%' : '56%', minWidth: 0, borderLeft: narrow ? undefined : '1px solid var(--theme-border)' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 10, borderBottom: '1px solid var(--theme-border)' }}>
          <button ref={close} type="button" style={button} onClick={dismiss} aria-label="关闭详情，返回工作台">← 返回</button>
          <strong style={{ fontSize: 13 }}>{section && WORKBENCH_SECTIONS[section]}</strong>
          <label style={{ marginLeft: 'auto' }}>详情 <select aria-label="详情分类" value={section || 'process'} style={button}
            onChange={event => onSection(event.target.value as WorkbenchSection)}>
            {Object.entries(WORKBENCH_SECTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
        <div ref={detail} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', padding: 12 }}>{details}</div>
      </aside>
    </div>
  </div>;
};

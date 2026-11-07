import React, { forwardRef, useContext, useLayoutEffect, useRef, useState } from 'react';
import { AppModalPortal, AppModalVisibilityContext, WorkbenchInteractionContext } from './AppModalPortal';

type IconName = 'branch' | 'review' | 'bell' | 'question' | 'more' | 'close' | 'refresh' | 'spark' | 'shield' | 'expand' | 'plus' | 'role' | 'clear' | 'settings' | 'block' | 'camera';
const paths: Record<IconName, React.ReactNode> = {
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10M18 8c0 5-12 3-12 8" /></>,
  review: <><path d="M20 11a7 7 0 0 1-7 7H8l-5 3 1-6a7 7 0 0 1 6-11h3a7 7 0 0 1 7 7Z" /><path d="M8 10h7M8 13h4" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1.5 1-2 1-2 3M12 17h.01" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" /></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 0 4m-2-2h4" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  role: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2" /></>,
  clear: <><path d="m5 19 14-14M13 4l7 7M4 14l6 6H3v-7Z" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--theme-bg-secondary, #fff)" /><circle cx="15" cy="17" r="3" fill="var(--theme-bg-secondary, #fff)" /></>,
  block: <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>,
  camera: <><path d="M3 7h4l2-3h6l2 3h4v13H3Z" /><circle cx="12" cy="13" r="4" /></>,
};
export const WorkflowIcon: React.FC<{ name: IconName; size?: number }> = ({ name, size = 16 }) =>
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{paths[name]}</svg>;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { tone?: 'quiet' | 'primary' | 'normal'; icon?: IconName }
export const WorkflowButton = forwardRef<HTMLButtonElement, ButtonProps>(({ tone = 'normal', icon, style, children, ...props }, ref) => {
  const [hover, setHover] = useState(false);
  const active = props['aria-pressed'] === true || props['aria-checked'] === true || props['aria-expanded'] === true || props['aria-selected'] === true;
  return <button {...props} ref={ref} type={props.type || 'button'}
    onMouseEnter={e => { setHover(true); props.onMouseEnter?.(e); }} onMouseLeave={e => { setHover(false); props.onMouseLeave?.(e); }}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 30, padding: '5px 10px',
      boxSizing: 'border-box', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, fontWeight: 500, lineHeight: '18px',
      border: `1px solid ${tone === 'quiet' ? 'transparent' : 'var(--theme-border, #dce1e8)'}`,
      background: tone === 'primary' ? 'var(--theme-accent, #4b82f0)' : active ? 'var(--theme-accent-bg, #4b82f014)' : hover ? 'var(--theme-bg-tertiary, #eef1f6)' : tone === 'quiet' ? 'transparent' : 'var(--theme-bg-secondary, #f6f8fa)',
      color: tone === 'primary' ? '#fff' : active ? 'var(--theme-accent, #4b82f0)' : tone === 'quiet' ? 'var(--theme-text-muted, #687487)' : 'var(--theme-text, #273244)',
      transition: 'background .12s, color .12s', ...style,
      cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? .45 : 1 }}>
    {icon && <WorkflowIcon name={icon} />}{children}
  </button>;
});

export const workflowFieldStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '9px 11px', font: 'inherit', fontSize: 13, border: '1px solid var(--theme-border, #dce1e8)', borderRadius: 8, background: 'var(--theme-input-bg, var(--theme-bg, #fff))', color: 'var(--theme-text, #273244)' };
export const workflowHeaderStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '16px 18px', flexWrap: 'wrap', borderBottom: '1px solid var(--theme-border, #dce1e8)', flexShrink: 0 };
export const workflowNavStyle: React.CSSProperties = { background: 'var(--theme-bg, #f8f9fc)', padding: 8, borderRight: '1px solid var(--theme-border, #dce1e8)', display: 'flex', flexDirection: 'column', gap: 4 };
export const workflowDialogStyle: React.CSSProperties = { fontFamily: 'inherit', fontSize: 13, lineHeight: 1.65, border: '1px solid var(--theme-border, #dce1e8)', boxShadow: '0 24px 80px #0004', borderRadius: 16 };
export const workflowNoticeStyle: React.CSSProperties = { margin: '8px 0', padding: '10px 12px', borderRadius: 8, background: 'var(--theme-bg, #f4f6fa)', color: 'var(--theme-text-muted, #687487)', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' };

export const WorkflowEmptyState: React.FC<{ icon: IconName; title: string; children: React.ReactNode }> = ({ icon, title, children }) =>
  <div style={{ minHeight: 240, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: 24, gap: 12 }}>
    <span style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: 16, color: 'var(--theme-accent, #4b82f0)', background: 'var(--theme-accent-bg, #4b82f014)' }}><WorkflowIcon name={icon} size={25} /></span>
    <strong style={{ fontSize: 16, fontWeight: 600 }}>{title}</strong>
    <div style={{ maxWidth: 340, color: 'var(--theme-text-muted, #687487)', fontSize: 13, lineHeight: 1.8 }}>{children}</div>
  </div>;

/** 轻量非模态浮层；定位约束在视口内，面板状态保留，自动提示不抢草稿焦点。 */
export const WorkflowPopover: React.FC<{ label: string; title: string; icon: IconName; open: boolean; onOpenChange: (open: boolean) => void;
  children: React.ReactNode; badge?: string | number; warning?: boolean; width?: number }> = ({ label, title, icon, open, onOpenChange, children, badge, warning, width = 380 }) => {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const visible = useContext(AppModalVisibilityContext), frozen = useContext(WorkbenchInteractionContext);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open || !visible || frozen) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const availableWidth = Math.min(width, window.innerWidth - 24);
      const above = rect.top > window.innerHeight / 2;
      setPosition({ width: availableWidth, left: Math.max(12, Math.min(rect.right - availableWidth, window.innerWidth - availableWidth - 12)),
        ...(above ? { bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(120, rect.top - 24) } : { top: rect.bottom + 8, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 24) }) });
    };
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) onOpenChange(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); const inside = panel.current?.contains(document.activeElement); onOpenChange(false); if (inside) trigger.current?.focus(); } };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open, visible, frozen, width, onOpenChange]);
  return <>
    <WorkflowButton ref={trigger} tone="quiet" icon={icon} aria-label={label} title={title || label} aria-expanded={open} aria-haspopup="dialog" disabled={frozen}
      style={{ whiteSpace: 'nowrap', ...(warning ? { color: 'var(--theme-warning, #b7791f)' } : {}) }}
      onClick={() => { onOpenChange(!open); if (!open) requestAnimationFrame(() => panel.current?.focus()); }}>
      {title}{badge != null && <span style={{ minWidth: 16, padding: '0 4px', borderRadius: 5, fontSize: 10, background: 'var(--theme-accent-bg, #4b82f014)', color: 'var(--theme-accent, #4b82f0)' }}>{badge}</span>}
    </WorkflowButton>
    <AppModalPortal><div ref={panel} role="dialog" aria-label={label} tabIndex={-1} hidden={!open}
      style={{ position: 'fixed', zIndex: 30000, boxSizing: 'border-box', ...position, display: open ? 'block' : 'none', overflow: 'auto', padding: 16,
        border: '1px solid var(--theme-border, #dce1e8)', borderRadius: 12, background: 'var(--theme-bg-secondary, #fff)', color: 'var(--theme-text, #273244)', boxShadow: '0 12px 40px #0003', font: 'inherit', fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong><WorkflowButton tone="quiet" icon="close" aria-label={`收起${label}`} onClick={() => { onOpenChange(false); trigger.current?.focus(); }} style={{ padding: 4, minHeight: 26 }} />
      </div>{children}
    </div></AppModalPortal>
  </>;
};

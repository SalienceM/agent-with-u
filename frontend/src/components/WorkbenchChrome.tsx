import React, { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AppModalPortal, AppModalVisibilityContext } from './AppModalPortal';

/** 工作台控件复用应用主题；不跟随壁纸透明度降低文字可读性。 */
export const workbenchButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 'var(--ui-control-height, 30px)', padding: '4px 8px', boxSizing: 'border-box',
  border: '1px solid var(--theme-border)', borderRadius: 'var(--ui-radius-md, 6px)',
  background: 'var(--theme-sidebar-solid, var(--theme-bg-secondary))', color: 'var(--theme-text)',
  fontFamily: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer', flexShrink: 0,
};
export const workbenchFieldStyle: React.CSSProperties = {
  ...workbenchButtonStyle, background: 'var(--theme-panel-solid, var(--theme-bg))', cursor: 'text', minWidth: 0,
};
export const workbenchNoticeStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12, lineHeight: 1.6, flexShrink: 0,
  background: 'var(--theme-panel-solid, var(--theme-bg))', borderBottom: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', overflowWrap: 'anywhere',
};

export type WorkbenchIconName = 'chat' | 'code' | 'files' | 'panel' | 'terminal' | 'window' | 'attach' | 'more' | 'language' | 'search' | 'diff' | 'close' | 'restore' | 'archive';
const paths: Record<WorkbenchIconName, React.ReactNode> = {
  chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></>,
  files: <><path d="M3 6h7l2 2h9v12H3Z" /><path d="M3 6V4h7l2 2h7v2" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  window: <><path d="M14 3h7v7m0-7-9 9M10 5H4v15h15v-6" /></>,
  attach: <><path d="M10 4H4v16h16v-6M21 3 11 13m0-7v7h7" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  language: <><path d="m8 5-5 7 5 7m8-14 5 7-5 7M14 4l-4 16" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  diff: <><path d="M7 3v18m10-18v18M4 6h6m4 12h6M17 15v6" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  restore: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /><path d="M12 7v5l3 2" /></>,
  archive: <><path d="M4 8h16v13H4ZM3 3h18v5H3Z" /><path d="M9 12h6" /></>,
};
export const WorkbenchIcon: React.FC<{ name: WorkbenchIconName; size?: number }> = ({ name, size = 16 }) =>
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{paths[name]}</svg>;

export const WorkbenchButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: WorkbenchIconName }> = ({ icon, children, style, className = '', ...props }) =>
  <button type="button" {...props} className={`awu-wb-control ${className}`} style={{ ...workbenchButtonStyle, ...style }}>
    {icon && <WorkbenchIcon name={icon} />}{children}
  </button>;

export const WorkbenchChromeStyles: React.FC = () => <style>{`
  .awu-wb-control:not(:disabled):hover { background: var(--theme-accent-bg) !important; color: var(--theme-accent) !important; }
  .awu-wb-control:disabled { opacity: .42; cursor: not-allowed !important; }
  .awu-wb-control:focus-visible, .awu-wb-popover input:focus-visible, .awu-wb-popover select:focus-visible,
  .awu-session-tabs button:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: -2px; }
  .awu-wb-control[aria-pressed="true"] { color: var(--theme-accent) !important; background: var(--theme-accent-bg) !important; }
  .awu-wb-popover input[type="checkbox"] { accent-color: var(--theme-accent); }
  .awu-wb-popover p { line-height: 1.65; }
  .awu-wb-menu-action { width: 100%; justify-content: flex-start !important; border-color: transparent !important; background: transparent !important; padding: 7px 9px !important; }
  .awu-session-tab:hover { background: var(--ui-surface-hover) !important; }
  .awu-session-tab[data-active="true"] { background: var(--theme-panel-solid, var(--theme-bg)) !important; }
  .awu-wb-resize:hover, .awu-wb-resize:focus-visible { background: var(--theme-accent) !important; outline: none; }
  @media (max-width: 600px) { .awu-wb-modes svg { display: none; } [data-workbench-header] { gap: 3px !important; padding-inline: 6px !important; } }
  @media (pointer: coarse) { .awu-wb-control { min-height: 36px !important; min-width: 36px; } }
`}</style>;

/** 非模态按需面板：不挤压编辑器，主题继承自 app-root，支持键盘退出/回焦及窄屏。 */
export const WorkbenchPopover: React.FC<{
  label: string; icon?: WorkbenchIconName; trigger?: React.ReactNode; width?: number;
  disabled?: boolean; openSignal?: unknown; contextMenu?: boolean; triggerStyle?: React.CSSProperties;
  triggerless?: boolean; externalTrigger?: HTMLElement;
  children: (close: () => void) => React.ReactNode;
}> = ({ label, icon = 'more', trigger, width = 320, disabled, openSignal, contextMenu, triggerStyle, triggerless, externalTrigger, children }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8, maxHeight: 400 });
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const visible = useContext(AppModalVisibilityContext), id = useId();
  const anchor = () => triggerless ? externalTrigger : button.current;
  const close = () => { setOpen(false); const target = anchor(); if (target?.isConnected && target.getClientRects().length) target.focus(); };
  useEffect(() => { if (!visible || disabled) setOpen(false); }, [visible, disabled]);
  // 外部 Tab 请求只消费一次；切回可见视图时不能重放旧请求。
  useEffect(() => { if (openSignal && visible && !disabled) setOpen(true); else if (triggerless) setOpen(false); }, [openSignal]);
  useLayoutEffect(() => {
    if (!open || !visible) return;
    const place = () => {
      const target = anchor();
      if (!target?.isConnected || !target.getClientRects().length) { setOpen(false); return; }
      const box = target.getBoundingClientRect();
      const panelWidth = Math.min(width, window.innerWidth - 16);
      const top = Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 120));
      const right = triggerless ? window.innerWidth - box.left - panelWidth : window.innerWidth - box.right;
      setPosition({ top, right: Math.max(8, Math.min(right, window.innerWidth - panelWidth - 8)), maxHeight: window.innerHeight - top - 12 });
    };
    place();
    panel.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor()?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) place(); };
    window.addEventListener('resize', place); document.addEventListener('pointerdown', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('pointerdown', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open, visible, width, triggerless, externalTrigger, openSignal]);
  return <>
    {!triggerless && <button ref={button} type="button" className="awu-wb-control" aria-label={label} title={label} disabled={disabled}
      aria-expanded={open && visible} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      style={{ ...workbenchButtonStyle, borderColor: 'transparent', background: 'transparent', padding: '4px 7px', ...triggerStyle }}
      onContextMenu={contextMenu ? event => { event.preventDefault(); setOpen(true); } : undefined}
      onKeyDown={contextMenu ? event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setOpen(true); } } : undefined}
      onClick={() => setOpen(!open)}><WorkbenchIcon name={icon} />{trigger}</button>}
    {open && visible && <AppModalPortal><div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1}
      className="awu-wb-popover" style={{ position: 'fixed', zIndex: 10020, ...position, width: Math.min(width, window.innerWidth - 16),
        boxSizing: 'border-box', overflow: 'auto', padding: 8, border: '1px solid var(--theme-border)', borderRadius: 'var(--ui-radius-lg, 8px)',
        background: 'var(--theme-popover-bg, var(--theme-bg-secondary))', color: 'var(--theme-text)', boxShadow: 'var(--ui-shadow-float)', fontSize: 12, outline: 'none' }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') || []).filter(el => el.getClientRects().length);
          if (!items.length) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === panel.current)) { event.preventDefault(); items.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
        }
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 6px', borderBottom: '1px solid var(--theme-border)', marginBottom: 6 }}>
        <span style={{ flex: 1, fontWeight: 600 }}>{label}</span><WorkbenchButton icon="close" aria-label={`关闭${label}`} title={`关闭${label}`} onClick={close} style={{ border: 0, background: 'transparent', padding: 4 }} />
      </div>{children(close)}
    </div></AppModalPortal>}
  </>;
};

export const WorkbenchOverflow: React.FC<React.PropsWithChildren<{ enabled: boolean; label: string }>> = ({ enabled, label, children }) =>
  enabled ? <WorkbenchPopover label={label}>{close => <div onClick={event => {
    if ((event.target as HTMLElement).closest('button:not(:disabled)')) close();
  }} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{children}</div>}</WorkbenchPopover> : <>{children}</>;

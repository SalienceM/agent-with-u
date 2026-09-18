import React, { useId, useState } from 'react';

interface Props {
  name: string;
  label: string;
  icon: string;
  subtitle: string;
  onOpen: () => void;
  expanded?: boolean;
  openLabel?: string;
  primaryAction?: React.ReactNode;
  actions: React.ReactNode;
  children?: React.ReactNode;
}

/** 库中的仓库、独立 Skill 和 Prompt 共用同一行；低频管理操作按需展开。 */
export const AbilityLibraryRow: React.FC<Props> = ({ name, label, icon, subtitle, onOpen, expanded, openLabel, primaryAction, actions, children }) => {
  const [managing, setManaging] = useState(false);
  const actionsId = useId();
  return <section aria-label={label} className="ability-library-row" style={rowStyle}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <button type="button" aria-label={openLabel} aria-expanded={expanded} onClick={onOpen}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: '10px 2px', border: 0, background: 'transparent', color: 'var(--theme-text)', textAlign: 'left', cursor: 'pointer' }}>
        <span aria-hidden="true" style={{ width: 32, height: 32, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--theme-bg-secondary)', fontSize: 18 }}>{icon}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span title={name} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, lineHeight: '20px' }}>{name}</span>
          <span title={subtitle} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: '18px' }}>{subtitle}</span>
        </span>
        {expanded !== undefined && <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>{expanded ? '⌄' : '›'}</span>}
      </button>
      {primaryAction}
      <button type="button" aria-label={`管理 ${name}`} title="管理" aria-expanded={managing} aria-controls={actionsId}
        onClick={() => setManaging(value => !value)} style={{ ...libraryActionStyle, width: 34, padding: 0, background: managing ? 'var(--theme-accent-bg)' : 'transparent', fontSize: 17 }}>···</button>
    </div>
    {managing && <div id={actionsId} style={{ borderTop: '1px solid var(--theme-border)', padding: '10px 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div>}
    {children}
  </section>;
};

export const libraryActionStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text)',
  borderRadius: 6, padding: '6px 10px', minHeight: 32, fontSize: 12, cursor: 'pointer', flexShrink: 0,
};
export const libraryManualStyle: React.CSSProperties = { ...libraryActionStyle, borderColor: 'transparent', padding: '6px', color: 'var(--theme-text-muted)' };
const rowStyle: React.CSSProperties = { minWidth: 0, padding: '0 10px', border: '1px solid var(--theme-border)', borderRadius: 9, background: 'var(--theme-bg)', boxSizing: 'border-box' };

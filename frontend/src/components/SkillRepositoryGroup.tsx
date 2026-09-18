import React, { useState } from 'react';
import { api, type SkillInfo } from '../api';
import type { SkillGroup } from '../utils/skillGroups';
import { AbilityLibraryRow, libraryActionStyle as buttonStyle, libraryManualStyle } from './AbilityLibraryRow';

interface Props {
  group: SkillGroup<SkillInfo>;
  execKey: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => Promise<void>;
  onManual: (name: string, detached: boolean) => void;
  onPrepare: (names: string[]) => void;
  onCommands: (name: string) => void;
  children: React.ReactNode;
}
export const SkillRepositoryGroup: React.FC<Props> = ({ group, execKey, disabled, onBusyChange, onChanged, onManual, onPrepare, onCommands, children }) => {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const [error, setError] = useState('');
  if (!group.parent) return <>{children}</>;
  const defaultCount = group.children.filter(child => child.isDefault).length;
  const mutate = async (rename: boolean) => {
    if (disabled) return;
    onBusyChange(true); setError('');
    try {
      const result = rename ? await api.renameSkillGroup(group.id, name, group.parent!.revision, execKey)
        : await api.setSkillGroupDefault(group.id, defaultCount !== group.children.length, execKey);
      if (result.status !== 'ok') throw new Error(result.message || '保存失败');
      if (rename) setRenaming(false);
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { onBusyChange(false); }
  };
  return <AbilityLibraryRow name={group.name} label={`Skill 仓库 ${group.name}`} icon="📦"
    subtitle={`${group.children.length} 子 Skill${defaultCount ? ` · 默认 ${defaultCount}/${group.children.length}` : ''} · ${group.parent.repository}`}
    expanded={expanded} openLabel={expanded ? '收起子 Skill' : '展开子 Skill'} onOpen={() => setExpanded(value => !value)}
    primaryAction={<button type="button" style={libraryManualStyle} title="在独立窗口打开仓库使用手册" aria-label="使用手册 ↗" onClick={() => onManual(group.id, true)}>手册 ↗</button>}
    actions={<>
      <button type="button" style={buttonStyle} disabled={disabled} onClick={() => { setName(group.name); setRenaming(value => !value); }}>改名</button>
      <button type="button" style={buttonStyle} onClick={() => onManual(group.id, false)}>维护手册</button>
      <button type="button" style={buttonStyle} onClick={() => onCommands(group.id)}>/ 命令配置</button>
      <button type="button" style={buttonStyle} onClick={() => onPrepare(group.children.map(child => child.name))}>运行准备 / 状态</button>
      <button type="button" style={buttonStyle} disabled={disabled} onClick={() => void mutate(false)}>{defaultCount === group.children.length ? '取消整组默认' : '整组设为默认'}</button>
      <span style={{ fontSize: 11, width: '100%', color: 'var(--theme-text-muted)' }}>默认档 {defaultCount}/{group.children.length} · 仅影响新建会话；点击仓库名称管理子 Skill</span>
      {renaming && <form onSubmit={event => { event.preventDefault(); void mutate(true); }} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, width: '100%' }}>
        <input autoFocus aria-label="父级名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} style={{ ...buttonStyle, flex: 1, minWidth: 80, width: '100%', background: 'var(--theme-input-bg)', boxSizing: 'border-box' }} />
        <button type="submit" style={buttonStyle} disabled={disabled || !name.trim()}>保存名称</button>
        <button type="button" style={buttonStyle} disabled={disabled} onClick={() => setRenaming(false)}>取消</button>
      </form>}
    </>}>
    {error && <div role="alert" style={{ color: '#ef6b73', fontSize: 12, paddingBottom: 8 }}>{error}</div>}
    {expanded && <div className="ability-library-children" style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--theme-border)', padding: '8px 0 10px 10px' }}>{children}</div>}
  </AbilityLibraryRow>;
};

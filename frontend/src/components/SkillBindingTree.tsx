import React, { useMemo } from 'react';
import { groupSkills, selectSkillGroup, type SkillMember } from '../utils/skillGroups';

interface Props {
  skills: (SkillMember & { content?: string })[];
  selected: string[];
  disabled: boolean;
  onChange: (names: string[]) => void;
  onPreview: (skill: SkillMember & { content?: string }) => void;
}
export const SkillBindingTree: React.FC<Props> = ({ skills, selected, disabled, onChange, onPreview }) => {
  const groups = useMemo(() => groupSkills(skills), [skills]);
  return <div aria-label="Skill 仓库绑定">
    {groups.map(group => {
      const members = group.children.map(child => child.name);
      const count = members.filter(name => selected.includes(name)).length;
      const childRow = (skill: Props['skills'][number]) => <div key={skill.name} style={rowStyle}>
        <label style={labelStyle}><input type="checkbox" disabled={disabled} checked={selected.includes(skill.name)}
          onChange={event => onChange(selectSkillGroup(selected, [skill.name], event.target.checked))} /><span>{skill.name}</span></label>
        {group.parent && <button type="button" style={buttonStyle} disabled={disabled} onClick={() => onChange(selectSkillGroup(selected, members, true, skill.name))}>仅此项</button>}
        <button type="button" style={buttonStyle} onClick={() => onPreview(skill)}>预览</button>
      </div>;
      if (!group.parent) return childRow(group.children[0]);
      return <section key={group.id} aria-label={`仓库 ${group.name}`} style={{ borderBottom: '1px solid var(--theme-border)', padding: '5px 4px' }}>
        <div style={rowStyle}>
          <label style={labelStyle}><input type="checkbox" disabled={disabled} checked={count === members.length}
            ref={element => { if (element) element.indeterminate = count > 0 && count < members.length; }}
            aria-checked={count > 0 && count < members.length ? 'mixed' : count === members.length}
            onChange={event => onChange(selectSkillGroup(selected, members, event.target.checked))} />
            <strong>{group.name}</strong></label><span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{count}/{members.length} 已启用</span>
        </div>
        <details><summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--theme-text-muted)', padding: '4px 8px' }}>子 Skill · {group.parent.repository}</summary>
          {group.children.map(childRow)}
        </details>
      </section>;
    })}
    <div style={{ fontSize: 10, padding: 8, color: 'var(--theme-text-muted)' }}>父级一次选择当前全部子项；后续新安装的子项需再次选择，已有绑定不会自动扩张。</div>
  </div>;
};
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px', fontSize: 12 };
const labelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflowWrap: 'anywhere', cursor: 'pointer' };
const buttonStyle: React.CSSProperties = { padding: '3px 6px', fontSize: 10, flexShrink: 0, border: '1px solid var(--theme-border)', borderRadius: 4, background: 'var(--theme-bg)', color: 'var(--theme-text)', cursor: 'pointer' };

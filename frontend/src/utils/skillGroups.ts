export interface SkillParent { id: string; name: string; repository: string; revision: string }
export interface SkillMember { name: string; parent?: SkillParent }
export interface SkillGroup<T extends SkillMember> { id: string; name: string; parent?: SkillParent; children: T[] }

export function groupSkills<T extends SkillMember>(skills: T[]): SkillGroup<T>[] {
  const groups = new Map<string, SkillGroup<T>>();
  for (const skill of skills) {
    const id = skill.parent?.id || `skill:${skill.name}`;
    if (!groups.has(id)) groups.set(id, { id, name: skill.parent?.name || skill.name, parent: skill.parent, children: [] });
    groups.get(id)!.children.push(skill);
  }
  return [...groups.values()];
}

// 绑定仍持久化真实子项；父级只是对当前已安装成员的一次原子选择。
// 之后新装的子项不会绕过用户选择自动取得执行权限。
export function selectSkillGroup(selected: string[], members: string[], enabled: boolean, only?: string): string[] {
  const result = selected.filter(name => !members.includes(name));
  return [...new Set([...result, ...(only ? [only] : enabled ? members : [])])];
}

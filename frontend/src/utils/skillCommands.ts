export interface SkillInvocation { name: string; arguments: string; digest?: string }
export interface SkillCommand {
  name: string;
  description: string;
  skillName: string;
  digest: string;
  source: string;
  kind: 'skill';
  requiresArguments: boolean;
  unavailableReason?: string;
}
export interface SkillCommandCatalog {
  status: string; commands: SkillCommand[]; workingDir?: string; backendId?: string;
  nativeCommandsSupported?: boolean; note?: string; message?: string;
}
export function isSkillCommand(text: string): boolean {
  return /^\/(?:skill(?:\s|$)|opsx[-:]|native(?:\s|$))/i.test(text.trimStart());
}
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  if (!/\s/.test(text)) return text.toLowerCase();
  if (/^\/skill\s+[^\s]*$/i.test(text)) return text.toLowerCase().replace(/\s+/, ' ');
  return null;
}
export function skillInvocation(text: string, commands: SkillCommand[]): SkillInvocation | undefined {
  const value = text.trim();
  const selected = [...commands].sort((a, b) => b.name.length - a.name.length).find(item =>
    value.toLowerCase() === item.name.toLowerCase()
    || (value.toLowerCase().startsWith(item.name.toLowerCase()) && /\s/.test(value[item.name.length] || '')));
  return selected ? { name: selected.skillName, arguments: value.slice(selected.name.length).trim(), digest: selected.digest } : undefined;
}

export interface SkillInvocation { name: string; arguments: string; digest?: string }
export interface SkillCommandConfig {
  status: string; name: string; displayName?: string; owners: string[]; content: string; revision: string;
  origin: 'package' | 'compatibility' | 'new'; warnings: string[];
}
export interface SkillCommand {
  name: string;
  description: string;
  skillName: string;
  digest: string;
  source: string;
  kind: 'skill' | 'project';
  requiresArguments: boolean;
  unavailableReason?: string;
  family?: string;
  targetSkillId?: string;
  ownerSkillIds?: string[];
}
export interface SkillCommandCatalog {
  status: string; commands: SkillCommand[]; workingDir?: string; backendId?: string;
  nativeCommandsSupported?: boolean; note?: string; message?: string;
  issues?: { source: string; message: string }[];
}
// 非应用命令统一交给执行端注册表验证，包括未开过菜单的手工输入。
export const APPLICATION_COMMAND_NAMES = new Set(['/help', '/clear', '/new', '/compact', '/continue', '/model',
  '/backend', '/autocontinue', '/export', '/status', '/config', '/cost', '/init', '/migrate', '/commit', '/git']);
export function isSkillCommand(text: string): boolean {
  const token = text.trim().split(/\s+/, 1)[0].toLowerCase();
  return token.length > 1 && token.startsWith('/') && !APPLICATION_COMMAND_NAMES.has(token);
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

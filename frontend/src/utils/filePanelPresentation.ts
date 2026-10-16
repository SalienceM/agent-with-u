/** 展示投影不触发读取；未知证据不能投影成干净或已同步。 */
export function filePanelGit(input: {
  detected: boolean; available: boolean; loading: boolean; ready: boolean; error: string;
  branch: string; staged: number; unstaged: number;
}): { state: 'unknown' | 'loading' | 'absent' | 'ready' | 'error'; label: string; detail: string } {
  const branch = input.branch || 'HEAD';
  if (input.error) return { state: 'error', label: `${input.available ? branch : 'Git'} · 未更新`, detail: input.error };
  if (!input.detected || input.loading || input.available && !input.ready)
    return { state: input.loading ? 'loading' : 'unknown', label: 'Git …', detail: input.loading ? 'Git 读取中…' : 'Git 状态未确认' };
  if (!input.available) return { state: 'absent', label: '', detail: '此目录未启用 Git' };
  const count = input.staged + input.unstaged;
  return { state: 'ready', label: `${branch} · ${count}`, detail: count
    ? `${input.staged} 已暂存 · ${input.unstaged} 未暂存` : '工作区干净' };
}

export interface FilePanelFeedback {
  id: string; text: string; kind: 'error' | 'offline' | 'active' | 'done';
}
export function filePanelFeedback(input: {
  directories: Record<string, string>; gitError: string; searchError?: string;
  conflicts: number; compared: boolean; offline: boolean; active?: string;
  messages?: FilePanelFeedback[];
}): FilePanelFeedback[] {
  const rows: FilePanelFeedback[] = Object.entries(input.directories).filter(([, text]) => text)
    .map(([path, text]) => ({ id: `directory:${path}`, text: `${path || '根目录'} · ${text}`, kind: 'error' }));
  if (input.gitError) rows.push({ id: 'git', text: input.gitError, kind: 'error' });
  if (input.searchError) rows.push({ id: 'search', text: `执行端搜索未完成：${input.searchError}`, kind: 'error' });
  if (input.compared && input.conflicts) rows.push({ id: 'conflicts', text: `比对发现 ${input.conflicts} 项冲突`, kind: 'error' });
  if (input.offline) rows.push({ id: 'offline', text: '执行端离线 · 可查看已有本机副本', kind: 'offline' });
  if (input.active) rows.push({ id: 'active', text: input.active, kind: 'active' });
  rows.push(...(input.messages || []));
  const priority = { error: 0, offline: 1, active: 2, done: 3 };
  return rows.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

export function filePanelComparison(compared: boolean, summary?: { differs: number; conflict: number; localOnly: number; cloud: number } | null): string {
  return compared && summary
    ? `比对结果 · 不同 ${summary.differs} · 冲突 ${summary.conflict} · 仅本机 ${summary.localOnly} · 仅执行端 ${summary.cloud}`
    : '尚未比对 · 文件存在不代表内容一致';
}

import type { GitFileStatus, GitFileStatusType } from '../types/git';

const priority: GitFileStatusType[] = ['conflicted', 'deleted', 'added', 'renamed', 'modified', 'untracked', 'copied'];

/** 按 Git 快照一次性汇总父目录，避免每次绘制每行都遍历全部变更。 */
export function buildGitDirectoryStatuses(files: Record<string, GitFileStatus>): Map<string, GitFileStatus> {
  const directories = new Map<string, GitFileStatus>();
  for (const [path, file] of Object.entries(files)) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/');
      const previous = directories.get(parent);
      if (!previous || priority.indexOf(file.status) < priority.indexOf(previous.status)) directories.set(parent, file);
    }
  }
  return directories;
}

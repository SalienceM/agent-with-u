// 文件同步的纯路径策略。独立于 WebSocket/Tauri，便于前后端边界测试。
function wildcardToRegExp(pat: string): RegExp {
  const body = pat
    .split('')
    .map((c) => {
      if (c === '*') return '.*';
      if (c === '?') return '.';
      return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`);
}

export function isGitMetadataPath(rel: string): boolean {
  return rel.replace(/\\/g, '/').split('/').filter(Boolean).includes('.git');
}

/** 对旧执行端返回的清单也执行客户端兜底过滤，避免协议降级重新带入 .git。 */
export function filterGitMetadata<T>(
  entries: Record<string, T> | undefined,
  includeGit = false,
): Record<string, T> | undefined {
  if (!entries || includeGit) return entries;
  return Object.fromEntries(
    Object.entries(entries).filter(([rel]) => !isGitMetadataPath(rel)),
  );
}

/** gitignore 风格的简化匹配；Git 元数据只能由显式开关放行。 */
export function isIgnored(rel: string, patterns: string[], includeGit = false): boolean {
  const r = rel.replace(/\\/g, '/');
  const segs = r.split('/').filter(Boolean);
  if (segs.includes('.git')) return !includeGit;
  for (const pat of patterns) {
    const p = pat.trim().replace(/\/+$/, '');
    if (!p) continue;
    const re = wildcardToRegExp(p);
    if (re.test(r)) return true;
    for (const s of segs) if (re.test(s)) return true;
  }
  return false;
}

export interface RankedFilePath {
  path: string;
  score: number;
}

export interface RankedFileSearch {
  results: RankedFilePath[];
  matched: number;
  truncated: boolean;
}

function compactQuery(query: string): string {
  return query.replace(/\\/g, '/').toLocaleLowerCase().replace(/\s+/g, '');
}

/** VS Code Quick Open 风格的文件路径模糊评分。 */
export function fileSearchScore(value: string, query: string): number | null {
  const path = value.replace(/\\/g, '/').toLocaleLowerCase();
  const needle = compactQuery(query);
  if (!path || !needle) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const depthPenalty = (path.match(/\//g)?.length || 0) * 8;

  const nameIndex = name.indexOf(needle);
  if (nameIndex >= 0) {
    return 30_000 - nameIndex * 20 - (name.length - needle.length) - depthPenalty;
  }
  const pathIndex = path.indexOf(needle);
  if (pathIndex >= 0) {
    return 20_000 - pathIndex * 4 - (path.length - needle.length) - depthPenalty;
  }

  const fuzzy = (candidate: string, base: number): number | null => {
    const positions: number[] = [];
    let cursor = -1;
    for (const char of needle) {
      cursor = candidate.indexOf(char, cursor + 1);
      if (cursor < 0) return null;
      positions.push(cursor);
    }
    const span = positions[positions.length - 1] - positions[0] + 1;
    const gaps = span - needle.length;
    const boundaries = positions.filter((position) => (
      position === 0 || '/._- '.includes(candidate[position - 1])
    )).length;
    return base + boundaries * 35 - gaps * 12 - positions[0] - depthPenalty;
  };

  const candidates = [fuzzy(name, 11_000), fuzzy(path, 10_000)]
    .filter((score): score is number => score !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

export function rankFileSearchPaths(
  paths: Iterable<string>,
  query: string,
  limit = 200,
): RankedFileSearch {
  const ranked: RankedFilePath[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, '/');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const score = fileSearchScore(path, query);
    if (score !== null) ranked.push({ path, score });
  }
  ranked.sort((left, right) => (
    right.score - left.score
    || left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    || left.path.localeCompare(right.path)
  ));
  const safeLimit = Math.max(1, limit);
  return {
    results: ranked.slice(0, safeLimit),
    matched: ranked.length,
    truncated: ranked.length > safeLimit,
  };
}

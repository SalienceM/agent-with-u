/** 比对专用扫描范围；不改变普通目录传输或项目 .gitignore。 */
export interface SyncScanRules { version: 1; prefixes: string[]; excludes: string[] }
export const EMPTY_SCAN_RULES: SyncScanRules = { version: 1, prefixes: [], excludes: [] };
export const hasScanRules = (rules?: SyncScanRules): boolean => !!rules && !!(rules.prefixes.length || rules.excludes.length);

export function parseScanRules(prefixes: string, excludes: string): SyncScanRules {
  const lines = (text: string, patterns: boolean) => {
    if (text.length > 16_384) throw new Error('扫描规则过长');
    const result = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (result.length > 128) throw new Error('每栏最多 128 条规则');
    return result.map(line => {
      line = line.replace(/\\/g, '/').replace(/^\.\//, '');
      const body = patterns ? line.replace(/^!/, '').replace(/^\//, '') : line;
      if (!body || body.length > 512 || /[:\x00-\x1f\[\]{}]/.test(body)
        || (!patterns && /[*?!]/.test(body)) || body.startsWith('/')
        || body.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')
        || (patterns && body.split('/').some(part => part.includes('**') && part !== '**'))) {
        throw new Error(`不支持的扫描规则：${line}（使用相对路径；** 须单独一段）`);
      }
      return line;
    });
  };
  return { version: 1, prefixes: [...new Set(lines(prefixes, false))], excludes: lines(excludes, true) };
}

function glob(pattern: string, path: string): boolean {
  const p = pattern.split('/'), s = path.split('/');
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (i === p.length) result = j === s.length;
    else if (p[i] === '**') result = match(i + 1, j) || (j < s.length && match(i, j + 1));
    else result = j < s.length && segmentMatch(p[i], s[j]) && match(i + 1, j + 1);
    memo.set(key, result); return result;
  };
  return match(0, 0);
}

// 有界动态规划，不把用户输入转为可能灾难性回溯的正则。
function segmentMatch(pattern: string, text: string): boolean {
  const chars = Array.from(text);
  let previous = Array(chars.length + 1).fill(false) as boolean[];
  previous[0] = true;
  for (const char of pattern) {
    const next = Array(chars.length + 1).fill(false) as boolean[];
    next[0] = char === '*' && previous[0];
    for (let i = 1; i <= chars.length; i++) {
      next[i] = char === '*' ? previous[i] || next[i - 1] : previous[i - 1] && (char === '?' || char === chars[i - 1]);
    }
    previous = next;
  }
  return previous[chars.length];
}

/** 与 gitignore 一样，被剪枝的父目录不能只靠 !child 重新纳入。 */
export function scanAllows(rules: SyncScanRules | undefined, rel: string, directory = false): boolean {
  if (!rules || !hasScanRules(rules)) return true;
  if (rules.prefixes.length && !rules.prefixes.some(prefix => rel.startsWith(prefix)
    || (directory && (prefix.startsWith(rel + '/') || rel === prefix.replace(/\/$/, ''))))) return false;
  if (!rules.excludes.length) return true;
  const parts = rel.split('/');
  for (let end = 1; end <= parts.length; end++) {
    const dir = end < parts.length || directory, path = parts.slice(0, end).join('/');
    let excluded = false;
    for (const raw of rules.excludes) {
      const negate = raw.startsWith('!');
      let pattern = negate ? raw.slice(1) : raw;
      const anchored = pattern.startsWith('/'), dirOnly = pattern.endsWith('/');
      pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
      if (dirOnly && !dir) continue;
      if (glob(pattern, anchored || pattern.includes('/') ? path : parts[end - 1])) excluded = !negate;
    }
    if (excluded) return false;
  }
  return true;
}

export function loadScanRules(key: string): SyncScanRules {
  try {
    const data = JSON.parse(localStorage.getItem(`awu-scan-rules-v1:${key}`) || 'null');
    if (data?.version === 1 && Array.isArray(data.prefixes) && Array.isArray(data.excludes)) {
      return parseScanRules(data.prefixes.join('\n'), data.excludes.join('\n'));
    }
  } catch { /* 无效本地配置不触发扫描 */ }
  return EMPTY_SCAN_RULES;
}

export function saveScanRules(key: string, rules: SyncScanRules): void {
  localStorage.setItem(`awu-scan-rules-v1:${key}`, JSON.stringify(rules));
}

/**
 * 简单的行级 diff 算法（Myers LCS）。
 * 返回 unified diff 格式的行数组，用于 DiffView 渲染。
 */

export type DiffLineType = 'context' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 计算最长公共子序列（行级），返回 LCS 的行集合。 */
function lcs(a: string[], b: string[]): boolean[][] {
  const m = a.length, n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to mark which lines are "common"
  const inLcsA: boolean[] = new Array(m).fill(false);
  const inLcsB: boolean[] = new Array(n).fill(false);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      inLcsA[i - 1] = true;
      inLcsB[j - 1] = true;
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return [inLcsA, inLcsB];
}

/**
 * 计算 oldText 到 newText 的行级 diff。
 * context：上下文行数（±N 行），0 表示不显示上下文。
 */
export function computeDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // 如果内容过大（>500行），跳 LCS 直接全量展示避免卡顿
  if (oldLines.length > 500 || newLines.length > 500) {
    const result: DiffLine[] = [];
    for (const l of oldLines) result.push({ type: 'removed', text: l });
    for (const l of newLines) result.push({ type: 'added', text: l });
    return result;
  }

  const [inLcsA, inLcsB] = lcs(oldLines, newLines);

  // Build raw diff sequence
  type RawLine = { type: DiffLineType; text: string };
  const raw: RawLine[] = [];
  let ai = 0, bi = 0;
  while (ai < oldLines.length || bi < newLines.length) {
    if (ai < oldLines.length && bi < newLines.length && inLcsA[ai] && inLcsB[bi]) {
      raw.push({ type: 'context', text: oldLines[ai] });
      ai++; bi++;
    } else if (ai < oldLines.length && !inLcsA[ai]) {
      raw.push({ type: 'removed', text: oldLines[ai] });
      ai++;
    } else if (bi < newLines.length && !inLcsB[bi]) {
      raw.push({ type: 'added', text: newLines[bi] });
      bi++;
    } else {
      // Shouldn't happen
      ai++; bi++;
    }
  }

  if (context === 0) return raw;

  // Apply context window: only show context lines near changes
  const changed = raw.map((l) => l.type !== 'context');
  const visible = new Array(raw.length).fill(false);
  for (let idx = 0; idx < raw.length; idx++) {
    if (changed[idx]) {
      for (let k = Math.max(0, idx - context); k <= Math.min(raw.length - 1, idx + context); k++) {
        visible[k] = true;
      }
    }
  }

  const result: DiffLine[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    if (visible[idx]) {
      result.push(raw[idx]);
    } else if (idx > 0 && visible[idx - 1]) {
      result.push({ type: 'context', text: '...' });
    }
  }
  // Remove trailing ellipsis
  while (result.length > 0 && result[result.length - 1].text === '...') result.pop();

  return result;
}

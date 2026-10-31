import { decodeDocumentBytes, specializedDocument } from './documentCodec';
import { REVIEW_MAX_BYTES, REVIEW_MAX_LINES, REVIEW_MAX_LINE_LENGTH } from './directorySyncReview';

export interface ReviewText { lines: string[]; encoding: string; bom: string; eol: string; finalNewline: boolean; mixedEndings?: string }
export interface DiffRow { left: number | null; right: number | null; kind: 'equal' | 'change' }
export type ReviewDiff = { status: 'ok'; left: ReviewText; right: ReviewText; rows: DiffRow[]; hunks: number[]; formatDifferent: boolean }
  | { status: 'unavailable'; reasonCode: string; side?: 'local' | 'remote' };
export function reviewText(bytes: Uint8Array, path: string): ReviewText {
  if (bytes.length > REVIEW_MAX_BYTES) throw new Error('too_large');
  if (specializedDocument(path)) throw new Error('specialized_preview');
  const decoded = decodeDocumentBytes(bytes, true);
  if (decoded.reasonCode) throw new Error(decoded.reasonCode);
  const finalNewline = decoded.text.endsWith('\n');
  const lines = decoded.text === '' ? [] : decoded.text.split('\n');
  if (lines.length > REVIEW_MAX_LINES) throw new Error('too_many_lines');
  if (lines.some(line => line.length > REVIEW_MAX_LINE_LENGTH)) throw new Error('line_too_long');
  if (finalNewline) lines.pop();
  return { lines, encoding: decoded.encoding, bom: decoded.bom, eol: decoded.eol, finalNewline, mixedEndings: decoded.lineEndings?.join(' ') };
}
/** Myers 最短编辑路径；操作、追踪内存、总时限均有界，无伪造整文件 diff 兜底。 */
export function calculateReviewDiff(leftBytes: Uint8Array, rightBytes: Uint8Array, path: string,
  options: { maxOperations?: number; deadlineMs?: number; now?: () => number; cancelled?: () => boolean } = {}): ReviewDiff {
  const now = options.now || (() => performance.now()), deadline = now() + (options.deadlineMs ?? 2000);
  let operations = 0;
  const tick = () => {
    if (++operations > (options.maxOperations ?? 2_000_000) || now() > deadline) throw new Error('diff_budget_exceeded');
    if (options.cancelled?.()) throw new Error('diff_cancelled');
  };
  try {
    tick();
    let left: ReviewText, right: ReviewText;
    try { left = reviewText(leftBytes, path); }
    catch (error) { return { status: 'unavailable', reasonCode: error instanceof Error ? error.message : 'decode_failed', side: 'local' }; }
    try { right = reviewText(rightBytes, path); }
    catch (error) { return { status: 'unavailable', reasonCode: error instanceof Error ? error.message : 'decode_failed', side: 'remote' }; }
    const a = left.lines, b = right.lines, n = a.length, m = b.length;
    const trace: Int32Array[] = [];
    let cells = 0, depth = 0;
    outer: for (let d = 0; d <= n + m; d++) {
      cells += 2 * d + 1;
      if (cells > 2_000_000) throw new Error('diff_budget_exceeded');
      const row = new Int32Array(2 * d + 1), prev = trace[d - 1];
      const at = (k: number) => prev?.[k + d - 1] ?? 0;
      for (let k = -d; k <= d; k += 2) {
        tick();
        let x = d === 0 ? 0 : k === -d || k !== d && at(k - 1) < at(k + 1) ? at(k + 1) : at(k - 1) + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { tick(); x++; y++; }
        row[k + d] = x;
        if (x >= n && y >= m) { trace.push(row); depth = d; break outer; }
      }
      trace.push(row);
    }
    const edits: { kind: 'equal' | 'delete' | 'insert'; left?: number; right?: number }[] = [];
    let x = n, y = m;
    for (let d = depth; d > 0; d--) {
      tick();
      const prev = trace[d - 1], k = x - y;
      const at = (key: number) => prev[key + d - 1];
      const pk = k === -d || k !== d && at(k - 1) < at(k + 1) ? k + 1 : k - 1;
      const px = at(pk), py = px - pk;
      while (x > px && y > py) { tick(); edits.push({ kind: 'equal', left: --x, right: --y }); }
      if (x === px) edits.push({ kind: 'insert', right: --y });
      else edits.push({ kind: 'delete', left: --x });
    }
    while (x > 0 && y > 0) { tick(); edits.push({ kind: 'equal', left: --x, right: --y }); }
    edits.reverse();
    const rows: DiffRow[] = [], hunks: number[] = [];
    for (let i = 0; i < edits.length;) {
      tick();
      const item = edits[i];
      if (item.kind === 'equal') { rows.push({ kind: 'equal', left: item.left!, right: item.right! }); i++; continue; }
      const deleted: number[] = [], inserted: number[] = [];
      while (i < edits.length && edits[i].kind !== 'equal') {
        const edit = edits[i++];
        if (edit.kind === 'delete') deleted.push(edit.left!); else inserted.push(edit.right!);
      }
      hunks.push(rows.length);
      for (let j = 0; j < Math.max(deleted.length, inserted.length); j++) rows.push({ kind: 'change', left: deleted[j] ?? null, right: inserted[j] ?? null });
    }
    return { status: 'ok', left, right, rows, hunks,
      formatDifferent: left.encoding !== right.encoding || left.bom !== right.bom || left.eol !== right.eol || left.finalNewline !== right.finalNewline
        || left.mixedEndings !== right.mixedEndings };
  } catch (error) { return { status: 'unavailable', reasonCode: error instanceof Error ? error.message : 'diff_unavailable' }; }
}
export type DisplayRow = { kind: 'row'; index: number } | { kind: 'fold'; start: number; end: number };
export function foldedReviewRows(rows: DiffRow[], expanded: ReadonlySet<number>): DisplayRow[] {
  const result: DisplayRow[] = [];
  for (let i = 0; i < rows.length;) {
    let end = i;
    while (end < rows.length && rows[end].kind === 'equal') end++;
    if (end - i > 12 && !expanded.has(i)) {
      for (let j = i; j < i + 3; j++) result.push({ kind: 'row', index: j });
      result.push({ kind: 'fold', start: i, end });
      for (let j = end - 3; j < end; j++) result.push({ kind: 'row', index: j });
      i = end;
    } else if (end > i) {
      while (i < end) result.push({ kind: 'row', index: i++ });
    } else result.push({ kind: 'row', index: i++ });
  }
  return result;
}

import type { TextAttachment } from '../types/attachments';
import type { ImageAttachment } from '../hooks/useClipboardImage';
import type { ReviewSelection } from '../types/sessionCollaboration';

export interface ComposerSelection { start: number; end: number; scrollTop: number }
export interface ComposerDraft {
  text: string; textAttachments: TextAttachment[]; images: ImageAttachment[]; revision: number;
  references: Array<{ id: string; content: string }>;
  review: ReviewSelection;
  selections: Record<string, ComposerSelection>; activeBlock: string; keepLongText: boolean;
}
export function validateComposerMeta(meta: any, blocks: TextAttachment[]): void {
  if (meta === undefined) return;
  const ids = new Set(['main', ...blocks.map(item => item.id)]);
  if (!meta || Object.keys(meta).some(key => !['selections', 'activeBlock', 'keepLongText', 'references', 'review'].includes(key))
    || !ids.has(meta.activeBlock) || typeof meta.keepLongText !== 'boolean' || !meta.selections || typeof meta.selections !== 'object'
    || Object.entries(meta.selections).some(([id, selection]: [string, any]) => !ids.has(id) || !selection
      || Object.keys(selection).some(key => !['start', 'end', 'scrollTop'].includes(key)) || ![selection.start, selection.end, selection.scrollTop].every(n => Number.isFinite(n) && n >= 0))
    || !Array.isArray(meta.references) || meta.references.length > 100 || meta.references.some((item: any) => !item
      || Object.keys(item).some(key => !['id', 'content'].includes(key)) || typeof item.id !== 'string' || typeof item.content !== 'string' || item.content.length > 64000)) throw new Error('编辑状态交接无效');
  if (meta.review !== undefined) {
    const r = meta.review;
    if (!r || Object.keys(r).some(key => !['roles', 'targetIds', 'newContext', 'receipt'].includes(key)) || typeof r.newContext !== 'boolean'
      || !Array.isArray(r.roles) || r.roles.length > 8 || r.roles.some((item: any) => !item || Object.keys(item).some(key => !['id', 'name', 'revision'].includes(key))
        || typeof item.id !== 'string' || typeof item.name !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1)
      || !Array.isArray(r.targetIds) || r.targetIds.length > 20 || r.targetIds.some((id: unknown) => typeof id !== 'string')) throw new Error('评议草稿交接无效');
    if (r.receipt && (Object.keys(r.receipt).some(key => !['request', 'draftRevision', 'fingerprint'].includes(key)) || typeof r.receipt.request !== 'string'
      || typeof r.receipt.fingerprint !== 'string' || !Number.isSafeInteger(r.receipt.draftRevision))) throw new Error('评议回执交接无效');
  }
}
type Content = Pick<ComposerDraft, 'text' | 'textAttachments' | 'images'>;
const copyContent = (row: Content): Content => ({ text: row.text, textAttachments: row.textAttachments.map(item => ({ ...item })), images: row.images.map(item => ({ ...item })) });
const sameContent = (a: Content, b: Content) => a.text === b.text
  && a.textAttachments.length === b.textAttachments.length && a.textAttachments.every((x, i) => x.id === b.textAttachments[i].id && x.name === b.textAttachments[i].name && x.content === b.textAttachments[i].content)
  && a.images.length === b.images.length && a.images.every((x, i) => x.id === b.images[i].id && x.base64 === b.images[i].base64 && x.mime_type === b.images[i].mime_type);
interface History { undo: string[]; redo: string[] }

/** 窗口内、身份隔离的唯一草稿；授权值从不进入此模型。 */
export class ComposerDrafts {
  private entries = new Map<string, ComposerDraft>();
  private histories = new Map<string, Map<string, History>>();
  private transforms = new Map<string, { before: ComposerDraft; after: number }>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = (): number => this.version;
  private changed(): void { this.version++; this.listeners.forEach(fn => fn()); }
  get(scope: string): ComposerDraft | undefined { return this.entries.get(scope); }
  ensure(scope: string): ComposerDraft {
    if (!this.entries.has(scope)) this.entries.set(scope, { text: '', textAttachments: [], images: [], revision: ++this.version,
      references: [], review: { roles: [], targetIds: [], newContext: false }, selections: {}, activeBlock: 'main', keepLongText: false });
    return this.entries.get(scope)!;
  }
  private history(scope: string, id: string): History {
    if (!this.histories.has(scope)) this.histories.set(scope, new Map());
    const rows = this.histories.get(scope)!;
    if (!rows.has(id)) rows.set(id, { undo: [], redo: [] });
    return rows.get(id)!;
  }
  update(scope: string, next: Content, remember = true): ComposerDraft {
    const old = this.ensure(scope);
    if (sameContent(old, next)) return old;
    if (remember) for (const [id, content] of [['main', old.text], ...old.textAttachments.map(x => [x.id, x.content])]) {
      const value = id === 'main' ? next.text : next.textAttachments.find(x => x.id === id)?.content;
      if (value !== undefined && value !== content) {
        const history = this.history(scope, id);
        history.undo.push(content); history.undo = history.undo.slice(-80); history.redo = [];
        // 单块历史有界，超大块保留最近一次，避免每键复制无限增长。
        while (history.undo.length > 1 && history.undo.reduce((n, text) => n + text.length, 0) > 2_000_000) history.undo.shift();
      }
    }
    const ids = new Set(['main', ...next.textAttachments.map(item => item.id)]);
    const row = { ...old, ...copyContent(next), revision: this.version + 1,
      selections: Object.fromEntries(Object.entries(old.selections).filter(([id]) => ids.has(id))), activeBlock: ids.has(old.activeBlock) ? old.activeBlock : 'main' };
    this.entries.set(scope, row); this.changed(); return row;
  }
  select(scope: string, id: string, selection: ComposerSelection): void {
    const row = this.ensure(scope); row.selections[id] = { ...selection };
  }
  activate(scope: string, id: string): void { this.ensure(scope).activeBlock = id; this.changed(); }
  edit(scope: string, id: string, value: string): void {
    const row = this.ensure(scope);
    this.update(scope, id === 'main' ? { ...row, text: value } : { ...row, textAttachments: row.textAttachments.map(x => x.id === id ? { ...x, content: value, size: value.length } : x) });
  }
  undo(scope: string, id: string, redo = false): boolean {
    const row = this.ensure(scope), history = this.history(scope, id), from = redo ? history.redo : history.undo;
    if (!from.length) return false;
    const current = id === 'main' ? row.text : row.textAttachments.find(x => x.id === id)?.content;
    if (current === undefined) return false;
    (redo ? history.undo : history.redo).push(current);
    const value = from.pop()!;
    this.update(scope, id === 'main' ? { ...row, text: value } : { ...row, textAttachments: row.textAttachments.map(x => x.id === id ? { ...x, content: value, size: value.length } : x) }, false);
    return true;
  }
  rename(scope: string, id: string, name: string): void {
    const row = this.ensure(scope);
    this.update(scope, { ...row, textAttachments: row.textAttachments.map(x => x.id === id ? { ...x, name: name.slice(0, 200) } : x) });
  }
  move(scope: string, id: string, direction: number): void {
    const row = this.ensure(scope), blocks = [...row.textAttachments], index = blocks.findIndex(x => x.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    this.update(scope, { ...row, textAttachments: blocks });
  }
  pack(scope: string, attachment: TextAttachment, start: number, end: number, pasted = false): void {
    const row = this.ensure(scope), before = { ...row, ...copyContent(row), selections: { ...row.selections } };
    if (pasted) before.text = row.text.slice(0, start) + attachment.content + row.text.slice(end);
    before.keepLongText = true;
    before.selections.main = { start: start + attachment.content.length, end: start + attachment.content.length, scrollTop: row.selections.main?.scrollTop || 0 };
    const next = this.update(scope, { ...row, text: row.text.slice(0, start) + row.text.slice(end), textAttachments: [...row.textAttachments, attachment] });
    next.selections.main = { start, end: start, scrollTop: 0 };
    this.transforms.set(scope, { before, after: next.revision });
  }
  restore(scope: string, id: string): void {
    const row = this.ensure(scope), block = row.textAttachments.find(x => x.id === id);
    if (!block) return;
    const before = { ...row, ...copyContent(row), selections: { ...row.selections } }, selection = row.selections.main;
    const start = Math.min(row.text.length, selection?.start ?? row.text.length), end = Math.min(row.text.length, selection?.end ?? start);
    const next = this.update(scope, { ...row, text: row.text.slice(0, start) + block.content + row.text.slice(end), textAttachments: row.textAttachments.filter(x => x.id !== id) });
    next.keepLongText = true; next.activeBlock = 'main';
    next.selections.main = { start: start + block.content.length, end: start + block.content.length, scrollTop: selection?.scrollTop || 0 };
    this.transforms.set(scope, { before, after: next.revision });
  }
  canUndoTransform(scope: string): boolean { const txn = this.transforms.get(scope); return !!txn && txn.after === this.entries.get(scope)?.revision; }
  undoTransform(scope: string): boolean {
    const txn = this.transforms.get(scope); if (!txn || !this.canUndoTransform(scope)) return false;
    const row = this.update(scope, txn.before, false);
    row.selections = txn.before.selections; row.keepLongText = true; row.activeBlock = txn.before.activeBlock;
    this.transforms.delete(scope); return true;
  }
  delete(scope: string): void { this.entries.delete(scope); this.histories.delete(scope); this.transforms.delete(scope); this.changed(); }
  setReview(scope: string, review: ReviewSelection): void { const row = this.ensure(scope); row.review = structuredClone(review); row.revision = this.version + 1; this.changed(); }
  addReference(scope: string, id: string, content: string): void {
    const row = this.ensure(scope); row.references = [...row.references.filter(item => item.id !== id), { id, content }].slice(-100);
    row.revision = this.version + 1; this.changed();
  }
  clear(): void { this.entries.clear(); this.histories.clear(); this.transforms.clear(); this.changed(); }
}
export const composerDrafts = new ComposerDrafts();

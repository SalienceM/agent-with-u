import { documentKey, type DocumentBuffer, type DocumentClient, type DocumentStore } from './documentStore';
import type { DiskVersion, WorkspaceIdentity } from './sessionWorkbench';
import { documentRelativePath, sameDiskVersion, sameWorkspace } from './workspaceDocuments';
import type { LanguagePosition, LanguageRange, LanguageRecord } from './workspaceLanguages';
import { uuid } from './uuid';

// CodeMirror offsets count a line separator once; disk buffers retain their original EOL.
export const languageEditorText = (text: string): string => text.replace(/\r\n?/g, '\n');

export function languageOffset(text: string, p: LanguagePosition): number {
  if (!p || !Number.isSafeInteger(p.line) || !Number.isSafeInteger(p.character) || p.line < 0 || p.character < 0) throw new Error('语义位置无效');
  let from = 0;
  for (let line = 0; line < p.line; line++) { const next = text.indexOf('\n', from); if (next < 0) throw new Error('语义位置越界'); from = next + 1; }
  const end = text.indexOf('\n', from), to = end < 0 ? text.length : end > from && text[end - 1] === '\r' ? end - 1 : end;
  if (p.character > to - from) throw new Error('语义位置越界');
  const at = from + p.character;
  if (at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] || '')) throw new Error('语义位置拆分 Unicode 字符');
  return at;
}
export function languagePosition(text: string, offset: number): LanguagePosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('编辑器位置无效');
  const prefix = text.slice(0, offset); return { line: prefix.split('\n').length - 1, character: offset - prefix.lastIndexOf('\n') - 1 };
}
export function languageRelative(workspace: WorkspaceIdentity, uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.host && parsed.host !== 'localhost' || parsed.search || parsed.hash) throw new Error('语义目标不在当前工作区');
  let file = decodeURIComponent(parsed.pathname), root = workspace.workingDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (/^[a-z]:\//i.test(root)) { file = file.replace(/^\//, ''); file = file.toLowerCase(); root = root.toLowerCase(); }
  if (!file.startsWith(root + '/')) throw new Error('语义目标不在当前工作区');
  return documentRelativePath(file.slice(root.length + 1));
}
export interface LanguageTextEdit { range: LanguageRange; newText: string }
export function applyLanguageTextEdits(text: string, input: unknown): string {
  if (!Array.isArray(input) || input.length > 4096) throw new Error('语言编辑超过上限');
  const edits = input.map((e: LanguageTextEdit) => {
    if (!e || typeof e.newText !== 'string' || e.newText.length > 2 * 1024 * 1024 || !e.range) throw new Error('语言编辑无效');
    const from = languageOffset(text, e.range.start), to = languageOffset(text, e.range.end);
    if (from > to) throw new Error('语言编辑区间倒置');
    return { from, to, text: e.newText };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < edits.length; i++) if (edits[i].from < edits[i - 1].to || edits[i].from === edits[i - 1].from) throw new Error('语言编辑区间重叠');
  let result = '', end = 0;
  for (const edit of edits) { result += text.slice(end, edit.from) + edit.text; end = edit.to; if (result.length > 2 * 1024 * 1024) throw new Error('格式化结果超过上限'); }
  result += text.slice(end); if (result.length > 2 * 1024 * 1024) throw new Error('格式化结果超过上限');
  return result;
}
export interface LanguageEditFile { key: string; path: string; lifecycleId: string; revision: number; before: string; after: string; version: DiskVersion }
export interface LanguageEditPlan { service: LanguageRecord; files: LanguageEditFile[] }
export async function prepareLanguageEdit(service: LanguageRecord, value: any, client: DocumentClient, store: DocumentStore,
  expected: Readonly<DocumentBuffer>[]): Promise<LanguageEditPlan> {
  if (!sameWorkspace(service.workspace, client.identity) || client.source === 'local-copy' || !value || typeof value !== 'object'
    || Object.keys(value).some(k => !['changes', 'documentChanges', 'changeAnnotations'].includes(k))) throw new Error('重构计划无效');
  if (value.changes && value.documentChanges) throw new Error('重构计划重复声明编辑');
  const source = value.documentChanges ?? Object.entries(value.changes || {}).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits }));
  if (!Array.isArray(source) || !source.length || source.length > 32) throw new Error('重构目标超过上限或没有修改');
  const seen = new Set<string>();
  // 所有路径与资源操作先整体验证，再读取任何新文件。
  const targets = source.map((row: any) => {
    if (row.kind || !row.textDocument || typeof row.textDocument.uri !== 'string' || !Array.isArray(row.edits)) throw new Error('不支持创建、删除或移动文件；整份计划已拒绝');
    const path = languageRelative(service.workspace, row.textDocument.uri);
    const key = documentKey({ source: 'executor', workspace: service.workspace, relativePath: path });
    if (seen.has(key)) throw new Error('重构目标重复'); seen.add(key);
    const version = row.textDocument.version;
    if (version != null) {
      const known = service.documents.find(doc => documentKey({ source: 'executor', workspace: service.workspace, relativePath: doc.relativePath }) === key);
      if (!known || version !== known.protocolVersion) throw new Error('重构协议版本已变化');
    }
    return { path, key, edits: row.edits };
  });
  const files: LanguageEditFile[] = [];
  for (const target of targets) {
    const doc = await store.open(client, target.path);
    const old = expected.find(d => d.key === doc.key);
    if (old && (old.revision !== doc.revision || old.lifecycleId !== doc.lifecycleId)) throw new Error('重构源缓冲区已变化');
    if (!doc.read?.editable || !doc.read.version || !doc.read.complete || doc.disk || doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '')) throw new Error('重构目标只读、冲突或保存待核对');
    files.push({ key: doc.key, path: doc.identity.relativePath, lifecycleId: doc.lifecycleId, revision: doc.revision,
      before: doc.text, after: applyLanguageTextEdits(doc.text, target.edits), version: doc.read.version });
  }
  return { service, files };
}
export async function validateLanguageEdit(plan: LanguageEditPlan, client: DocumentClient, store: DocumentStore, current: () => boolean) {
  for (const file of plan.files) {
    if (!current()) throw new Error('重构服务或窗口归属已变化');
    const read = await client.read(file.path, uuid());
    if (!sameWorkspace(plan.service.workspace, read.document.workspace) || !sameDiskVersion(file.version, read.version)) throw new Error('磁盘版本已变化，整份重构计划已失效');
  }
  if (!current()) throw new Error('重构服务或窗口归属已变化');
  for (const file of plan.files) {
    const doc = store.get(file.key);
    if (!doc || doc.lifecycleId !== file.lifecycleId || doc.revision !== file.revision || doc.text !== file.before || !sameDiskVersion(file.version, doc.read?.version || null)) throw new Error('缓冲区版本已变化，整份重构计划已失效');
  }
  // 这里不持久保存；外部文件仍可能在最终核对后变化，真正保存再次走字节基线比较。
}

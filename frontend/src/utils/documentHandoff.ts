import { documentStore, documentKey, type DocumentBuffer, type DocumentClient, type RecoverableDraft } from './documentStore';
import { sameDiskVersion } from './workspaceDocuments';
import { serializeEditorDocument, restoreEditorDocument, type EditorDocumentState, type SerializedEditorDocument } from './editorDocumentState';
import { history } from '@codemirror/commands';

export function exportDocumentHandoff(doc: Readonly<DocumentBuffer>): RecoverableDraft {
  if (doc.loading || doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '')) throw new Error('文件读写仍在进行或结果未知，请先核对原操作。');
  if (!doc.read?.editable || !doc.read.version) throw new Error('文件没有可交接的完整基线');
  const draft: RecoverableDraft = { format: 1, identity: doc.identity, text: doc.text, baseText: doc.baseText, revision: doc.revision,
    baseVersion: doc.read.version, encoding: doc.read.encoding, bom: doc.read.bom, eol: doc.read.eol };
  const editor = doc.editor as EditorDocumentState | undefined;
  if (editor) {
    if (editor.state.doc.toString() !== doc.text) throw new Error('文件缓冲区与编辑历史尚未同步');
    draft.editor = serializeEditorDocument(editor);
  }
  return draft;
}

export async function importDocumentHandoff(client: DocumentClient, draft: RecoverableDraft, current: () => boolean): Promise<string> {
  // 先重新核对来源/磁盘，再恢复草稿；不自动写入磁盘或执行重命名。
  if (!draft || draft.pendingSave) throw new Error('交接不能携带未核对的保存操作');
  const expectedKey = documentKey({ workspace: client.identity, source: client.source || 'executor', relativePath: draft.identity?.relativePath });
  if (expectedKey !== documentKey(draft.identity)) throw new Error('交接文件来源不匹配');
  const doc = await documentStore.open(client, draft.identity.relativePath);
  if (!current()) throw new Error('交接目标身份已变化');
  let editor: EditorDocumentState | undefined;
  if (draft.editor) {
    editor = restoreEditorDocument(draft.editor as SerializedEditorDocument, [history()]);
    if (editor.state.doc.toString() !== draft.text) throw new Error('编辑历史与草稿不匹配，未确认交接');
  }
  if (doc.dirty) {
    if (doc.text !== draft.text || doc.baseText !== draft.baseText || !sameDiskVersion(doc.read?.version || null, draft.baseVersion)) throw new Error('目标窗口有不同的未保存草稿，请先保留或导出它。');
  } else documentStore.restore(doc.key, draft);
  if (editor) documentStore.editorState(doc.key, editor);
  return doc.key;
}

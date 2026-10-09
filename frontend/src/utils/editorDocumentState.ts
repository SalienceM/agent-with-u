import { EditorState, type Extension } from '@codemirror/state';
import { historyField } from '@codemirror/commands';

export interface EditorDocumentState {
  state: EditorState; scrollTop: number; scrollLeft: number;
}
export interface SerializedEditorDocument {
  format: 1; state: Record<string, unknown>; scrollTop: number; scrollLeft: number;
}
const fields = { history: historyField };

export function serializeEditorDocument(value: EditorDocumentState): SerializedEditorDocument {
  const result: SerializedEditorDocument = { format: 1, state: value.state.toJSON(fields),
    scrollTop: value.scrollTop, scrollLeft: value.scrollLeft };
  if (JSON.stringify(result).length > 16 * 1024 * 1024) throw new Error('编辑历史超过交接上限，请先保存或导出草稿');
  return result;
}

export function restoreEditorDocument(value: SerializedEditorDocument, extensions: Extension): EditorDocumentState {
  if (value.format !== 1 || JSON.stringify(value).length > 16 * 1024 * 1024
      || ![value.scrollTop, value.scrollLeft].every(n => Number.isFinite(n) && n >= 0)) {
    throw new Error('不支持或损坏的编辑状态');
  }
  return { state: EditorState.fromJSON(value.state, { extensions }, fields),
    scrollTop: value.scrollTop, scrollLeft: value.scrollLeft };
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorState, EditorSelection } = require('@codemirror/state');
const { history, undo, redo, undoDepth, redoDepth } = require('@codemirror/commands');
const { serializeEditorDocument, restoreEditorDocument } = require('../../.home-test-dist/utils/editorDocumentState.js');

test('tab state and serialized handoff retain cursor, scroll and undo/redo', () => {
  let state = EditorState.create({ doc: 'original', extensions: [history()] });
  state = state.update({ changes: { from: state.doc.length, insert: ' edit' },
    selection: EditorSelection.cursor(13) }).state;
  const saved = serializeEditorDocument({ state, scrollTop: 123, scrollLeft: 45 });
  const moved = restoreEditorDocument(JSON.parse(JSON.stringify(saved)), [history()]);
  state = moved.state;
  assert.equal(state.doc.toString(), 'original edit');
  assert.equal(state.selection.main.head, 13);
  assert.equal(moved.scrollTop, 123);
  assert.equal(moved.scrollLeft, 45);
  assert.equal(undoDepth(state), 1);
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), 'original');
  const back = restoreEditorDocument(serializeEditorDocument({ state, scrollTop: 0, scrollLeft: 0 }), [history()]);
  state = back.state;
  assert.equal(redoDepth(state), 1);
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), 'original edit');
});

test('two editor documents never share history or selection', () => {
  const a = EditorState.create({ doc: 'a', extensions: [history()] });
  const b = EditorState.create({ doc: 'b', extensions: [history()] });
  const edited = a.update({ changes: { from: 1, insert: '2' } }).state;
  assert.equal(undoDepth(edited), 1);
  assert.equal(undoDepth(b), 0);
  assert.equal(b.doc.toString(), 'b');
});

test('unsupported or malformed handoff is rejected instead of silently losing undo', () => {
  const state = EditorState.create({ doc: 'a', extensions: [history()] });
  const valid = serializeEditorDocument({ state, scrollTop: 0, scrollLeft: 0 });
  assert.throws(() => restoreEditorDocument({ ...valid, format: 2 }, [history()]));
  assert.throws(() => restoreEditorDocument({ ...valid, scrollTop: -1 }, [history()]));
  assert.throws(() => restoreEditorDocument({ ...valid, state: { doc: null } }, [history()]));
});

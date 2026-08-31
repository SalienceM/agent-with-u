const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterScratchEntries,
  normalizeScratchEntries,
  scratchEntryPreview,
  scratchTodoStats,
  sortScratchEntries,
} = require('../../.home-test-dist/utils/scratchPad.js');

test('legacy scratch notes migrate without losing text or image blocks', () => {
  const [entry] = normalizeScratchEntries([{
    id: 'legacy-note', createdAt: 10, updatedAt: 20,
    blocks: [
      { type: 'text', id: 'text', content: '保留旧正文' },
      { type: 'image', id: 'image', src: 'data:image/png;base64,AA==' },
    ],
  }], 100);

  assert.equal(entry.id, 'legacy-note');
  assert.equal(entry.title, '');
  assert.equal(entry.color, 'yellow');
  assert.equal(entry.pinned, false);
  assert.equal(entry.archived, false);
  assert.deepEqual(entry.todos, []);
  assert.equal(entry.blocks[0].content, '保留旧正文');
  assert.equal(entry.blocks[1].src, 'data:image/png;base64,AA==');
});

test('checklist state is normalized and summarized', () => {
  const [entry] = normalizeScratchEntries([{
    id: 'todo-note', title: '发版', color: 'mint', pinned: true,
    todos: [
      { id: 'one', text: '构建', done: true, createdAt: 1 },
      { id: 'two', text: '上传', completed: true },
      { id: 'three', text: '验证', done: false },
    ],
    blocks: [],
  }], 100);

  assert.equal(entry.color, 'mint');
  assert.equal(entry.todos[1].done, true);
  assert.deepEqual(scratchTodoStats(entry), { total: 3, done: 2, pending: 1 });
  assert.equal(scratchEntryPreview(entry), '发版');
  assert.equal(entry.blocks.length, 1);
  assert.equal(entry.blocks[0].type, 'text');
});

test('search covers title, body and todo text while respecting the archive view', () => {
  const entries = normalizeScratchEntries([
    { id: 'title', title: '周末采购', blocks: [{ type: 'text', id: 'a', content: '' }] },
    { id: 'body', blocks: [{ type: 'text', id: 'b', content: '代理排查记录' }] },
    { id: 'todo', todos: [{ id: 't', text: '上传安装包' }], blocks: [] },
    { id: 'archive', archived: true, title: '旧计划', blocks: [] },
  ], 100);

  assert.deepEqual(filterScratchEntries(entries, '采购', false).map((entry) => entry.id), ['title']);
  assert.deepEqual(filterScratchEntries(entries, '代理 记录', false).map((entry) => entry.id), ['body']);
  assert.deepEqual(filterScratchEntries(entries, '安装包', false).map((entry) => entry.id), ['todo']);
  assert.deepEqual(filterScratchEntries(entries, '', true).map((entry) => entry.id), ['archive']);
});

test('pinned notes stay above recently edited ordinary notes', () => {
  const entries = normalizeScratchEntries([
    { id: 'recent', updatedAt: 300, blocks: [] },
    { id: 'pinned-old', updatedAt: 100, pinned: true, blocks: [] },
    { id: 'pinned-new', updatedAt: 200, pinned: true, blocks: [] },
  ], 500);

  assert.deepEqual(sortScratchEntries(entries).map((entry) => entry.id), [
    'pinned-new', 'pinned-old', 'recent',
  ]);
});

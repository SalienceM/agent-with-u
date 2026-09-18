const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detachedUrl, openDetachedWindow } = require('../../.home-test-dist/utils/detachedWindow.js');
const { manualReferences, normalizeManualHistory, removeManualReferences, skillReferenceLabel } = require('../../.home-test-dist/utils/skillManual.js');
const { detectPromptReference } = require('../../.home-test-dist/utils/promptReferences.js');

test('manual reference namespace is opt-in for Thoughts, keeps other composers unchanged', () => {
  assert.equal(detectPromptReference('@SKILL', 6, true).kind, 'skill');
  assert.equal(detectPromptReference('@SKILL', 6).kind, 'file');
  assert.equal(detectPromptReference('@SKILL:open', 11, true).query, 'open');
  assert.deepEqual(manualReferences('@SKILL:demo 怎么用 @skill:demo'), ['demo']);
  assert.deepEqual(manualReferences('@SKILL:../secret'), []);
});
test('parent attention uses metadata display names, never exposes internal IDs as labels', () => {
  const id = 'repo.0123456789abcdef';
  assert.equal(skillReferenceLabel(id, []), '仓库手册');
  assert.equal(skillReferenceLabel(id, [{ name: id, displayName: 'OpenSpec' }]), 'OpenSpec');
  assert.equal(skillReferenceLabel('child', []), 'child');
});
test('removing Skill references keeps the question and never leaves hidden execution references', () => {
  assert.equal(removeManualReferences('@SKILL:repo.0123456789abcdef [OpenSpec] 这个项目怎么用', ['repo.0123456789abcdef']), '这个项目怎么用');
  assert.equal(removeManualReferences('@SKILL:"我的规范" 怎么用 @SKILL:other', ['我的规范']), '怎么用 @SKILL:other');
});
test('old reference histories join Session without changing question, while library focus is preserved', () => {
  const original = { contextKey: 'skills:demo', contextKind: 'skills', contextLabel: 'Skill 手册', question: '@SKILL:demo q' };
  assert.deepEqual(normalizeManualHistory(original), { ...original, contextKey: 'session', contextKind: 'session', contextLabel: '', contextDetail: '' });
  assert.equal(original.contextKey, 'skills:demo');
  const panel = { ...original, contextKey: 'panel:library' };
  assert.equal(normalizeManualHistory(panel), panel);
});
test('detached routes are mutually exclusive and keep deployment prefix', () => {
  global.location = { href: 'https://fixture.local/awu/?thoughts=1&sessionId=old#section' };
  const url = detachedUrl('skillManual', { skillName: 'demo', skillExecKey: 'relay:user:node' });
  assert.equal(url.includes('thoughts='), false);
  assert.equal(url.includes('sessionId='), false);
  assert.match(url, /^\/awu\/\?skillManual=1/);
  delete global.location;
});
test('browser opens synchronously without native import, blocking rejects without closing the source', async () => {
  let opened = false;
  global.window = { open: () => { opened = true; return { focus() {} }; } };
  const promise = openDetachedWindow({ label: 'test', url: '/?scratchpad=1', width: 560, height: 800 });
  assert.equal(opened, true);
  await promise;
  global.window.open = () => null;
  await assert.rejects(openDetachedWindow({ label: 'blocked', url: '/', width: 1, height: 1 }), /原面板已保留/);
  delete global.window;
});

test('native creation waits for acknowledgement and restores existing windows; no browser fallback on errors', async t => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  let fail = false, existing = null, created = 0, browserOpened = 0;
  const operations = [];
  class WindowMock {
    static async getByLabel() { return existing; }
    constructor() { created++; }
    async once(event, handler) {
      if (event === (fail ? 'tauri://error' : 'tauri://created')) queueMicrotask(() => handler({ payload: 'permission denied' }));
      return () => {};
    }
    async show() { operations.push('show'); }
    async unminimize() { operations.push('unminimize'); }
    async setFocus() { operations.push('focus'); }
  }
  Module._load = function(request, ...args) {
    return request === '@tauri-apps/api/webviewWindow' ? { WebviewWindow: WindowMock } : originalLoad.call(this, request, ...args);
  };
  global.window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout, open: () => browserOpened++ };
  t.after(() => { Module._load = originalLoad; delete global.window; });
  const options = { label: 'native', url: '/', width: 500, height: 600 };
  await openDetachedWindow(options);
  assert.equal(created, 1);
  assert.deepEqual(operations, ['show', 'unminimize', 'focus']);
  existing = new WindowMock();
  const prior = created;
  await openDetachedWindow(options);
  assert.equal(created, prior);
  existing = null; fail = true;
  await assert.rejects(openDetachedWindow(options), /permission denied/);
  assert.equal(browserOpened, 0);
});

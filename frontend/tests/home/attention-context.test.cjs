const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ATTENTION_CONTENT_LIMIT,
  buildFileAttentionContext,
  serializeAttentionContent,
} = require('../../.home-test-dist/utils/attentionContext.js');

test('structured attention strips binary payloads', () => {
  const text = serializeAttentionContent({
    title: 'sheet',
    dataUrl: 'data:image/png;base64,very-secret-binary',
    nested: { bytes: [1, 2, 3], value: 'kept' },
  });
  assert.match(text, /sheet/);
  assert.match(text, /kept/);
  assert.doesNotMatch(text, /very-secret-binary/);
  assert.doesNotMatch(text, /"bytes"/);
});

test('file attention has stable focus key and bounded content', () => {
  const context = buildFileAttentionContext({
    rel: 'src\\App.tsx', name: 'App.tsx', source: 'remote', text: 'x'.repeat(80_000),
  }, { sessionId: 's1', workingDir: 'C:/repo' });

  assert.equal(context.key, 'file:remote:src/App.tsx');
  assert.equal(context.kind, 'file');
  assert.equal(context.sessionId, 's1');
  assert.ok(context.content.length <= ATTENTION_CONTENT_LIMIT + 30);
  assert.match(context.content, /界面快照已截断/);
});

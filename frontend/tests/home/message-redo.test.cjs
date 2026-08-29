const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMessageRedoPayload,
} = require('../../.home-test-dist/utils/messageRedo.js');

test('redo preserves a user message payload while assigning fresh attachment ids', () => {
  const source = {
    role: 'user',
    content: '请继续检查这个问题',
    images: [{ id: 'old-image', base64: 'YWJj', mime_type: 'image/png', size: 3 }],
    textAttachments: [{ id: 'old-text', name: 'note.txt', content: 'detail', size: 6, source: 'file' }],
  };
  let id = 0;
  const payload = buildMessageRedoPayload(source, () => `redo-${++id}`);

  assert.equal(payload.content, source.content);
  assert.deepEqual(payload.images, [{ ...source.images[0], id: 'redo-1' }]);
  assert.deepEqual(payload.textAttachments, [{ ...source.textAttachments[0], id: 'redo-2' }]);
  assert.equal(source.images[0].id, 'old-image');
  assert.equal(source.textAttachments[0].id, 'old-text');
});

test('redo is available only for non-empty user messages', () => {
  assert.equal(buildMessageRedoPayload({ role: 'assistant', content: 'answer' }), null);
  assert.equal(buildMessageRedoPayload({ role: 'user', content: '   ' }), null);
  assert.ok(buildMessageRedoPayload({
    role: 'user',
    content: '',
    images: [{ id: 'image', base64: 'YWJj', mime_type: 'image/png', size: 3 }],
  }, () => 'new-image'));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasVisibleMessagePayload,
  shouldKeepChatMessage,
} = require('../../.home-test-dist/utils/chatMessageVisibility.js');

test('finalized metadata-only assistant messages are removed', () => {
  const empty = {
    role: 'assistant',
    content: '   ',
    streaming: false,
    elapsed: 4400,
    usage: { inputTokens: 10 },
    contentBlocks: [{ type: 'text', text: '' }],
  };

  assert.equal(hasVisibleMessagePayload(empty), false);
  assert.equal(shouldKeepChatMessage(empty), false);
});

test('waiting, tool-only, thinking-only and attachment-only messages remain visible', () => {
  assert.equal(shouldKeepChatMessage({
    role: 'assistant', content: '', streaming: true,
  }), true);
  assert.equal(shouldKeepChatMessage({
    role: 'assistant', content: '', streaming: false,
    toolCalls: [{ name: 'shell' }],
  }), true);
  assert.equal(shouldKeepChatMessage({
    role: 'assistant', content: '', streaming: false,
    thinking: 'checking',
  }), true);
  assert.equal(shouldKeepChatMessage({
    role: 'assistant', content: '', streaming: false,
    images: [{ id: 'image' }],
  }), true);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectPromptReference,
  replacePromptReference,
} = require('../../.home-test-dist/utils/promptReferences.js');

test('prompt references distinguish files and SESSION references at the caret', () => {
  assert.deepEqual(detectPromptReference('检查 @src/api', 11), {
    kind: 'file', start: 3, cursor: 11, query: 'src/api', expandSessionPrefix: false,
  });
  assert.deepEqual(detectPromptReference('基于 @SE', 6), {
    kind: 'session', start: 3, cursor: 6, query: '', expandSessionPrefix: true,
  });
  assert.deepEqual(detectPromptReference('基于 @SESSION:abc', 15), {
    kind: 'session', start: 3, cursor: 15, query: 'abc', expandSessionPrefix: false,
  });
});

test('prompt references stop at whitespace and replace only the active token', () => {
  assert.equal(detectPromptReference('邮件 a@b.com 已结束'), null);
  const trigger = detectPromptReference('比较 @SE 后续', 6);
  assert.deepEqual(replacePromptReference('比较 @SE 后续', trigger, '@SESSION:session-1 '), {
    value: '比较 @SESSION:session-1  后续',
    cursor: 22,
  });
});

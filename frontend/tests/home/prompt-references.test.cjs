const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectPromptReference,
  replacePromptReference,
  formatFileReference,
  fileReferenceLocation,
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

test('directory references keep their level, root and spaces without including contents', () => {
  assert.equal(formatFileReference('src', true), '@src/');
  assert.equal(formatFileReference('src/', true), '@src/');
  assert.equal(formatFileReference('.', true), '@./');
  assert.equal(formatFileReference('需求 文档/子目录', true), '@需求\\ 文档/子目录/');
  assert.equal(formatFileReference('src\\app.ts'), '@src/app.ts');
});

test('typed directory prefixes resolve only their immediate parent listing', () => {
  assert.deepEqual(fileReferenceLocation('src/components/bu'), { directory: 'src/components', query: 'bu' });
  assert.deepEqual(fileReferenceLocation('src\\components\\'), { directory: 'src/components', query: '' });
  assert.deepEqual(fileReferenceLocation('./'), { directory: '.', query: '' });
  assert.deepEqual(fileReferenceLocation('需求\\ 文档/'), { directory: '需求 文档', query: '' });
  assert.deepEqual(fileReferenceLocation('src'), { directory: '.', query: 'src' });
});

test('escaped spaces remain in a file reference but a completed reference closes the picker', () => {
  const token = formatFileReference('需求 文档/子目录', true);
  const text = `检查 ${token}`;
  assert.equal(detectPromptReference(text).query, token.slice(1));
  assert.equal(detectPromptReference(`${text} `), null);
  assert.equal(detectPromptReference('@hello\\\nworld'), null);
  assert.deepEqual(replacePromptReference('检查 @src 后面不变', { start: 3, cursor: 7 }, '@src/ '), {
    value: '检查 @src/  后面不变', cursor: 9,
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

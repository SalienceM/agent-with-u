const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ATTENTION_CONTENT_LIMIT,
  buildFileAttentionContext,
  buildReviewAttentionContext,
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

test('review text selection becomes the current file attention without fragmenting its thread', async () => {
  const document = {
    format: 'agentwithu.prov', schemaVersion: 1,
    source: { path: 'docs/plan.md', mediaType: 'text/markdown', kind: 'markdown', sha256: 'x', size: 100 },
    review: { id: 'r1', revision: 1, state: 'draft', createdAt: '', updatedAt: '' },
    counters: {}, annotations: [],
  };
  const annotation = {
    id: 'a1', ref: '文1', title: '核心约束', parentId: null, order: 0,
    target: { selector: {
      type: 'text-range', headingPath: ['目标'], blockFingerprint: 'sha256:x',
      exactQuote: '只修改当前文件', startOffset: 2, endOffset: 10,
    } },
    body: { kind: 'question', comment: '这里是否安全？', expected: '', severity: 'normal', blocking: false },
    status: 'open', createdAt: '', updatedAt: '',
  };
  const context = await buildReviewAttentionContext(
    document,
    { kind: 'markdown', text: '# 目标\n只修改当前文件' },
    annotation,
    { sessionId: 's1', workingDir: 'C:/repo', source: 'remote' },
  );

  assert.equal(context.key, 'file:remote:docs/plan.md');
  assert.match(context.detail, /文1.*文字框选/);
  assert.match(context.content, /只修改当前文件/);
  assert.match(context.content, /这里是否安全/);
  assert.equal(context.imageAttachments, undefined);
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

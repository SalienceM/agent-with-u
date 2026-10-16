const test = require('node:test');
const assert = require('node:assert/strict');
const { filePanelGit, filePanelFeedback, filePanelComparison } = require('../../.home-test-dist/utils/filePanelPresentation.js');
const base = { detected: false, available: false, loading: false, ready: false, error: '', branch: '', staged: 0, unstaged: 0 };
test('Git unknown, pending, absent and failed never masquerade as clean', () => {
  assert.equal(filePanelGit(base).state, 'unknown');
  assert.equal(filePanelGit({ ...base, loading: true }).state, 'loading');
  assert.equal(filePanelGit({ ...base, detected: true }).label, '');
  assert.equal(filePanelGit({ ...base, detected: true, available: true }).state, 'unknown');
  assert.equal(filePanelGit({ ...base, detected: true, available: true, ready: true }).detail, '工作区干净');
  assert.equal(filePanelGit({ ...base, detected: true, available: true, ready: true, error: 'failed' }).state, 'error');
});
test('feedback preserves unrelated faults and does not infer compare success', () => {
  const input = { directories: { src: '拒绝读取' }, gitError: 'Git 失败', conflicts: 2, compared: true, offline: true, active: '下载中', messages: [{ id: 'ok', text: '已保存', kind: 'done' }] };
  const rows = filePanelFeedback(input);
  assert.deepEqual(rows.map(row => row.id), ['directory:src', 'git', 'conflicts', 'offline', 'active', 'ok']);
  assert.equal(filePanelFeedback({ ...input, gitError: '' }).some(row => row.id === 'directory:src'), true);
  assert.equal(filePanelFeedback({ ...input, compared: false }).some(row => row.id === 'conflicts'), false);
  assert.match(filePanelComparison(false, { differs: 0, conflict: 0, cloud: 0, localOnly: 0 }), /尚未比对/);
  assert.match(filePanelComparison(true, { differs: 1, conflict: 2, cloud: 3, localOnly: 4 }), /冲突 2/);
});

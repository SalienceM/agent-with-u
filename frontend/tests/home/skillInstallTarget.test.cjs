const { test } = require('node:test');
const assert = require('node:assert/strict');
const { skillInstallTargetLabel } = require('../../.home-test-dist/utils/skillInstallTarget.js');

test('Skill installation distinguishes desktop-local from a browser server connection', () => {
  assert.equal(skillInstallTargetLabel('local', { label: '本机' }, true), '本机执行节点');
  assert.equal(skillInstallTargetLabel('local', { label: '本机' }, false), '直连执行节点（服务器）');
});

test('a default Relay executor is still remote, including when its display name says local', () => {
  assert.equal(skillInstallTargetLabel('relay:user:node-a', { label: '本机' }, true), '远端执行节点 · 本机');
  assert.equal(skillInstallTargetLabel('relay:user:node-b', undefined, false), '远端执行节点 · relay:user:node-b');
});

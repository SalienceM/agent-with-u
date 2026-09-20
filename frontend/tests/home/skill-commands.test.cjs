const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSkillCommand, slashQuery, skillInvocation, suggestedSlashCommand } = require('../../.home-test-dist/utils/skillCommands.js');

test('reply commands can be drafted verbatim, without treating paths, shell or batches as one command', () => {
  for (const text of ['/opsx-apply persist-login-debug-preference', '/help', '/skill demo 检查这里',
    '/review-plan "x y" & <file>', '/My-review change-1', '/review-plan\t中文参数']) {
    assert.equal(suggestedSlashCommand(text), text);
  }
  assert.equal(suggestedSlashCommand('\n/opsx-init\n'), '/opsx-init');
  for (const text of ['/opsx-init\n/opsx-apply x', '/opsx-init\r/opsx-apply x', '/', '//example.com',
    '/tmp/config.yaml', 'C:/project', './run.sh', 'openspec init', '$ /opsx-init', '执行 /opsx-init',
    '/opsx-init\u202ehidden', '/opsx-init\u0000hidden', '/opsx-init\u2028another', '/x ' + 'a'.repeat(4000)]) {
    assert.equal(suggestedSlashCommand(text), null, text);
  }
});

test('all non-app slash commands use the executor registry, even before menu discovery', () => {
  for (const text of ['/skill demo args', ' /OPSX-APPLY id', '/opsx:apply id', '/native /model', '/skills', '/my-review path']) assert.equal(isSkillCommand(text), true);
  for (const text of ['/clear', '/new', '/init', '/cost', '/commit', '/git status', '/', 'tell me about /skill demo']) assert.equal(isSkillCommand(text), false);
});
test('autocomplete supports Skill names without consuming their arguments', () => {
  assert.equal(slashQuery('/'), '/');
  assert.equal(slashQuery('/skill '), '/skill ');
  assert.equal(slashQuery('/skill de'), '/skill de');
  for (const text of ['/skill demo ', '/opsx-apply id', '/skill demo id', '/skill demo\narg']) assert.equal(slashQuery(text), null);
});
test('selection forwards exact text and a digest, never interpolates shell arguments', () => {
  const commands = [{name:'/skill demo', skillName:'demo', digest:'sha'}, {name:'/opsx-apply', skillName:'openspec-apply-change', digest:'other'}];
  assert.deepEqual(skillInvocation('/skill demo "x y"; $(nope)\nnext', commands), {name:'demo', arguments:'"x y"; $(nope)\nnext', digest:'sha'});
  assert.equal(skillInvocation('/skill demonstration', commands), undefined);
  assert.equal(skillInvocation('/clear', commands), undefined);
  assert.deepEqual(skillInvocation('/opsx-apply abc', commands), {name:'openspec-apply-change', arguments:'abc', digest:'other'});
});

test('project entries use the same explicit route without pretending to be installed skills', () => {
  const commands = [{name:'/opsx-init', skillName:'openspec:init', digest:'v1', kind:'project'}];
  assert.equal(isSkillCommand('/opsx-init'), true);
  assert.equal(isSkillCommand('/opsx-version'), true);
  assert.equal(isSkillCommand('/init'), false);
  assert.deepEqual(skillInvocation('/opsx-init', commands), {name:'openspec:init', arguments:'', digest:'v1'});
  assert.equal(skillInvocation('/opsx-initialize', commands), undefined);
});

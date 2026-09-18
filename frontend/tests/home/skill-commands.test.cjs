const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSkillCommand, slashQuery, skillInvocation } = require('../../.home-test-dist/utils/skillCommands.js');

test('only explicit Skill/OpenSpec/native namespaces use the Skill route', () => {
  for (const text of ['/skill demo args', ' /OPSX-APPLY id', '/opsx:apply id', '/native /model']) assert.equal(isSkillCommand(text), true);
  for (const text of ['/clear', '/new', '/skills', 'tell me about /skill demo']) assert.equal(isSkillCommand(text), false);
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

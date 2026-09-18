const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupSkills, selectSkillGroup } = require('../../.home-test-dist/utils/skillGroups.js');
const { manualReferences, skillReferenceText } = require('../../.home-test-dist/utils/skillManual.js');

test('parent controls select all current members and child-only leaves other groups intact', () => {
  const parent = { id: 'repo.0123456789abcdef', name: 'OpenSpec', repository: 'example/OpenSpec', revision: 'r1' };
  const groups = groupSkills([{ name: 'apply', parent }, { name: 'verify', parent }, { name: 'single' }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].children.map(s => s.name), ['apply', 'verify']);
  assert.deepEqual(selectSkillGroup(['unrelated', 'apply'], ['apply', 'verify'], true), ['unrelated', 'apply', 'verify']);
  assert.deepEqual(selectSkillGroup(['unrelated', 'apply', 'verify'], ['apply', 'verify'], true, 'verify'), ['unrelated', 'verify']);
  assert.deepEqual(selectSkillGroup(['unrelated', 'apply'], ['apply', 'verify'], false), ['unrelated']);
});

test('parent references keep stable IDs with readable names and support explicit quoted aliases', () => {
  const entry = { name: 'repo.0123456789abcdef', displayName: '项目规范 工作流', kind: 'parent', hasManual: false };
  const text = skillReferenceText(entry);
  assert.match(text, /项目规范 工作流/);
  assert.deepEqual(manualReferences(text), [entry.name]);
  assert.deepEqual(manualReferences('@SKILL:"项目规范 工作流"'), ['项目规范 工作流']);
  assert.deepEqual(manualReferences('@SKILL:demo/path'), []);
  assert.deepEqual(manualReferences('@SKILL:repo.0123456789abcdef/../../secret'), []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { assemblyClosure, assemblyIntent } = require('../../.home-test-dist/utils/aimeinPlay.js');

test('assembly retains shared transitive dependencies once, without mutating the plan', () => {
  const targets = [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a', 'b'] }];
  const before = JSON.stringify(targets);
  assert.deepEqual(assemblyClosure(targets, ['c']), { ids: ['a', 'b', 'c'], errors: [] });
  assert.deepEqual(assemblyClosure(targets, ['c', 'a']).ids, ['a', 'b', 'c']);
  assert.deepEqual(assemblyClosure(targets, []), { ids: [], errors: [] });
  assert.equal(JSON.stringify(targets), before);
});

test('missing, cyclic and truncated dependencies remain blocking instead of fabricating a recipe', () => {
  assert.match(assemblyClosure([{ id: 'a', dependsOn: ['missing'] }], ['a']).errors[0], /缺少依赖详情/);
  assert.match(assemblyClosure([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], ['a']).errors[0], /形成循环/);
  assert.match(assemblyClosure([], ['old-plan']).errors[0], /缺少依赖详情/);
});

test('assembly request preserves origin, dependency and acceptance and never claims execution', () => {
  const text = assemblyIntent(8, '2:3', [{ id: 'b', title: '离线重开', acceptance: '不得丢失已保存内容', dependsOn: ['a'] }], ['b'], ['a', 'b'], '希望断网后还能编辑');
  for (const value of ['#8 / 2:3', '目标：b', '依赖：a', '不得丢失已保存内容', '断网后还能编辑', '不修改已冻结阶段']) assert.ok(text.includes(value));
});

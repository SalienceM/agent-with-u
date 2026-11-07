const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseScanRules, scanAllows } = require('../../.home-test-dist/utils/syncScanRules');
const fixtures = require('../../../tests/fixtures/sync_scan_rules.json');

test('scan rules match the shared Python/Rust fixtures, including traversal decisions', () => {
  for (const { rules, cases } of fixtures) {
    assert.deepEqual(parseScanRules(rules.prefixes.join('\n'), rules.excludes.join('\n')), rules);
    for (const [path, dir, expected] of cases) assert.equal(scanAllows(rules, path, dir), expected, path);
  }
});
test('bounded rule parser accepts comments and Windows separators but rejects unsupported syntax', () => {
  assert.deepEqual(parseScanRules('# comment\r\n ./src\\ \r\nsrc/', '# skip\n*.tmp'),
    { version: 1, prefixes: ['src/'], excludes: ['*.tmp'] });
  for (const path of ['../x', '/root', 'C:\\data', 'a//b', 'a/../b', 'src*', '!x', 'a[bc]']) {
    assert.throws(() => parseScanRules(path, ''), path);
  }
  for (const pattern of ['!', '/', 'a/**b', '../*', '*.[]', 'a/{b,c}']) assert.throws(() => parseScanRules('', pattern));
  assert.throws(() => parseScanRules(Array(129).fill('x').join('\n'), ''));
});

test('repeated wildcard rules have bounded matching cost without regex backtracking', () => {
  const rules = parseScanRules('', '*a'.repeat(120) + 'b');
  assert.equal(scanAllows(rules, 'a'.repeat(255)), true);
});

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from src.backend.sync_scan_rules import ScanRules
from src.backend.bridge_ws import BridgeWS


class ScanRuleTests(unittest.TestCase):
    def test_shared_fixtures(self):
        fixtures = json.loads((Path(__file__).parent / 'fixtures/sync_scan_rules.json').read_text(encoding='utf-8'))
        for fixture in fixtures:
            rules = ScanRules(fixture['rules'])
            self.assertEqual(rules.to_dict(), fixture['rules'])
            for path, directory, expected in fixture['cases']:
                with self.subTest(path=path, rules=rules.to_dict()):
                    self.assertEqual(rules.allows(path, directory), expected)

    def test_invalid_rules_fail_before_any_scan(self):
        bridge = BridgeWS.__new__(BridgeWS)
        for bad in [None, {}, {'version': 2}, {'version': 1, 'prefixes': ['../x'], 'excludes': []},
                    {'version': 1, 'prefixes': [], 'excludes': ['a/**b']},
                    {'version': 1, 'prefixes': ['x'] * 129, 'excludes': []}]:
            with self.subTest(bad=bad), patch('os.walk', side_effect=AssertionError('must not scan')):
                # Null is not a request for default rules on the scoped endpoint.
                result = json.loads(bridge._rpc_syncScopedManifest('missing', False, bad))
                self.assertEqual(result['status'], 'error')

    def test_prunes_directories_before_reading_and_separates_cache_scopes(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._sync_ignore_patterns = Mock(return_value=[])
        with tempfile.TemporaryDirectory(prefix='awu-scope-test-') as temp:
            root = Path(temp)
            for rel in ['src/a.ts', 'src/cache/b', 'src/no.log', 'src2/b', 'data/huge/x', '.git/config']:
                file = root / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'fixture')
            rules = {'version': 1, 'prefixes': ['src/'], 'excludes': ['cache/', '*.log']}
            visited, opened = [], []
            scandir, read = os.scandir, open
            def track_scan(path):
                visited.append(Path(path).relative_to(root).as_posix())
                return scandir(path)
            def track_read(path, *args, **kwargs):
                opened.append(Path(path).relative_to(root).as_posix())
                return read(path, *args, **kwargs)
            with patch('os.scandir', track_scan), patch('builtins.open', track_read):
                result = json.loads(bridge._rpc_syncScopedManifest(temp, False, rules))
            self.assertEqual(set(result['files']), {'src/a.ts'})
            self.assertEqual(result['scanRules'], rules)
            self.assertEqual(set(visited), {'.', 'src'})
            self.assertEqual(opened, ['src/a.ts'])
            other = {'version': 1, 'prefixes': ['data/'], 'excludes': []}
            result = json.loads(bridge._rpc_syncScopedManifest(temp, False, other))
            self.assertEqual(set(result['files']), {'data/huge/x'})
            self.assertEqual(len(bridge._sync_manifest_cache), 2)
            # 包含规则不能解除 Git 元数据保护。
            git = {'version': 1, 'prefixes': ['.git/'], 'excludes': []}
            self.assertEqual(json.loads(bridge._rpc_syncScopedManifest(temp, False, git))['files'], {})
            self.assertEqual(set(json.loads(bridge._rpc_syncScopedManifest(temp, True, git))['files']), {'.git/config'})


if __name__ == '__main__':
    unittest.main()

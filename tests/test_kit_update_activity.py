"""Only temporary metadata and inert history; no production state or installer."""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.kit_activity_json import ActivityJSON
from src.backend.kit_update_activity import records, loop_unsettled
from src.backend.kit_update_journal import JournalError


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.store = SimpleNamespace(_dir=self.folder)

    def write(self, value, name='s.json'):
        path = self.folder / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return path

    def test_large_history_does_not_hide_activity_after_it(self):
        # Match the incident: >16 MiB of completed LOOP text, status after history.
        path = self.write({'sessionId': 's', 'loops': [{'output': 'x' * (24 * 1024 * 1024)}],
                           'startup': {}, 'controlOperation': {}, 'contractRepairs': []})
        before = path.stat()
        data, = records(self.store)
        self.assertFalse(loop_unsettled(data))
        self.assertNotIn('loops', data)
        self.assertLess(len(json.dumps(data)), 256)
        self.assertEqual(before.st_mtime_ns, path.stat().st_mtime_ns)
        self.assertEqual(['s.json'], [p.name for p in self.folder.iterdir()])
        # Recheck unchanged authority without reparsing; stale cached idle is never reused.
        with patch('src.backend.kit_update_activity.ActivityJSON.read', side_effect=AssertionError('cache miss')):
            self.assertEqual([data], list(records(self.store)))
        self.write({'sessionId': 's', 'startup': {'status': 'unknown'}})
        self.assertTrue(loop_unsettled(next(records(self.store))))
        self.write({'sessionId': 's', 'loops': ['inert history'], 'startup': {'status': 'unknown'}})
        self.assertTrue(loop_unsettled(next(records(self.store))))

    def test_kit_logs_and_repair_audit_are_not_activity(self):
        self.write({'sessionId': 's', 'runs': [
            {'id': 'finished', 'status': 'succeeded', 'stdout': 'x' * (17 * 1024 * 1024)},
            {'id': 'live', 'status': 'result_unknown', 'steps': []}],
            'contractRepairs': [{'version': 1, 'status': 'running', 'original': {'text': 'audit'}}]})
        data, = records(self.store)
        self.assertEqual([{'id': 'finished', 'status': 'succeeded'},
                          {'id': 'live', 'status': 'result_unknown'}], data['runs'])
        self.assertEqual([{'version': 1, 'status': 'running'}], data['contractRepairs'])
        self.assertTrue(loop_unsettled(data))

    def test_unconfirmed_activity_still_blocks(self):
        for fields in ({'running': True}, {'startup': {'status': 'unknown'}},
                       {'controlOperation': {'status': 'accepted'}},
                       {'controlOperation': {'requestId': 'missing-status'}},
                       {'contractRepairs': [{'version': 1, 'status': 'unknown'}]},
                       {'executionEnvironment': {'blockers': [{'quiesced': False}]}}):
            with self.subTest(fields=fields):
                self.write({'sessionId': 's', **fields})
                self.assertTrue(loop_unsettled(next(records(self.store))))

    def test_corrupt_history_and_duplicate_authority_fail_closed(self):
        for text in ('{"sessionId":"s","loops":[{"output":"bad\\q"}]}',
                     '{"sessionId":"s","loops":[1,]}',
                     '{"sessionId":"s","loops":[true false]}',
                     '{"sessionId":"s","loops":[1e]}',
                     '{"sessionId":"s","startup":{},"startup":{"status":"unknown"}}',
                     '{"sessionId":"s","loops":[]', '{"sessionId":"s"} trailing'):
            with self.subTest(text=text):
                (self.folder / 's.json').write_text(text, encoding='utf-8')
                with self.assertRaisesRegex(JournalError, '损坏'):
                    list(records(self.store))

    def test_read_limits_and_non_regular_files_have_distinct_errors(self):
        path = self.folder / 's.json'
        with path.open('wb') as stream:
            stream.truncate(65 * 1024 * 1024)
        with self.assertRaisesRegex(JournalError, '64 MiB'):
            list(records(self.store))
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(JournalError, '普通文件'):
            list(records(self.store))

    def test_redirects_fail_closed(self):
        target = self.write({'sessionId': 's'}, 'target.meta.json')
        try:
            (self.folder / 's.json').symlink_to(target)
        except OSError as error:
            self.skipTest(f'symlink privilege unavailable: {error}')
        with self.assertRaisesRegex(JournalError, '重定向'):
            list(records(self.store))

    def test_mutation_during_scan_is_not_cached_as_idle(self):
        path = self.write({'sessionId': 's', 'startup': {}})
        original = ActivityJSON.read
        def changed(reader, fields):
            data = original(reader, fields)
            os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1000000))
            return data
        with patch.object(ActivityJSON, 'read', changed):
            with self.assertRaisesRegex(JournalError, '变化'):
                list(records(self.store))
        self.assertFalse(getattr(self.store, '_update_activity_cache', {}))

    def test_chunk_boundaries_unicode_and_nested_names(self):
        # Force boundaries inside escapes, Unicode, numbers and whitespace.
        class TinyStream(io.StringIO):
            def read(self, size=-1):
                return super().read(min(size, 3))
        for ascii_only in (True, False):
            value = {'ignored': [{'startup': {'status': 'running'}, 'text': '中\\"\n🙂'}],
                     'sessionId': '测试', 'number': -1.23e45, 'startup': {}}
            projected = ActivityJSON(TinyStream(json.dumps(value, ensure_ascii=ascii_only))).read(
                {'sessionId': True, 'number': True, 'startup': True})
            self.assertEqual({k: value[k] for k in ('sessionId', 'number', 'startup')}, projected)
        with self.assertRaises(ValueError):
            ActivityJSON(io.StringIO('{"history":"' + 'x' * 1000 + '"}'), max_chars=100).read({})
        with self.assertRaises(ValueError):
            ActivityJSON(io.StringIO('{"sessionId":"' + 'x' * 1000 + '"}'), limit=100).read({'sessionId': True})

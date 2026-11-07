"""升级、降级准备与随包资源检查；只操作临时文件，不打开用户数据库。"""
import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from src.backend.chat_extras_store import ChatExtras, SeqTask
from src.backend.session_schedule_store import SessionScheduleStore
from src.backend.session_schedule_rules import ScheduleError
from src.package_readiness import check_schedule_timezones, SCHEDULE_TIMEZONES
from scripts.check_session_schedule_package import check_frontend, FRONTEND_MARKERS
from tests.test_session_schedule_rules import config, instant


class ScheduleReleaseTests(unittest.TestCase):
    def test_new_database_is_empty_and_legacy_queue_roundtrips(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = {'id': 'manual-task', 'text': 'old prompt', 'status': 'error', 'error': 'old error'}
            source = root / 'legacy.json'
            source.write_text(json.dumps(legacy), encoding='utf-8')
            original = source.read_bytes()
            store = SessionScheduleStore(root / 'schedule.sqlite3')
            store.initialize()
            self.assertEqual(store.listing(('owner', 'executor'), 's')['items'], [])
            self.assertEqual(store.consume(instant('2026-01-01')), [])
            task = SeqTask.from_dict(json.loads(source.read_text(encoding='utf-8')))
            self.assertIsNone(task.schedule_ref)
            self.assertEqual(task.status, 'error')
            self.assertEqual(task.to_dict()['text'], legacy['text'])
            self.assertEqual(source.read_bytes(), original)
            self.assertFalse(ChatExtras.from_dict({'sessionId': 's', 'seqSchedulerVersion': 1, 'seqAuto': False}).seq_auto)
            self.assertTrue(ChatExtras.from_dict({'sessionId': 's', 'seqAuto': False}).seq_auto)

    def test_newer_schema_rejected_without_rewriting_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'future.sqlite3'
            with closing(sqlite3.connect(path)) as db:
                db.execute('PRAGMA user_version=2')
                db.execute('CREATE TABLE future_data(value TEXT)')
                db.execute("INSERT INTO future_data VALUES ('preserve')")
                db.commit()
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ScheduleError, '较新版本'):
                SessionScheduleStore(path).initialize()
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 2)
                self.assertEqual(db.execute('SELECT value FROM future_data').fetchone()[0], 'preserve')

    def test_disable_is_not_a_rollback_for_running_or_failed_occurrences(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SessionScheduleStore(Path(directory) / 's.sqlite3')
            store.initialize()
            scope, now = ('owner', 'executor'), instant('2026-01-01')
            store.mutate(scope, 's', {'action': 'save', 'id': 'p', 'requestId': 'save', 'expectedRevision': 0,
                                    'config': config({'kind': 'interval', 'anchor': now + 60, 'seconds': 60})}, now)
            store.consume(now + 60)
            first = store.work()[0]
            for state in ['queued', 'claimed', 'running']:
                store.transition(scope, first['id'], state)
            store.consume(now + 120)
            pending = next(row for row in store.work() if row['state'] == 'prepared')
            receipt = store.mutate(scope, 's', {'action': 'enable', 'id': 'p', 'requestId': 'off', 'expectedRevision': 1, 'enabled': False}, now + 120)
            self.assertEqual(receipt['active'][0]['state'], 'running')
            self.assertEqual(store.get(scope, 's', pending['id'], occurrence=True)['state'], 'cancelled')
            store.recover()
            self.assertTrue(store.has_unknown(scope, 's'))
            with self.assertRaises(ScheduleError):
                store.mutate(scope, 's', {'action': 'retry', 'id': first['id'], 'requestId': 'unsafe'}, now)
            store.mutate(scope, 's', {'action': 'resolve', 'id': first['id'], 'requestId': 'checked'}, now)
            store.mutate(scope, 's', {'action': 'cancel', 'id': first['id'], 'requestId': 'cancel'}, now)
            store.consume(now + 999999)
            self.assertFalse(store.has_unknown(scope, 's'))
            self.assertEqual({row['state'] for row in store.listing(scope, 's', history=True)['items']}, {'cancelled'})
            self.assertEqual(store.request(scope, 's', 'save')['status'], 'succeeded')

    def test_timezone_resources_are_real_and_missing_package_does_not_use_os(self):
        self.assertEqual(check_schedule_timezones(), [])
        with patch('src.package_readiness.package_resources.files', side_effect=FileNotFoundError):
            self.assertEqual(len(check_schedule_timezones()), len(SCHEDULE_TIMEZONES))

    def test_docker_timezone_pin_satisfies_application_dependency(self):
        from packaging.requirements import Requirement
        root = Path(__file__).resolve().parents[1]
        application = next(Requirement(line) for line in (root / 'requirements.txt').read_text(encoding='utf-8').splitlines() if line.startswith('tzdata'))
        locked = next(Requirement(line) for line in (root / 'deploy/requirements-docker.txt').read_text(encoding='utf-8').splitlines() if line.startswith('tzdata'))
        version = next(iter(locked.specifier)).version
        self.assertIn(version, application.specifier)

    def test_frontend_artifact_requires_both_documents_and_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets').mkdir()
            (root / 'index.html').write_text('<script type="module" src="./assets/app.js"></script>', encoding='utf-8')
            bundle = root / 'assets/app.js'
            bundle.write_text(FRONTEND_MARKERS['entry'], encoding='utf-8')
            self.assertFalse(check_frontend(root)['ok'])
            bundle.write_text('\n'.join(FRONTEND_MARKERS.values()), encoding='utf-8')
            self.assertTrue(check_frontend(root)['ok'])
            (root / 'index.html').write_text('<html></html>', encoding='utf-8')
            self.assertFalse(check_frontend(root)['ok'])  # 遗留但未被入口引用的 bundle 不算随入口可达。

    def test_docker_context_retains_embedded_documents(self):
        from pathspec import GitIgnoreSpec
        root = Path(__file__).resolve().parents[1]
        # 此处仅核对仓库所用的简单忽略规则；不声称运行 Docker 构建。
        ignored = GitIgnoreSpec.from_lines((root / '.dockerignore').read_text(encoding='utf-8').splitlines())
        recipe = (root / 'deploy/Dockerfile.web').read_text(encoding='utf-8')
        for name in ['docs/session-scheduled-prompts.md', 'docs/session-scheduled-prompts-release.md']:
            self.assertFalse(ignored.match_file(name))
            self.assertIn(name, recipe)
            self.assertTrue((root / name).is_file())


if __name__ == '__main__':
    unittest.main()

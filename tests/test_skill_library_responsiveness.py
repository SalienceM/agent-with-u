"""Skill 库读取/绑定不部署；执行前增量准备不阻塞事件循环或库读取。"""
import asyncio
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_store import SkillStore, MANAGED_MARKER


class SkillLibraryResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.library = root / 'library'
        self.target = root / 'project' / '.agents' / 'skills' / 'large-demo'
        for name, value in [('LIBRARY_DIR', self.library), ('INDEX_FILE', self.library / 'index.json'), ('SECRETS_DIR', root / 'secrets')]:
            patcher = patch(f'src.backend.skill_store.{name}', value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.store = SkillStore()
        self.store.install_standard_files({
            'SKILL.md': b'---\nname: large-demo\ndescription: Large fixture.\n---\nUse {{SKILL_DIR}}/scripts/run.py',
            **{f'assets/{i}.txt': f'asset {i}'.encode() for i in range(300)},
        })

    def deploy(self):
        self.store.deploy_to_directory('large-demo', self.target, '.agents/skills/large-demo')

    def test_unchanged_deployment_reuses_files_and_marker_across_restart(self):
        self.deploy()
        before = {p: p.stat().st_mtime_ns for p in self.target.rglob('*') if p.is_file()}
        # 持久 marker 而非仅内存 cache；重启 Store 也不能重拷整个大包。
        self.store = SkillStore()
        with patch('src.backend.skill_store.shutil.copy2', wraps=shutil.copy2) as copy:
            self.deploy()
            copy.assert_not_called()
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in before})

    def test_changed_source_missing_target_and_stale_managed_file_are_reconciled(self):
        self.deploy()
        (self.target / 'note.txt').write_text('user file')
        (self.library / 'large-demo/assets/1.txt').write_text('changed source')
        (self.library / 'large-demo/assets/2.txt').unlink()
        (self.target / 'assets/3.txt').unlink()
        (self.target / 'assets/4.txt').write_text('modified destination')
        with patch('src.backend.skill_store.shutil.copy2', wraps=shutil.copy2) as copy:
            self.deploy()
            self.assertEqual(copy.call_count, 3)
        self.assertEqual((self.target / 'assets/1.txt').read_text(), 'changed source')
        self.assertFalse((self.target / 'assets/2.txt').exists())
        self.assertEqual((self.target / 'assets/3.txt').read_text(), 'asset 3')
        self.assertEqual((self.target / 'assets/4.txt').read_text(), 'asset 4')
        self.assertEqual((self.target / 'note.txt').read_text(), 'user file')
        self.assertIn('states', json.loads((self.target / MANAGED_MARKER).read_text()))

    async def test_large_copy_leaves_event_loop_and_library_reads_responsive(self):
        started = threading.Event()
        release = threading.Event()
        original_copy = shutil.copy2

        def slow_copy(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise TimeoutError('test did not release copy')
            return original_copy(*args, **kwargs)

        with patch('src.backend.skill_store.shutil.copy2', side_effect=slow_copy):
            task = asyncio.create_task(asyncio.to_thread(self.deploy))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                skills = await asyncio.wait_for(asyncio.to_thread(self.store.list_skills), .5)
                self.assertEqual([s['name'] for s in skills], ['large-demo'])
                bridge = BridgeWS.__new__(BridgeWS)
                bridge._ensure_kit_scheduler = lambda: None
                bridge._authorize_rpc = lambda *_args: None
                self.assertEqual(await asyncio.wait_for(bridge._dispatch('ping', []), .5), 'pong')
                self.assertFalse(task.done())
            finally:
                release.set()
                await task

    async def test_binding_persists_without_deploying_and_apply_runs_off_loop(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(id='test', abilities={}, constraints=None)
        bridge._active_sessions = {'test': session}
        bridge._session_store = SimpleNamespace(save=Mock())
        loop_thread = threading.get_ident()

        def apply(prepared, abilities, *, deploy=True):
            self.assertFalse(deploy)
            self.assertNotEqual(threading.get_ident(), loop_thread)
            prepared.abilities = abilities
            prepared.constraints = 'prepared'

        bridge._apply_session_abilities = apply
        bridge._sync_backend_skills_to_directory = Mock(side_effect=AssertionError('read/bind must not deploy'))
        result = json.loads(await bridge._rpc_updateSessionAbilities('test', '{"skills":["large-demo"],"prompts":[]}'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(session.abilities['skills'], ['large-demo'])
        self.assertEqual(session.constraints, 'prepared')
        bridge._sync_backend_skills_to_directory.assert_not_called()

    async def test_execution_preparation_reconciles_binding_changed_during_copy(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(abilities={'skills': ['old']})
        copies = []
        loop_thread = threading.get_ident()

        def sync(snapshot):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            copies.append(snapshot.abilities['skills'])
            if len(copies) == 1:
                session.abilities = {'skills': ['new']}

        bridge._sync_backend_skills_to_directory = sync
        await bridge._prepare_session_skills(session)
        self.assertEqual(copies, [['old'], ['new']])

    async def test_list_errors_propagate_and_blocking_store_rpc_runs_off_loop(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._ensure_kit_scheduler = lambda: None
        bridge._authorize_rpc = lambda *_args: None
        loop_thread = threading.get_ident()

        def list_skills(_working_dir):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            raise OSError('fixture library unavailable')

        bridge._skill_store = SimpleNamespace(list_skills=list_skills)
        with self.assertRaisesRegex(RuntimeError, 'fixture library unavailable'):
            await bridge._dispatch('listSkills', [''])

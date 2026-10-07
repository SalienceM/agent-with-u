import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from dataclasses import replace

from src.backend.loop_execution_environment import (
    ExecutionIdentity, check_matches, new_check, normalize_check, normalize_environment,
    normalize_history, toolchain_revision,
    discover_openspec, safe_entry, EnvironmentError, entry_hint,
)


class EnvironmentIdentityTests(unittest.TestCase):
    def identity(self):
        return ExecutionIdentity('owner', 'executor', 'session', '.', 'codex', 'app-server', 'prepare', 'read-only')

    def test_each_effective_boundary_separates_evidence(self):
        identity = self.identity()
        check = new_check(identity, status='passed', coverage='native_policy', quiesced=True)
        self.assertTrue(check_matches(check, identity))
        for key, value in {'owner': 'other', 'executor': 'other', 'session_id': 'other',
                           'workspace': '..', 'backend_id': 'other', 'transport': 'exec',
                           'role': 'step1', 'access': 'workspace-write', 'control_mode': 'manual',
                           'config_revision': 'new', 'runner': 'new', 'runner_version': 'new',
                           'toolchain_revision': 'new', 'workflow_revision': 'new'}.items():
            with self.subTest(key=key):
                self.assertFalse(check_matches(check, replace(identity, **{key: value})))

    def test_host_discovery_stale_and_incomplete_never_pass(self):
        identity = self.identity()
        host = new_check(identity, status='passed', quiesced=True)
        self.assertFalse(check_matches(host, identity))
        probe = {**host, 'coverage': 'native_policy'}
        self.assertFalse(check_matches(probe, identity, now=probe['checkedAt'] + 61))
        self.assertFalse(check_matches({**probe, 'incomplete': True}, identity))
        self.assertFalse(check_matches({**probe, 'quiesced': False}, identity))

    def test_secrets_are_not_part_of_toolchain_revision(self):
        first = toolchain_revision({'PATH': 'one', 'OPENAI_API_KEY': 'secret1'})
        self.assertEqual(first, toolchain_revision({'PATH': 'one', 'OPENAI_API_KEY': 'secret2'}))
        self.assertNotEqual(first, toolchain_revision({'PATH': 'two'}))

    def test_normalization_drops_arbitrary_content_and_is_bounded(self):
        check = normalize_check({'status': 'blocked', 'reasonCode': 'env_access_denied',
                                 'reason': 'secret', 'resumeCondition': 'secret', 'env': {'KEY': 'secret'},
                                 'output': 'secret', 'basisRefs': ['https://example?token=secret'],
                                 'dependencies': ['openspec'] * 10000, 'checkedAt': float('inf')})
        self.assertNotIn('secret', json.dumps(check))
        self.assertTrue(check['incomplete'])
        self.assertEqual(check['checkedAt'], 0)
        self.assertEqual(check['status'], 'blocked')
        self.assertLess(len(json.dumps(check)), 16 * 1024)
        self.assertEqual(len(normalize_history([check] * 100)), 16)

    def test_legacy_is_unknown_and_future_values_cannot_grant_readiness(self):
        self.assertEqual(normalize_environment({})['status'], 'unknown')
        self.assertEqual(normalize_check({'status': 'future_success'})['status'], 'unknown')
        self.assertEqual(normalize_check({'status': 'blocked'})['reasonCode'], 'env_unknown')
        self.assertTrue(normalize_check({'status': 'blocked'})['resumeCondition'])
        self.assertEqual(normalize_check({'status': [], 'coverage': {}, 'reasonCode': [], 'access': {}})['status'], 'unknown')

    def test_unknown_normalization_is_idempotent(self):
        for normalize in (normalize_check, normalize_environment):
            for value in ({}, None, {'status': 'unknown'}, {'status': 'blocked'}):
                self.assertEqual(normalize(normalize(value)), normalize(value))


class EnvironmentPersistenceTests(EnvironmentIdentityTests):
    def test_singleton_save_preserves_environment_and_concurrent_state(self):
        from src.backend.loop_store import LoopState, LoopStore, AsideTurn
        with tempfile.TemporaryDirectory() as tmp, patch('src.backend.loop_store.paths.sub', return_value=Path(tmp)):
            bridge = BridgeWS.__new__(BridgeWS)
            bridge._loop_store = LoopStore()
            state = LoopState(session_id='fixture', execution_environment={'revision': 4, 'status': 'blocked'})
            bridge._loop_states = {'fixture': state}
            other = bridge._loop_state('fixture')
            self.assertIs(state, other)
            other.goal = 'concurrent update'
            bridge._loop_save(state)
            restored = bridge._loop_store.load('fixture')
            self.assertEqual(restored.goal, 'concurrent update')
            self.assertEqual(restored.execution_environment['revision'], 4)

    def test_store_and_compact_do_not_lose_blocks_or_leak_paths(self):
        from src.backend.loop_store import LoopRecord, LoopState
        from src.backend.bridge_ws import BridgeWS
        identity = self.identity()
        check = new_check(identity, status='blocked', reason='env_access_denied',
                          entry=str(Path('private-cli.cmd').resolve()), basisRefs=['event:1'])
        record = LoopRecord(seq=1, environment_checks=[check] * 40)
        state = LoopState(session_id='session', loops=[record],
                          execution_environment={'revision': 3, 'status': 'blocked', 'latest': check, 'blockers': [check]})
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.execution_environment['revision'], 3)
        self.assertEqual(len(restored.loops[0].environment_checks), 16)
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_is_running = lambda _sid: False
        bridge._runtime_label = lambda *_args: ''
        compact = bridge._loop_payload(restored, compact=True)
        self.assertNotIn('private-cli', json.dumps(compact))
        self.assertEqual(compact['executionEnvironment']['blockers'][0]['reasonCode'], 'env_access_denied')
        self.assertEqual(len(compact['loops'][0]['environmentChecks']), 1)
        self.assertEqual(compact['loops'][0]['environmentCheckCount'], 16)

    def test_legacy_fields_and_unrelated_updates_preserve_environment(self):
        from src.backend.loop_store import LoopState, LoopPolicy
        old = LoopState.from_dict({'sessionId': 'old', 'loops': [{'seq': 1}]})
        self.assertEqual(old.execution_environment['status'], 'unknown')
        self.assertEqual(old.loops[0].environment_checks, [])
        old.execution_environment = {'status': 'blocked', 'revision': 7, 'blockers': [new_check(self.identity(), status='blocked')]}
        old.policy = LoopPolicy.from_dict({'maxLoops': 9})
        self.assertEqual(LoopState.from_dict(old.to_dict()).execution_environment['revision'], 7)
        malformed = normalize_environment({'blockers': [{}] * 100, 'status': 'passed'})
        self.assertEqual(malformed['status'], 'blocked')
        self.assertTrue(malformed['incomplete'])


class EffectiveEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_fallback_uses_actual_backend_not_requested_configuration(self):
        from src.backend.codex_office import CodexOfficeBackend
        from src.types import ModelBackendConfig, BackendType
        from tests.test_loop_diagnostics import LoopDiagnosticsTests
        backend = CodexOfficeBackend(ModelBackendConfig(id='worker', type=BackendType.CODEX_OFFICIAL, label='fixture'))
        calls = []
        async def send(**kwargs):
            calls.append(kwargs)
            return {}
        backend.send_message = send
        bridge, session, _ = LoopDiagnosticsTests().bridge_case(backend)
        def factory(backend_id):
            if backend_id == 'missing':
                raise ValueError('missing')
            return backend
        bridge._new_backend_instance = factory
        await bridge._loop_run_agent(session, 'inspect', 'prepare', 1, resume=False, backend_id='missing')
        self.assertEqual(calls[0]['execution_identity'].backend_id, 'worker')
        self.assertEqual(calls[0]['execution_access'], 'read-only')

    async def test_credential_changes_invalidate_opaque_revision_without_persisting_hash(self):
        from types import SimpleNamespace
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_state = lambda _sid: None
        config = SimpleNamespace(env={}, api_key='first')
        session = SimpleNamespace(id='s', owner_id='local')
        backend = SimpleNamespace(config=config)
        first = bridge._loop_execution_identity(session, backend, 'b', 'prepare', 'read-only', {'working_dir': '.'})
        self.assertEqual(first, bridge._loop_execution_identity(session, backend, 'b', 'prepare', 'read-only', {'working_dir': '.'}))
        config.api_key = 'second'
        second = bridge._loop_execution_identity(session, backend, 'b', 'prepare', 'read-only', {'working_dir': '.'})
        self.assertNotEqual(first.config_revision, second.config_revision)
        self.assertEqual(first.toolchain_revision, second.toolchain_revision)
        self.assertNotIn('second', json.dumps(second.summary()))


class EntryTests(EnvironmentIdentityTests):
    def test_local_precedence_and_backend_path_without_install(self):
        import os
        with tempfile.TemporaryDirectory(prefix='工具 path ') as tmp:
            root = Path(tmp)
            project = root / 'project'
            local = project / 'node_modules' / '.bin' / ('openspec.cmd' if os.name == 'nt' else 'openspec')
            local.parent.mkdir(parents=True)
            global_entry = root / 'global' / local.name
            global_entry.parent.mkdir()
            global_entry.write_text('fixture only', encoding='utf-8')
            env = {'PATH': str(global_entry.parent)}
            self.assertEqual(discover_openspec(str(project), env)['entry'], str(global_entry))
            local.write_text('fixture only', encoding='utf-8')
            self.assertEqual(discover_openspec(str(project), env)['entry'], str(local))
            self.assertEqual(discover_openspec(str(root / 'other'), {})['reasonCode'], 'env_cli_unresolved')

    def test_denial_does_not_search_another_path(self):
        with patch('src.backend.loop_execution_environment._existing_file', side_effect=EnvironmentError('env_access_denied')) as check:
            result = discover_openspec('.', {'PATH': str(Path('/other').resolve())})
        self.assertEqual(result['reasonCode'], 'env_access_denied')
        self.assertEqual(check.call_count, 1)
        self.assertFalse(result['entry'])

    def test_symlink_and_windows_metacharacters_are_rejected(self):
        with self.assertRaises(EnvironmentError):
            safe_entry(str(Path('unsafe&file.cmd').resolve()), windows=True)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local = root / 'node_modules/.bin/openspec'
            with patch('src.backend.loop_execution_environment._existing_file', return_value=True), \
                 patch('src.backend.loop_execution_environment.Path.resolve', side_effect=[root, root.parent]):
                self.assertEqual(discover_openspec(str(root), {})['reasonCode'], 'env_probe_failed')

    def test_hint_only_for_matching_native_success(self):
        identity = self.identity()
        entry = str(Path('openspec.cmd').resolve())
        good = new_check(identity, status='passed', coverage='native_policy', entry=entry, dependencyId='openspec', quiesced=True)
        self.assertIn(entry.replace('\\', '\\\\'), entry_hint(good, identity))
        self.assertFalse(entry_hint({**good, 'coverage': 'host_discovery'}, identity))
        self.assertFalse(entry_hint({**good, 'status': 'blocked'}, identity))


if __name__ == '__main__':
    unittest.main()

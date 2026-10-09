import asyncio
from dataclasses import replace
import json
import unittest

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError, WorkspaceIdentity
from src.backend.workbench_windows import WorkbenchWindows, WINDOW_REQUEST
from tests.engine_workbench_fixtures import EngineFixture


class WindowRegistryTests(unittest.TestCase):
    def setUp(self):
        self.workspace = WorkspaceIdentity('alice', 'executor', 'session', '/isolated', 'a' * 64)
        self.windows = WorkbenchWindows()
        self.windows.register(self.workspace, 'client', 'source')

    def prepare(self, request='op'):
        return self.windows.prepare(self.workspace, 'client', 'source', 1, request, 'target', 'b' * 64, 4)

    def test_registration_and_refresh_never_steal_or_clear_pending(self):
        self.assertEqual(self.windows.register(self.workspace, 'client', 'target')['windowId'], 'source')
        self.prepare()
        self.assertTrue(self.windows.register(self.workspace, 'client', 'source')['frozen'])
        for window in ['source', 'target']:
            with self.assertRaises(WorkbenchError):
                self.windows.require(self.workspace, 'client', window, 1)

    def test_ack_identity_and_commit_are_exact_and_idempotent(self):
        receipt = self.prepare()
        self.assertEqual(self.prepare(), receipt)
        with self.assertRaises(WorkbenchError):
            self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], True)
        for window, digest, version in [('source', 'b' * 64, 4), ('target', 'c' * 64, 4), ('target', 'b' * 64, 5)]:
            with self.assertRaises(WorkbenchError):
                self.windows.ack(self.workspace, 'client', window, 'op', digest, version)
        self.windows.ack(self.workspace, 'client', 'target', 'op', 'b' * 64, 4)
        committed = self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], True)
        self.assertEqual(committed['committedGeneration'], 2)
        self.assertEqual(self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], True), committed)
        self.windows.require(self.workspace, 'client', 'target', 2)
        for window, generation in [('source', 1), ('target', 1), ('source', 2)]:
            with self.assertRaises(WorkbenchError):
                self.windows.require(self.workspace, 'client', window, generation)
        # 迟到取消不能撤销已提交归属。
        self.assertEqual(self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], False), committed)

    def test_conflicts_and_inflight_writes_do_not_freeze_or_release_wrong_operation(self):
        with self.assertRaisesRegex(WorkbenchError, 'in_flight'):
            self.windows.prepare(self.workspace, 'client', 'source', 1, 'op', 'target', 'b' * 64, 4, busy=True)
        self.windows.require(self.workspace, 'client', 'source', 1)
        receipt = self.prepare()
        with self.assertRaisesRegex(WorkbenchError, 'conflict'):
            self.windows.prepare(self.workspace, 'client', 'source', 1, 'op', 'other', 'b' * 64, 4)
        with self.assertRaisesRegex(WorkbenchError, 'busy'):
            self.prepare('second')
        cancelled = self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], False)
        self.assertEqual(cancelled['status'], 'cancelled')
        self.windows.require(self.workspace, 'client', 'source', 1)
        self.assertEqual(self.windows.ack(self.workspace, 'client', 'target', 'op', 'b' * 64, 4), cancelled)

    def test_namespaces_and_bounded_receipts_never_include_bodies(self):
        other = replace(self.workspace, ownerId='bob')
        self.windows.register(other, 'client', 'target')
        self.windows.require(other, 'client', 'target', 1)
        self.assertIsNone(self.windows.get(self.workspace, 'other-client'))
        self.assertIsNone(self.windows.get(replace(self.workspace, workspaceRevision='new'), 'client'))
        for index in range(80):
            row = self.prepare(f'op{index}')
            self.windows.finish(self.workspace, 'client', 'source', 1, f'op{index}', row['fingerprint'], False)
        self.assertEqual(len(self.windows.get(self.workspace, 'client').receipts), 64)
        self.assertEqual(self.windows.receipt(self.workspace, 'client', 'op0')['status'], 'unknown')

    def test_explicit_recovery_fences_old_window_and_late_commit_without_claiming_exit(self):
        receipt = self.prepare()
        revision = self.windows.get(self.workspace, 'client').revision
        with self.assertRaisesRegex(WorkbenchError, 'in_flight'):
            self.windows.reclaim(self.workspace, 'client', 'recovered', 'recover', 'source', 1, revision, True)
        restored = self.windows.reclaim(self.workspace, 'client', 'recovered', 'recover', 'source', 1, revision)
        self.assertEqual(restored['generation'], 2)
        self.assertEqual(self.windows.reclaim(self.workspace, 'client', 'recovered', 'recover', 'source', 1, revision), restored)
        self.assertEqual(self.windows.finish(self.workspace, 'client', 'source', 1, 'op', receipt['fingerprint'], True)['status'], 'cancelled')
        with self.assertRaises(WorkbenchError):
            self.windows.require(self.workspace, 'client', 'source', 1)
        self.windows.require(self.workspace, 'client', 'recovered', 2)
        with self.assertRaisesRegex(WorkbenchError, 'stale_window_recovery'):
            self.windows.reclaim(self.workspace, 'client', 'another', 'other', 'source', 1, revision)


class WindowBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._ensure_kit_scheduler = lambda: None
        self.bridge._loop_control_reserved = lambda _: False
        self.owner_token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.identity = self.bridge._workbench_identity(self.session.id)
        self.metadata = {'clientId': 'client', 'windowId': 'source', 'lease': {
            'sessionId': self.session.id, 'workspaceRevision': self.identity.workspaceRevision, 'generation': 1}}
        self.window_token = WINDOW_REQUEST.set(self.metadata)
        self.bridge._windows().register(self.identity, 'client', 'source')

    async def asyncTearDown(self):
        WINDOW_REQUEST.reset(self.window_token)
        _REQUEST_OWNER_ID.reset(self.owner_token)

    def rpc(self, **payload):
        return json.loads(self.bridge._rpc_workbenchWindow(self.session.id, json.dumps(self.identity.to_dict()), json.dumps(payload)))

    async def test_transport_binds_one_authenticated_connection_and_rejects_metadata_omission(self):
        first, second = object(), object()
        self.bridge._window_bind_connection(first, self.metadata)
        with self.assertRaisesRegex(WorkbenchError, 'exists'):
            self.bridge._window_bind_connection(second, self.metadata)
        with self.assertRaisesRegex(WorkbenchError, 'required'):
            self.bridge._window_bind_connection(first, None)
        with self.assertRaisesRegex(WorkbenchError, 'changed'):
            self.bridge._window_bind_connection(first, {**self.metadata, 'windowId': 'target'})
        self.bridge._window_connection_bindings.pop(first)
        self.bridge._window_bind_connection(second, self.metadata)
        self.assertEqual(self.rpc(action='get')['windowId'], 'source')

    async def test_one_page_may_use_local_and_relay_alias_without_allowing_cloned_tab(self):
        direct, relay, clone = object(), object(), object()
        metadata = {**self.metadata, 'documentId': 'one-page'}
        self.bridge._window_bind_connection(direct, metadata)
        self.bridge._window_bind_connection(relay, metadata)
        with self.assertRaisesRegex(WorkbenchError, 'exists'):
            self.bridge._window_bind_connection(clone, {**metadata, 'documentId': 'cloned-tab'})
        with self.assertRaisesRegex(WorkbenchError, 'changed'):
            self.bridge._window_bind_connection(direct, {**metadata, 'documentId': 'different'})

    async def test_mutation_dispatch_rejects_frozen_and_old_window_but_read_receipt_is_allowed(self):
        calls = []
        self.bridge._rpc_terminalInput = lambda session_id: calls.append(session_id)
        await self.bridge._dispatch('terminalInput', [self.session.id])
        receipt = self.rpc(action='prepare', generation=1, requestId='op', targetWindow='target', stateDigest='b' * 64, stateVersion=1)
        with self.assertRaisesRegex(WorkbenchError, 'busy'):
            await self.bridge._dispatch('terminalInput', [self.session.id])
        self.assertEqual(self.rpc(action='get', requestId='op')['receipt']['status'], 'prepared')
        WINDOW_REQUEST.set({**self.metadata, 'windowId': 'target'})
        self.rpc(action='ack', requestId='op', stateDigest='b' * 64, stateVersion=1)
        WINDOW_REQUEST.set(self.metadata)
        self.rpc(action='commit', generation=1, requestId='op', fingerprint=receipt['fingerprint'])
        with self.assertRaisesRegex(WorkbenchError, 'stale_window'):
            await self.bridge._dispatch('terminalInput', [self.session.id])
        WINDOW_REQUEST.set({**self.metadata, 'windowId': 'target', 'lease': {**self.metadata['lease'], 'generation': 2}})
        await self.bridge._dispatch('terminalInput', [self.session.id])
        self.assertEqual(calls, [self.session.id, self.session.id])

    async def test_account_and_workspace_changes_cannot_read_or_release_old_handoff(self):
        self.rpc(action='prepare', generation=1, requestId='op', targetWindow='target', stateDigest='b' * 64, stateVersion=1)
        owner = _REQUEST_OWNER_ID.set('wrong-user')
        try:
            with self.assertRaises(PermissionError):
                self.rpc(action='get')
        finally:
            _REQUEST_OWNER_ID.reset(owner)
        self.session.working_dir = str(self.fixture.home)
        self.assertEqual(self.rpc(action='get')['reasonCode'], 'stale_workspace')
        with self.assertRaisesRegex(WorkbenchError, 'stale_window'):
            self.bridge._window_guard(self.session.id)

    async def test_permission_read_does_not_resolve_or_copy_delegation_and_is_fenced(self):
        sid = self.session.id
        gate = asyncio.get_running_loop().create_future()
        self.bridge._permission_gates = {sid: gate}
        self.bridge._permission_gate_ids = {sid: 'current-plan'}
        self.bridge._permission_payloads = {sid: {'sessionId': sid, 'messageId': 'message', 'requestId': 'current-plan',
            'allowSkip': False, 'tools': [{'name': 'test-plan', 'input': 'bounded plan'}]}}
        self.bridge._skip_rest_sessions = set()
        result = json.loads(self.bridge._rpc_workbenchPermissionGet(sid))
        self.assertEqual(result['pending']['requestId'], 'current-plan')
        self.assertFalse(gate.done()); self.assertEqual(self.bridge._skip_rest_sessions, set())
        self.rpc(action='prepare', generation=1, requestId='op', targetWindow='target', stateDigest='b' * 64, stateVersion=1)
        with self.assertRaisesRegex(WorkbenchError, 'busy'):
            await self.bridge._dispatch('grantPermission', [sid, True, False, 'current-plan'])
        self.assertFalse(gate.done())
        gate.set_result(False)
        self.assertIsNone(json.loads(self.bridge._rpc_workbenchPermissionGet(sid))['pending'])

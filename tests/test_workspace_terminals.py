from __future__ import annotations

import asyncio
import json
from unittest.mock import patch
import unittest

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.workspace_terminals import TerminalManager, OUTPUT_LIMIT, READ_LIMIT
from tests.engine_workbench_fixtures import EngineFixture


class FakeProcess:
    def __init__(self, data, state):
        self.data, self.state = data, state
        self.stdout_eof = False
        self.failed = self.confirmed = False
        self.inputs = []
        self.sizes = []
        self.stop_gate = None
        self.can_stop = True

    async def start(self, argv, cwd, env, **kwargs):
        self.cwd = cwd

    async def write(self, data):
        self.inputs.append(data)
        if data == b'unknown':
            raise TimeoutError()

    async def resize(self, cols, rows):
        self.sizes.append((cols, rows))

    async def stop(self):
        if self.stop_gate:
            await self.stop_gate
        self.confirmed = self.can_stop
        return self.confirmed


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._loop_control_reserved = lambda _: False
        self.bridge._ensure_kit_scheduler = lambda: None
        self.events = []
        async def emit(*args, **kwargs):
            self.events.append(args)
        self.bridge._send_for_session = emit
        self.token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.workspace = self.bridge._workbench_identity(self.session.id)
        self.manager = self.bridge._terminal_manager = TerminalManager(self.bridge, FakeProcess)
        self.shell = patch('src.backend.workspace_terminals.terminal_shells', return_value=[{
            'id': 'fake', 'executable': '/isolated/fake', 'args': []}])
        self.shell.start()

    async def asyncTearDown(self):
        for row in self.manager.rows.values():
            if row.notice:
                row.notice.cancel()
            if row.task:
                await row.task
        self.shell.stop()
        _REQUEST_OWNER_ID.reset(self.token)

    async def create(self, request='create'):
        row = self.manager.create(self.workspace, {'requestId': request, 'shell': 'fake', 'controlRevision': 0})
        await row.task
        return row

    async def test_explicit_create_is_idempotent_and_correct_workspace(self):
        listing = json.loads(self.bridge._rpc_terminalList(self.session.id, json.dumps(self.workspace.to_dict())))
        self.assertEqual(listing['terminals'], [])
        self.assertFalse(self.bridge._engineering_active(self.session.id))
        row = await self.create()
        same = await self.create()
        self.assertIs(row, same)
        self.assertEqual(row.process.cwd, self.workspace.workingDir)
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        with self.assertRaisesRegex(WorkbenchError, 'conflict'):
            self.manager.create(self.workspace, {'requestId': 'create', 'shell': 'fake', 'controlRevision': 0, 'cols': 90})

    async def test_input_dedup_unknown_and_control_key_not_exit(self):
        row = await self.create()
        value = {'requestId': 'input', 'sequence': 1, 'text': '\x03'}
        self.assertEqual((await self.manager.input(row, value))['status'], 'accepted')
        self.assertEqual((await self.manager.input(row, value))['status'], 'duplicate')
        self.assertEqual(row.process.inputs, [b'\x03'])
        self.assertEqual(row.status, 'running')
        await self.manager.resize(row, 90, 30)
        self.assertEqual(row.process.sizes, [(90, 30)])
        with self.assertRaisesRegex(WorkbenchError, 'conflict'):
            await self.manager.input(row, {**value, 'text': 'changed'})
        result = await self.manager.input(row, {'requestId': 'unknown', 'sequence': 2, 'text': 'unknown'})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        with self.assertRaisesRegex(WorkbenchError, 'not_running'):
            await self.manager.resize(row, 90, 30)

    async def test_stopping_cancelled_waiter_retains_activity_until_confirmed(self):
        row = await self.create()
        gate = asyncio.get_running_loop().create_future()
        row.process.stop_gate = gate
        task = asyncio.create_task(self.manager.stop(row, 'stop'))
        await asyncio.sleep(0); await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        gate.set_result(None)
        await row.stop_task
        self.assertEqual(row.status, 'stopped')
        self.assertFalse(self.bridge._engineering_active(self.session.id))

    async def test_unknown_stop_and_wrong_resource_never_release_protection(self):
        row = await self.create()
        row.process.can_stop = False
        await self.manager.stop(row, 'stop')
        self.assertEqual(row.status, 'unknown')
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        with self.assertRaisesRegex(WorkbenchError, 'unavailable'):
            self.manager.require(self.workspace, row.resource_id, 'old-instance')
        wrong = self.workspace.to_dict(); wrong['ownerId'] = 'other'
        token = _REQUEST_OWNER_ID.set('other')
        try:
            with self.assertRaises(PermissionError):
                self.bridge._rpc_terminalRead(self.session.id, json.dumps(wrong), '{}')
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_output_ring_and_read_frames_bounded_with_gap(self):
        row = await self.create()
        for _ in range(400):
            row.append(b'x' * 8192)
        self.assertLessEqual(row.size, OUTPUT_LIMIT)
        page = row.read(0)
        self.assertTrue(page['gap'])
        self.assertLessEqual(sum(len(c['text'].encode()) for c in page['chunks']), READ_LIMIT)
        next_page = row.read(page['through'])
        self.assertFalse(next_page['gap'])
        self.assertEqual(next_page['chunks'][0]['sequence'], page['through'] + 1)
        self.assertTrue(row.read(row.sequence + 10)['gap'])

    async def test_new_activity_rejected_during_loop_reservation(self):
        self.bridge._loop_control_reserved = lambda _: True
        with self.assertRaisesRegex(WorkbenchError, 'handoff_busy'):
            await self.create()
        self.assertEqual(len(self.manager.rows), 0)

    async def test_unavailable_adapter_never_falls_back_and_restart_has_no_old_pid_takeover(self):
        with patch('src.backend.workspace_terminals.terminal_shells', return_value=[]):
            with self.assertRaisesRegex(WorkbenchError, 'shell_unavailable'):
                await self.create()
        self.assertFalse(self.manager.rows)
        row = await self.create()
        restarted = TerminalManager(self.bridge, FakeProcess)
        with self.assertRaisesRegex(WorkbenchError, 'instance_unavailable'):
            restarted.require(self.workspace, row.resource_id, row.generation)
        self.assertFalse(restarted.rows)

"""Deterministic environment protocol and Windows wrapper contracts (no models)."""
import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import AsyncMock

from src.backend.codex_environment import (command_exec, checked_policy, probe_policy,
    probe_environment, windows_lookup_command, windows_version_command, native_error_code, OUTPUT_CAP)
from src.backend.loop_execution_environment import EnvironmentError, ExecutionIdentity
from src.backend.codex_app_server import CODEX_JSONL_STREAM_LIMIT
from src.backend.codex_environment import FRAME_CAP, ProbeAppServerProcess


def identity(access='read-only', workspace=None):
    return ExecutionIdentity('owner', 'executor', 'session', workspace or str(Path.cwd()),
                             'backend', 'app-server', 'prepare', access)


class Connection:
    def __init__(self, messages):
        self._next_id = 1
        self.messages = list(messages)
        self.sent = []
        self.reading = False

    async def send(self, message):
        self.sent.append(message)

    async def respond(self, request_id, **kwargs):
        self.sent.append({'id': request_id, **kwargs})

    async def _read_one(self, timeout):
        assert not self.reading, 'Only one reader is allowed'
        self.reading = True
        try:
            if not self.messages:
                raise asyncio.TimeoutError
            value = self.messages.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value
        finally:
            self.reading = False


def result(stdout='', stderr='', exit_code=0):
    return {'id': 1, 'result': {'exitCode': exit_code, 'stdout': stdout, 'stderr': stderr}}


class ProbeContracts(unittest.IsolatedAsyncioTestCase):
    async def test_confirmed_pre_spawn_failure_has_no_process_to_wait_for(self):
        import errno
        for error in (FileNotFoundError('fixture'), PermissionError('fixture'),
                      BlockingIOError(errno.EAGAIN, 'fixture')):
            with self.subTest(error=type(error).__name__):
                conn = ProbeAppServerProcess(launch_command=['fixture-never-started'])
                with patch('src.backend.codex_app_server.asyncio.create_subprocess_exec', AsyncMock(side_effect=error)):
                    with self.assertRaises((OSError, RuntimeError)):
                        await conn.start()
                await conn.close()
                await conn.close()
                self.assertIsNone(conn.proc)
                self.assertIsNone(conn.lease)
                self.assertTrue(conn.cleanup_confirmed)

    async def test_unknown_spawn_or_cleanup_must_not_be_declared_quiesced(self):
        for error in (asyncio.CancelledError(), RuntimeError('unknown spawn outcome'), OSError('unknown OS failure')):
            conn = ProbeAppServerProcess(launch_command=['fixture-never-started'])
            with patch('src.backend.codex_app_server.asyncio.create_subprocess_exec', AsyncMock(side_effect=error)):
                with self.assertRaises(type(error)):
                    await conn.start()
            await conn.close()
            self.assertFalse(conn.cleanup_confirmed)
        conn = ProbeAppServerProcess()
        conn._spawn_observed = True
        conn.lease = SimpleNamespace(stop=AsyncMock(return_value=False))
        await conn.close()
        self.assertFalse(conn.cleanup_confirmed)
        self.assertIsNotNone(conn.lease)

    async def test_formal_events_and_resume_keep_128_mib_contract(self):
        large = 'x' * (13 * 1024 * 1024)
        for method in (None, 'thread/start', 'thread/resume', 'thread/read', 'turn/start'):
            conn = ProbeAppServerProcess()
            self.assertEqual(conn.stream_limit, CODEX_JSONL_STREAM_LIMIT)
            reader = asyncio.StreamReader(limit=conn.stream_limit)
            message = ({'method': 'item/completed', 'params': {'output': large}} if method is None
                       else {'id': 1, 'result': {'history': large}})
            reader.feed_data(json.dumps(message).encode() + b'\n')
            conn.proc = SimpleNamespace(stdout=reader)
            conn.send = AsyncMock()
            if method is None:
                self.assertEqual((await conn.next_message(1))['params']['output'], large)
            else:
                self.assertEqual((await conn.request(method, {}, 1))['history'], large)
            self.assertEqual(reader._limit, CODEX_JSONL_STREAM_LIMIT)

    async def test_probe_frames_remain_bounded_before_decode_on_large_stream(self):
        for method in ('initialize', 'config/read', 'configRequirements/read', 'command/exec'):
            conn = ProbeAppServerProcess()
            reader = asyncio.StreamReader(limit=CODEX_JSONL_STREAM_LIMIT)
            reader.feed_data(b'{"id":1,"result":"' + b'x' * FRAME_CAP + b'"}\n')
            conn.proc = SimpleNamespace(stdout=reader)
            conn.send = AsyncMock()
            with patch('src.backend.codex_app_server.json.loads') as decode:
                with self.assertRaises(RuntimeError):
                    await conn.request(method, {}, 1)
                decode.assert_not_called()
            self.assertEqual(reader._limit, CODEX_JSONL_STREAM_LIMIT)

    async def test_explicit_smaller_stream_limit_is_preserved(self):
        conn = ProbeAppServerProcess(stream_limit=1024)
        self.assertEqual(conn.stream_limit, 1024)
        reader = asyncio.StreamReader(limit=conn.stream_limit)
        reader.feed_data(b'{"id":1,"result":"' + b'x' * 2048 + b'"}\n')
        conn.proc = SimpleNamespace(stdout=reader)
        conn.send = AsyncMock()
        with patch('src.backend.codex_app_server.json.loads') as decode:
            with self.assertRaises(RuntimeError):
                await conn.request('thread/resume', {}, 1)
            decode.assert_not_called()
        self.assertEqual(reader._limit, 1024)

    async def test_only_confirmed_pre_spawn_transient_is_retried_once(self):
        import errno
        from src.backend.codex_environment import ProbeAppServerProcess
        for errors, expected in (([BlockingIOError(errno.EAGAIN, 'fixture'), None], 2),
                                 ([EnvironmentError('env_access_denied')], 1),
                                 ([BlockingIOError(errno.EAGAIN, 'fixture')] * 2, 2)):
            conn = ProbeAppServerProcess()
            with patch('src.backend.codex_app_server.CodexAppServerProcess.start', AsyncMock(side_effect=errors)) as start:
                try:
                    await conn.start()
                except (EnvironmentError, BlockingIOError):
                    pass
                self.assertEqual(start.await_count, expected)
    async def test_notifications_do_not_renew_deadline_and_frames_bound_before_json(self):
        from types import SimpleNamespace
        from src.backend.codex_app_server import CodexAppServerProcess
        tick = [0.0]
        class SlowNotifications(Connection):
            async def _read_one(self, timeout):
                tick[0] += 6
                return {'method': 'notification'}
        conn = SlowNotifications([])
        with patch('src.backend.codex_environment.time', SimpleNamespace(monotonic=lambda: tick[0])):
            with self.assertRaises(EnvironmentError) as caught:
                await command_exec(conn, ['fixed'], '.', probe_policy('read-only', '.'))
        self.assertEqual(caught.exception.code, 'env_probe_timeout')
        self.assertEqual(sum(m.get('method') == 'command/exec' for m in conn.sent), 1)
        reader = asyncio.StreamReader(limit=1000)
        reader.feed_data(b'{' + b'x' * 500 + b'}\n')
        process = CodexAppServerProcess()
        process.proc = SimpleNamespace(stdout=reader)
        with patch('src.backend.codex_app_server.json.loads') as decode:
            with self.assertRaises(RuntimeError):
                await process.read_bounded(1, 100)
            decode.assert_not_called()
        self.assertEqual(reader._limit, 1000)

    async def test_fixed_policy_no_model_or_thread(self):
        for access in ('read-only', 'workspace-write'):
            conn = Connection([result('ok')])
            policy = probe_policy(access, str(Path.cwd()))
            self.assertEqual((await command_exec(conn, ['test.exe', '--version'], str(Path.cwd()), policy))['stdout'], 'ok')
            self.assertEqual(len(conn.sent), 1)
            params = conn.sent[0]['params']
            self.assertEqual(conn.sent[0]['method'], 'command/exec')
            self.assertEqual(params['sandboxPolicy'], policy)
            self.assertEqual(params['timeoutMs'], 10000)
            self.assertEqual(params['outputBytesCap'], 32768)
            self.assertNotIn('env', params)
            self.assertFalse(params['streamStdoutStderr'])

    async def test_timeout_and_cancel_wait_for_command_terminal_not_terminate_ack(self):
        for fault in (asyncio.TimeoutError(), asyncio.CancelledError()):
            conn = Connection([fault, {'id': 2, 'result': {}}, result()])
            with self.assertRaises((EnvironmentError, asyncio.CancelledError)) as caught:
                await command_exec(conn, ['cmd.exe'], str(Path.cwd()), probe_policy('read-only', '.'))
            error = caught.exception
            self.assertTrue(error.probe_quiesced if isinstance(error, asyncio.CancelledError) else error.quiesced)
            self.assertEqual(conn.sent[-1]['method'], 'command/exec/terminate')

    async def test_unconfirmed_exit_and_notification_bounds(self):
        for messages in ([asyncio.TimeoutError()], [{'method': 'spam'}] * 129):
            conn = Connection(messages)
            with self.assertRaises(EnvironmentError) as caught:
                await command_exec(conn, ['cmd.exe'], '.', probe_policy('read-only', '.'))
            self.assertFalse(caught.exception.quiesced)
            self.assertEqual(conn.sent[-1]['method'], 'command/exec/terminate')

    async def test_output_bounds_and_structured_error(self):
        cases = [(result('x' * OUTPUT_CAP), 'env_probe_failed'),
                 ({'id': 1, 'error': {'code': -32601, 'message': 'secret'}}, 'env_probe_unsupported'),
                 ({'id': 1, 'error': {'code': -32600, 'message': 'custom outputBytesCap is not supported with windows sandbox'}}, 'env_probe_unsupported'),
                 ({'id': 1, 'error': {'code': -32000, 'message': 'orchestrator_helper_incomplete secret'}}, 'env_runner_setup_failed')]
        for message, reason in cases:
            with self.assertRaises(EnvironmentError) as caught:
                await command_exec(Connection([message]), ['cmd.exe'], '.', probe_policy('read-only', '.'))
            self.assertEqual(caught.exception.code, reason)
            self.assertNotIn('secret', str(caught.exception))
        # Arbitrary tool/project output is not a structured error envelope.
        self.assertEqual(native_error_code('orchestrator_helper_incomplete'), 'env_unknown')
        self.assertEqual(native_error_code({'code': -32603, 'message': 'Access denied'}), 'env_access_denied')
        self.assertEqual(native_error_code({'code': -32600, 'message': 'arbitrary project stdout'}), 'env_probe_failed')
        self.assertEqual((await command_exec(Connection([result('Access denied')]), ['test'], '.', probe_policy('read-only', '.')))['stdout'], 'Access denied')

    def test_effective_policy_not_guessed_or_relaxed(self):
        policy = {'type': 'workspaceWrite', 'writableRoots': [str(Path.cwd())],
                  'networkAccess': False, 'excludeTmpdirEnvVar': True, 'excludeSlashTmp': True}
        self.assertEqual(checked_policy(policy, identity('workspace-write')), policy)
        for raw in ({'type': 'dangerFullAccess'}, {'type': 'readOnly', 'extra': 'new constraint'}, None):
            with self.assertRaises(EnvironmentError):
                checked_policy(raw, identity())


@unittest.skipUnless(os.name == 'nt', 'Windows argv contract')
class WindowsWrapperContracts(unittest.TestCase):
    def test_space_unicode_shim_and_distinct_missing_runtime(self):
        with tempfile.TemporaryDirectory(prefix='awu-loop-wrapper-') as root:
            entry = Path(root) / '测试 空格' / 'openspec.cmd'
            entry.parent.mkdir()
            entry.write_text('@echo off\necho 1.2.3\n', encoding='utf-8')
            version = subprocess.run(windows_version_command(str(entry), system_root=os.environ['SYSTEMROOT']),
                                     capture_output=True, text=True, timeout=10)
            self.assertEqual(version.returncode, 0, version.stderr)
            self.assertEqual(version.stdout.strip(), '1.2.3')
            env = {**os.environ, 'PATH': str(entry.parent)}
            lookup = subprocess.run(windows_lookup_command(str(entry), 'fixture', system_root=os.environ['SYSTEMROOT']),
                                    env=env, capture_output=True, timeout=10)
            packet = json.loads(lookup.stdout.decode('utf-8-sig'))
            self.assertEqual(packet['nonce'], 'fixture')
            self.assertEqual(packet['state'], 'runtime_missing')
            self.assertEqual(packet['entry'], str(entry))
            (entry.parent / 'node.exe').write_bytes(b'fixture-only-never-executed')
            lookup = subprocess.run(windows_lookup_command(str(entry), 'fixture', system_root=os.environ['SYSTEMROOT']),
                                    env=env, capture_output=True, timeout=10)
            self.assertEqual(json.loads(lookup.stdout.decode('utf-8-sig'))['state'], 'resolved')


if __name__ == '__main__':
    unittest.main()

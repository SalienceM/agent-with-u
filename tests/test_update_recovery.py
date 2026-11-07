"""更新恢复与弱网回归：仅临时文件、假安装器和内存 HTTP transport。"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import httpx

from src.backend import update_download as download
from src.backend.update_manager import UpdateManager
from tests import test_node_updates


class UpdateRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        _, self.manifest = test_node_updates.NodeUpdateManagerTests()._fixture(self.root)
        self.env = mock.patch.dict(os.environ, {'AGENT_WITH_U_RUNTIME': 'headless', 'AGENT_WITH_U_DESKTOP_EXE': ''})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.manager = UpdateManager(self.root / 'updates')
        self.manager.configure({'manifestUrl': str(self.manifest)})

    async def stage(self, manager=None, request='a' * 32):
        manager = manager or self.manager
        await manager.start_stage(request_id=request)
        if manager._task:
            await manager._task
        return manager.status()

    async def test_restart_adopts_old_preparation_and_replaces_staged_plan(self):
        old = await self.stage()
        restarted = UpdateManager(self.manager.root)
        restarted.configure({'manifestUrl': str(self.manifest)})
        new = await self.stage(restarted, 'b' * 32)
        self.assertEqual('staged', new['phase'])
        self.assertEqual('b' * 32, new['stageRequestId'])
        self.assertTrue(Path(old['planPath']).is_file())
        self.assertIsNone(restarted._normal_lease)

    async def test_running_process_cannot_be_stolen_and_failed_configuration_releases_lease(self):
        await self.stage()
        self.manager._reserve_normal()
        try:
            other = UpdateManager(self.manager.root)
            with self.assertRaisesRegex(Exception, '进程'):
                other.configure({})
        finally:
            self.manager._drop_normal_lease()
        with self.assertRaises(Exception):
            other.configure({'manifestUrl': 'invalid-source'})
        self.assertIsNone(other._normal_lease)
        await self.stage(other, 'b' * 32)

    async def test_same_stage_is_coalesced_and_old_request_cannot_replace_new(self):
        original = self.manager._download
        with mock.patch.object(self.manager, '_download', wraps=original) as worker:
            first, second = await asyncio.gather(*[self.manager.start_stage(request_id='a' * 32) for _ in range(2)])
            self.assertEqual(first['stageRequestId'], second['stageRequestId'])
            await self.manager._task
            await self.manager.start_stage(request_id='a' * 32)
            self.assertEqual(1, worker.call_count)
        await self.stage(request='b' * 32)
        restarted = UpdateManager(self.manager.root)
        with self.assertRaises(Exception):
            await restarted.start_stage(request_id='a' * 32)
        self.assertEqual('b' * 32, restarted.status()['stageRequestId'])
        self.assertIsNone(restarted._normal_lease)

    async def test_lost_stage_waiter_does_not_cancel_owned_preparation(self):
        entered, release = asyncio.Event(), asyncio.Event()
        read = self.manager._read_source
        async def slow(*args, **kwargs):
            entered.set()
            await release.wait()
            return await read(*args, **kwargs)
        with mock.patch.object(self.manager, '_read_source', side_effect=slow):
            waiter = asyncio.create_task(self.manager.start_stage(request_id='a' * 32))
            await entered.wait()
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            release.set()
            await self.manager.start_stage(request_id='a' * 32)
            await self.manager._task
        self.assertEqual('staged', self.manager.status()['phase'])

    async def test_frozen_check_does_not_switch_to_new_cdn_release(self):
        checked = await self.manager.check()
        doc = json.loads(self.manifest.read_text())
        doc['release']['version'] = '100.0.0'
        self.manifest.write_text(json.dumps(doc))
        await self.manager.start_stage(request_id='a' * 32, selection_fingerprint=checked['selectionFingerprint'])
        await self.manager._task
        self.assertEqual(checked['release'], self.manager.status()['release'])
        restarted = UpdateManager(self.manager.root)
        with self.assertRaisesRegex(Exception, '版本已变化'):
            await restarted.start_stage(request_id='b' * 32, selection_fingerprint=checked['selectionFingerprint'])
        self.assertIsNone(restarted._normal_lease)
        self.assertNotEqual('staged', restarted.status()['phase'])

    async def test_apply_reply_loss_never_launches_twice_even_after_restart(self):
        await self.stage()
        with mock.patch.object(self.manager, '_launch_headless_helper') as launch:
            first = self.manager.prepare_apply('c' * 32, 'a' * 32)
            again = self.manager.prepare_apply('c' * 32, 'a' * 32)
            self.assertEqual('restarting', first['status'])
            self.assertTrue(again['alreadyRequested'])
            self.assertEqual(1, launch.call_count)
        restarted = UpdateManager(self.manager.root)
        self.assertTrue(restarted.prepare_apply('c' * 32, 'a' * 32)['alreadyRequested'])
        with self.assertRaises(Exception):
            await restarted.start_stage(request_id='d' * 32)
        with self.assertRaises(Exception):
            await restarted.cancel()
        self.assertIsNone(restarted._normal_lease)
        self.assertEqual('installing', restarted.status()['phase'])

    async def test_late_failure_or_result_cannot_complete_other_apply(self):
        await self.stage()
        with mock.patch.object(self.manager, '_launch_headless_helper'):
            self.manager.prepare_apply('c' * 32, 'a' * 32)
        with self.assertRaises(Exception):
            self.manager.mark_install_failed('late', 'd' * 32)
        result_path = self.manager.root / ('install-result-' + 'c' * 32 + '.json')
        result_path.write_text(json.dumps({'ok': True, 'requestId': 'd' * 32, 'finishedAt': time.time()}))
        self.assertEqual('installing', self.manager.status()['phase'])
        result_path.write_text(json.dumps({'ok': True, 'requestId': 'c' * 32, 'finishedAt': time.time()}))
        self.assertEqual('installed', self.manager.status()['phase'])
        self.assertFalse(self.manager.journal.active())

    async def test_old_helper_result_is_bound_by_unique_path(self):
        await self.stage()
        with mock.patch.object(self.manager, '_launch_headless_helper'):
            self.manager.prepare_apply('c' * 32, 'a' * 32)
        self.manager.result_path.write_text(json.dumps({'ok': True, 'finishedAt': time.time()}))
        self.assertEqual('installing', self.manager.status()['phase'])
        plan = json.loads(Path(self.manager.status()['planPath']).read_text())
        Path(plan['resultPath']).write_text(json.dumps({'ok': True, 'finishedAt': time.time()}))
        self.assertEqual('installed', UpdateManager(self.manager.root).status()['phase'])

    async def test_definite_launch_failure_can_be_replaced(self):
        await self.stage()
        with mock.patch.object(self.manager, '_launch_headless_helper', side_effect=OSError('fake failure')):
            with self.assertRaises(OSError):
                self.manager.prepare_apply('c' * 32, 'a' * 32)
        restarted = UpdateManager(self.manager.root)
        self.assertEqual('staged', (await self.stage(restarted, 'b' * 32))['phase'])
        with self.assertRaisesRegex(Exception, '请求已使用'):
            restarted.prepare_apply('c' * 32, 'b' * 32)

    async def test_changed_signature_policy_cannot_reuse_checked_selection(self):
        checked = await self.manager.check()
        self.manager.configure({'requireSignature': True, 'signatureKey': 'fixture-only'})
        with self.assertRaises(Exception):
            await self.manager.start_stage(request_id='a' * 32, selection_fingerprint=checked['selectionFingerprint'])
        self.assertEqual('error', self.manager.status()['phase'])
        self.assertIsNone(self.manager._task)

    async def test_replacement_waits_for_old_download_to_stop(self):
        started, stopped = asyncio.Event(), asyncio.Event()
        original = self.manager._download
        calls = 0
        async def worker(selection):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    stopped.set()
            else:
                self.assertTrue(stopped.is_set())
                await original(selection)
        with mock.patch.object(self.manager, '_download', side_effect=worker):
            await self.manager.start_stage(request_id='a' * 32)
            await started.wait()
            result = await self.stage(request='b' * 32)
        self.assertEqual('staged', result['phase'])
        self.assertEqual(2, calls)
        self.assertIsNone(self.manager._normal_lease)

    async def test_bad_http_checksum_never_leaves_installable_plan(self):
        document = json.loads(self.manifest.read_text())
        artifact = document['artifacts'][0]
        artifact['url'] = 'https://fixture.invalid/bad-artifact'
        self.manifest.write_text(json.dumps(document))
        real_client = httpx.AsyncClient
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b'z' * artifact['size']))
        with mock.patch.object(download.httpx, 'AsyncClient', side_effect=lambda **kw: real_client(transport=transport, **kw)):
            status = await self.stage()
        self.assertEqual('error', status['phase'])
        self.assertIn('SHA-256 mismatch', status['error'])
        self.assertFalse(status['planPath'])
        self.assertFalse(list(self.manager.root.rglob('*.part')))

    async def test_rejected_concurrent_stage_does_not_release_checker_lease(self):
        ready, release = asyncio.Event(), asyncio.Event()
        original = self.manager._read_source
        async def slow(*args, **kwargs):
            ready.set()
            await release.wait()
            return await original(*args, **kwargs)
        with mock.patch.object(self.manager, '_read_source', side_effect=slow):
            task = asyncio.create_task(self.manager.check())
            await ready.wait()
            with self.assertRaises(Exception):
                await self.manager.start_stage(request_id='a' * 32)
            other = UpdateManager(self.manager.root)
            with self.assertRaisesRegex(Exception, '进程'):
                other.configure({})
            release.set()
            await task
        self.assertIsNone(self.manager._normal_lease)


class FaultStream(httpx.AsyncByteStream):
    def __init__(self, data, failure=True, gate=None):
        self.data, self.failure, self.gate = data, failure, gate

    async def __aiter__(self):
        yield self.data
        if self.gate is not None:
            self.gate.set()
            await asyncio.Future()
        if self.failure:
            raise httpx.ReadError('simulated disconnect')


class WeakDownloadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.partial = Path(self.temp.name) / 'artifact.part'
        self.payload = b'x' * 65536 + b'y' * 65536
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.progress = []
        retry = mock.patch.object(download, 'RETRY_DELAYS', (0, 0, 0))
        retry.start()
        self.addCleanup(retry.stop)
        self.real_client = httpx.AsyncClient

    async def run_download(self, handler, url='https://fixture.invalid/artifact'):
        with mock.patch.object(download.httpx, 'AsyncClient', side_effect=lambda **kw: self.real_client(
                transport=httpx.MockTransport(handler), **kw)):
            return await download.download_http(url, self.partial, self.sha, len(self.payload), {},
                                                1024 * 1024, self.progress.append)

    async def test_disconnect_resumes_range_and_validates_complete_hash(self):
        requests = []
        def respond(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(200, headers={'content-length': str(len(self.payload))}, stream=FaultStream(self.payload[:65536]))
            return httpx.Response(206, headers={'content-range': 'bytes 65536-131071/131072'}, content=self.payload[65536:])
        size, digest = await self.run_download(respond)
        self.assertEqual(self.sha, digest)
        self.assertEqual(len(self.payload), size)
        self.assertEqual('bytes=65536-', requests[1].headers['range'])
        self.assertTrue(any(p.get('retryAttempt') == 1 for p in self.progress))

    async def test_ignored_range_restarts_without_appending_full_body(self):
        count = 0
        def respond(request):
            nonlocal count
            count += 1
            if count == 1:
                return httpx.Response(200, stream=FaultStream(self.payload[:65536]))
            self.assertEqual('bytes=65536-', request.headers['range'])
            return httpx.Response(200, content=self.payload)
        self.assertEqual((len(self.payload), self.sha), await self.run_download(respond))
        self.assertEqual(self.payload, self.partial.read_bytes())

    async def test_invalid_range_is_rejected(self):
        count = 0
        def respond(request):
            nonlocal count
            count += 1
            return (httpx.Response(200, stream=FaultStream(self.payload[:65536])) if count == 1 else
                    httpx.Response(206, headers={'content-range': 'bytes 0-65535/131072'}, content=self.payload[:65536]))
        with self.assertRaises(ValueError):
            await self.run_download(respond)
        self.assertEqual(2, count)

    async def test_retry_bound_preserves_partial_then_new_invocation_continues(self):
        count = 0
        def fail(request):
            nonlocal count
            count += 1
            if count == 1:
                return httpx.Response(200, stream=FaultStream(self.payload[:65536]))
            return httpx.Response(503)
        with self.assertRaises(download.DownloadInterrupted):
            await self.run_download(fail)
        self.assertEqual(4, count)
        self.assertEqual(65536, self.partial.stat().st_size)
        def resume(request):
            self.assertEqual('bytes=65536-', request.headers['range'])
            return httpx.Response(206, headers={'content-range': 'bytes 65536-131071/131072'}, content=self.payload[65536:])
        self.assertEqual(self.sha, (await self.run_download(resume))[1])

    async def test_cancel_keeps_partial_and_changed_source_does_not_reuse_it(self):
        ready = asyncio.Event()
        pending = asyncio.create_task(self.run_download(lambda _: httpx.Response(200, stream=FaultStream(self.payload[:65536], gate=ready))))
        await ready.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(65536, self.partial.stat().st_size)
        def changed(request):
            self.assertNotIn('range', request.headers)
            return httpx.Response(200, content=self.payload)
        await self.run_download(changed, url='https://fixture.invalid/another?token=not-a-secret')
        self.assertNotIn('token', self.partial.with_suffix('.part.json').read_text())

    async def test_416_restarts_and_complete_partial_is_reused(self):
        count = 0
        def respond(request):
            nonlocal count
            count += 1
            if count == 1:
                return httpx.Response(200, stream=FaultStream(self.payload[:65536]))
            if count == 2:
                return httpx.Response(416)
            self.assertNotIn('range', request.headers)
            return httpx.Response(200, content=self.payload)
        await self.run_download(respond)
        await self.run_download(lambda _: self.fail('complete partial should not use network'))
        self.assertEqual(3, count)

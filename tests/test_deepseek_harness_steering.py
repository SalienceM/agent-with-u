import asyncio
import threading
import unittest
from types import SimpleNamespace

from src.backend.deepseek_harness_steering import HarnessSteering


class HarnessSteeringTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_or_invalid_capability_never_writes(self):
        def request(*_args, **_options): self.fail('old bridge must not receive steering')
        steering, worker, identity = self.fixture(request)
        for capability in (None, {}, {'version': True, 'text': True, 'images': False}):
            steering.configure(identity, capability)
            self.assertEqual((await steering.send(worker, 'correction', 'id'))['status'], 'unsupported')

    def fixture(self, request):
        steering = HarnessSteering()
        identity = {'sessionId': 'native', 'generation': 'run', 'configFingerprint': 'config'}
        steering.configure(identity, {'version': 1, 'text': True, 'images': False})
        steering.observe_turn(1)
        return steering, SimpleNamespace(stop_requested=threading.Event(), client=SimpleNamespace(request=request)), identity

    async def test_lost_receipt_queries_once_and_never_replays(self):
        calls = []
        def request(method, params, **options):
            calls.append(method)
            if method == 'awu/steer': raise TimeoutError()
            return options['response_model'](**{**identity, 'requestId': 'id', 'status': 'accepted', 'turn': 1, 'messageId': 'real'})
        steering, worker, identity = self.fixture(request)
        self.assertEqual((await steering.send(worker, 'correction', 'id'))['status'], 'ok')
        self.assertEqual((await steering.send(worker, 'correction', 'id'))['status'], 'ok')
        self.assertEqual(calls, ['awu/steer', 'awu/steerStatus'])
        self.assertEqual((await steering.send(worker, 'different', 'id'))['status'], 'error')

    async def test_unknown_and_wrong_identity_never_become_rejected(self):
        for broken in (True, False):
            calls = []
            def request(method, params, **options):
                calls.append(method)
                if broken: raise TimeoutError()
                return options['response_model'](**{**identity, 'generation': 'other', 'requestId': 'id', 'status': 'accepted', 'turn': 1, 'messageId': 'real'})
            steering, worker, identity = self.fixture(request)
            self.assertEqual((await steering.send(worker, 'correction', 'id'))['status'], 'unknown')
            self.assertTrue(steering.finish())
            self.assertEqual(calls.count('awu/steer'), 1)

    async def test_pending_request_owns_lifetime_and_cancellation_does_not_replay(self):
        started, release = threading.Event(), threading.Event()
        def request(method, params, **options):
            started.set()
            release.wait(3)
            return options['response_model'](**{**identity, 'requestId': 'id', 'status': 'accepted', 'turn': 1, 'messageId': 'real'})
        steering, worker, identity = self.fixture(request)
        task = asyncio.create_task(steering.send(worker, 'correction', 'id'))
        self.assertTrue(await asyncio.to_thread(started.wait, 2))
        self.assertFalse(steering.finish())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        release.set()
        self.assertEqual((await steering.send(worker, 'correction', 'id'))['status'], 'ok')
        self.assertTrue(steering.finish())
        self.assertEqual((await steering.send(worker, 'late', 'late'))['status'], 'turn_finished')

    async def test_consecutive_steers_preserve_codex_fifo_and_recheck_stop(self):
        for stop in (False, True):
            with self.subTest(stop=stop):
                calls = []
                started, release = threading.Event(), threading.Event()
                def request(method, params, **options):
                    calls.append(params['requestId'])
                    if params['requestId'] == 'first':
                        started.set()
                        release.wait(3)
                    return options['response_model'](**{**identity, 'requestId': params['requestId'],
                        'status': 'accepted', 'turn': 1, 'messageId': 'native-' + params['requestId']})
                steering, worker, identity = self.fixture(request)
                first = asyncio.create_task(steering.send(worker, 'first correction', 'first'))
                second = None
                try:
                    self.assertTrue(await asyncio.to_thread(started.wait, 2))
                    second = asyncio.create_task(steering.send(worker, 'second correction', 'second'))
                    for _ in range(4): await asyncio.sleep(0)
                    self.assertEqual(steering.pending, 2)
                    self.assertFalse(steering.finish())
                    self.assertEqual(calls, ['first'])
                    if stop: worker.stop_requested.set()
                    release.set()
                    self.assertEqual((await first)['status'], 'ok')
                    self.assertEqual((await second)['status'], 'turn_finished' if stop else 'ok')
                    self.assertEqual(calls, ['first'] if stop else ['first', 'second'])
                    self.assertTrue(steering.finish())
                finally:
                    release.set()
                    await asyncio.gather(*[t for t in (first, second) if t], return_exceptions=True)

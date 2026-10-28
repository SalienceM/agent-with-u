"""归属、同步 SDK 接缝和 asyncio 生命周期的隔离测试。"""
from __future__ import annotations

import asyncio
import importlib.metadata
import os
import queue
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from src.backend.deepseek_harness_sdk import MAX_NOTIFICATIONS, SyncOwner, create_client
from src.backend.deepseek_harness_state import HarnessLayout
from src.backend.deepseek_harness_worker import HarnessWorker, active_worker

try:
    HAS_SDK = importlib.metadata.version("deepseek-harness-sdk") == "0.2.1rc3"
except importlib.metadata.PackageNotFoundError:
    HAS_SDK = False


class WorkerLifetimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-worker-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.layout = HarnessLayout.for_session(owner="fake-owner", executor="fake-node", backend="dsh", session="sid")

    async def test_parallel_children_keep_parent_activity_and_stop_only_target(self) -> None:
        from src.backend.deepseek_harness_worker import session_has_activity
        from src.backend.deepseek_harness import DeepSeekHarnessBackend
        from src.types import BackendType, ModelBackendConfig
        gates = [threading.Event(), threading.Event()]
        entered = [threading.Event(), threading.Event()]
        workers = []
        backend = DeepSeekHarnessBackend(ModelBackendConfig("dsh", BackendType.DEEPSEEK_HARNESS, "test"))
        backend._harness_workers = {}
        for index in (0, 1):
            layout = HarnessLayout.for_session(owner="fake-owner", executor="fake-node", backend="dsh", session=f"sid:child{index}")
            worker = HarnessWorker(layout, uuid.uuid4().hex, activity_parent="sid", ephemeral=True)
            def work(_worker, _publish, index=index):
                entered[index].set()
                gates[index].wait(5)
            workers.append(worker)
            backend._harness_workers[layout.session] = worker
            worker.start(work)
        try:
            while not all(event.is_set() for event in entered):
                await asyncio.sleep(.01)
            backend.abort("sid:child0")
            self.assertTrue(workers[0].stop_requested.is_set())
            self.assertFalse(workers[1].stop_requested.is_set())
            check = lambda: session_has_activity(owner="fake-owner", executor="fake-node", session="sid")
            self.assertTrue(check())
            gates[0].set()
            await asyncio.shield(workers[0].task)
            self.assertFalse(workers[0].layout.root.exists())
            self.assertTrue(check())
            gates[1].set()
            await asyncio.shield(workers[1].task)
            self.assertFalse(check())
        finally:
            for gate in gates:
                gate.set()
            await asyncio.gather(*(worker.task for worker in workers), return_exceptions=True)

    async def test_worker_cancellation_does_not_release_until_actual_worker_exits(self) -> None:
        gate = threading.Event()
        entered = threading.Event()
        worker = HarnessWorker(self.layout, uuid.uuid4().hex)
        def work(_worker, publish):
            entered.set()
            gate.wait(timeout=3)
            return "done"
        worker.start(work)
        consumer = asyncio.create_task(worker.consume(lambda _event: None))
        ticks = 0
        while not entered.is_set():
            await asyncio.sleep(.01)
            ticks += 1
        await asyncio.sleep(.05)
        consumer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await consumer
        self.assertIs(active_worker(self.layout), worker)
        self.assertTrue(self.layout.activity_file.exists())
        with self.assertRaisesRegex(RuntimeError, "不可重入"):
            HarnessWorker(self.layout, uuid.uuid4().hex).start(work)
        gate.set()
        await asyncio.wait_for(asyncio.shield(worker.task), 2)
        self.assertIsNone(active_worker(self.layout))
        self.assertFalse(self.layout.activity_file.exists())
        self.assertGreater(ticks, 0)

    async def test_bounded_bridge_delivers_on_event_loop_not_sdk_worker(self) -> None:
        loop_thread = threading.get_ident()
        worker = HarnessWorker(self.layout, uuid.uuid4().hex)
        threads = []
        def work(_worker, publish):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            for index in range(200):
                publish(index)
            return "done"
        worker.start(work)
        value = await worker.consume(lambda _event: threads.append(threading.get_ident()))
        self.assertEqual(value, "done")
        self.assertEqual(threads, [loop_thread] * 200)
        self.assertEqual(worker.events.maxsize, 128)

    async def test_unconfirmed_exit_retains_registry_and_persistent_lock(self) -> None:
        from src.backend.deepseek_harness_worker import _ACTIVE, _REGISTRY_LOCK
        worker = HarnessWorker(self.layout, uuid.uuid4().hex)
        def work(owned, _publish):
            owned.owner.spawn_attempted = True  # fake 不产生实际进程，但模拟缺失退出证据。
            return "partial"
        worker.start(work)
        try:
            with self.assertRaisesRegex(RuntimeError, "退出未确认"):
                await worker.consume(lambda _event: None)
            self.assertIs(active_worker(self.layout), worker)
            self.assertTrue(self.layout.activity_file.exists())
            self.assertIsNotNone(worker.reservation.handle)
        finally:
            # 仅测试夹具的人工收尾；产品没有自动解锁此分支。
            worker.reservation.release(confirmed=True)
            with _REGISTRY_LOCK:
                _ACTIVE.pop(worker.key, None)

    async def test_backpressure_is_bounded_failure_not_silent_event_loss(self) -> None:
        worker = HarnessWorker(self.layout, uuid.uuid4().hex)
        def work(_worker, publish):
            for index in range(1000):
                publish(index)
        worker.start(work)
        with self.assertRaisesRegex(RuntimeError, "背压"):
            await asyncio.wait_for(asyncio.shield(worker.task), timeout=4)
        self.assertEqual(worker.events.qsize(), 128)
        self.assertIsNone(active_worker(self.layout))


@unittest.skipUnless(HAS_SDK, "Install locked SDK/runtime in isolated test environment")
class OwnedSdkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-owned-sdk-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.owner = SyncOwner(generation=uuid.uuid4().hex, receipt=self.root / "exit.json")

    def client(self, scenario: str = "normal"):
        from deepseek_harness.client import HarnessConfig
        fixture = Path(__file__).parent / "fixtures/deepseek_harness_runtime.py"
        client = create_client(config=HarnessConfig(cwd=str(self.root), dsh_home=str(self.root / "home"),
                                                   initialize_timeout_seconds=2, request_timeout_seconds=2),
                               owner=self.owner, launch_args=(sys.executable, "-u", str(fixture.resolve()),
                                   "--state", str(self.root / "state.json"), "--scenario", scenario))
        self.addCleanup(client.close)
        return client

    def test_sdk_uses_single_reader_job_before_resume_and_closes_all_pipes(self) -> None:
        client = self.client()
        client.start()
        if os.name == "nt":
            self.assertTrue(self.owner.tree.job)
            self.assertTrue(self.owner.tree.complete)
        client.initialize(cwd=str(self.root), provider="deepseek-official", model="fake")
        proc = self.owner.process
        client.close()
        self.assertTrue(self.owner.confirmed)
        self.assertIsNotNone(proc.returncode)
        self.assertTrue(all(stream.closed for stream in (proc.stdin, proc.stdout, proc.stderr)))
        self.assertFalse(client._reader_thread.is_alive())
        self.assertFalse(client._stderr_thread.is_alive())

    def test_oversize_and_queue_overflow_fail_closed(self) -> None:
        for scenario in ("oversize", "flood"):
            with self.subTest(scenario=scenario):
                self.owner = SyncOwner(generation=uuid.uuid4().hex, receipt=self.root / (scenario + ".json"))
                client = self.client(scenario)
                client.start()
                try:
                    client.initialize(cwd=str(self.root), provider="deepseek-official", model="fake")
                except RuntimeError:
                    pass
                deadline = time.monotonic() + 2
                while client.fatal is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertIsNotNone(client.fatal)
                self.assertLessEqual(client._notifications.qsize(), MAX_NOTIFICATIONS)
                client.close()
                self.assertTrue(self.owner.confirmed, f"exit={self.owner.process.returncode}, receipt={self.owner.receipt.exists()}, reader={client._reader_thread.is_alive()}, stderr={client._stderr_thread.is_alive()}")

    def test_owned_tree_cleanup_includes_detached_shell_child(self) -> None:
        client = self.client("tree")
        client.start()
        client.initialize(cwd=str(self.root), provider="deepseek-official", model="fake")
        child = int((self.root / "state.child").read_text())
        self.assertNotEqual(child, self.owner.process.pid)
        self.owner.terminate()
        client.close()
        self.assertTrue(self.owner.confirmed, f"exit={self.owner.process.returncode}, receipt={self.owner.receipt.exists()}, reader={client._reader_thread.is_alive()}, stderr={client._stderr_thread.is_alive()}")
        if sys.platform == "linux":
            self.assertFalse(Path(f"/proc/{child}").exists(), "subreaper must reap detached descendants")

    def test_pre_spawn_cancel_starts_no_process(self) -> None:
        self.owner.terminate()
        client = self.client()
        with self.assertRaisesRegex(RuntimeError, "启动前已取消"):
            client.start()
        self.assertIsNone(self.owner.process)
        self.assertTrue(self.owner.confirmed)

    def test_two_process_trees_stopping_one_does_not_stop_the_other(self) -> None:
        first = self.client("tree")
        first.start()
        first.initialize(cwd=str(self.root), provider="deepseek-official", model="fake")
        first_owner = self.owner
        self.owner = SyncOwner(generation=uuid.uuid4().hex, receipt=self.root / "second-exit.json")
        second = self.client("tree")
        try:
            second.start()
            second.initialize(cwd=str(self.root), provider="deepseek-official", model="fake")
            first_owner.terminate()
            first.close()
            self.assertTrue(first_owner.confirmed)
            self.assertIsNone(self.owner.process.poll())
            # Second reader/server still responds, not merely a surviving PID.
            self.assertTrue(second.session_prompt("other-native", [{"type": "text", "text": "still alive"}]))
        finally:
            second.close()
            first.close()
        self.assertTrue(self.owner.confirmed)


if __name__ == "__main__":
    unittest.main()

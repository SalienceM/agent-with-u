"""用明确安装的 rc.3 SDK 测试协议，缺失时 skip，不伪造真实 runtime 验收。"""
from __future__ import annotations

import asyncio
import importlib.metadata
import sys
import tempfile
import time
import unittest
from pathlib import Path

try:
    SDK_VERSION = importlib.metadata.version("deepseek-harness-sdk")
except importlib.metadata.PackageNotFoundError:
    SDK_VERSION = None


@unittest.skipUnless(SDK_VERSION == "0.2.1rc3", "Install locked SDK wheel in isolated test environment")
class HarnessSdkContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="awu-dsh-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def harness(self, scenario: str = "normal"):
        from deepseek_harness import DeepSeekHarness
        fixture = Path(__file__).parent / "fixtures" / "deepseek_harness_runtime.py"
        return DeepSeekHarness(
            cwd=str(self.root), dsh_home=str(self.root / "home"),
            initialize_timeout_seconds=2, request_timeout_seconds=2, shutdown_timeout_seconds=0.2,
            _launch_args=(sys.executable, "-u", str(fixture), "--state", str(self.root / "state.json"),
                          "--scenario", scenario),
        )

    async def test_receipt_events_wait_and_real_cross_process_resume(self) -> None:
        from pydantic import BaseModel
        class Empty(BaseModel):
            pass

        def first_run() -> None:
            with self.harness() as harness:
                result = harness.run("one", session_id="owned-session")
                self.assertEqual(result.final_response, "reply-1")
                self.assertEqual(result.finish_reason, "completed")
                self.assertEqual(result.events[0]["type"], "agent/inbox/spliced")
                harness.client.request("session/wait", {"sessionId": "owned-session"}, response_model=Empty)

        await asyncio.to_thread(first_run)
        def resumed_run() -> None:
            with self.harness() as harness:
                session = harness.resume_session("owned-session")
                self.assertEqual(session.run("two").final_response, "reply-2")
        await asyncio.to_thread(resumed_run)

    async def test_resume_missing_fails_without_replacement(self) -> None:
        from deepseek_harness.errors import JsonRpcError
        def run() -> None:
            with self.harness() as harness, self.assertRaises(JsonRpcError):
                harness.resume_session("missing")
            self.assertFalse((self.root / "state.json").exists())
        await asyncio.to_thread(run)

    async def test_missing_end_reason_and_midrun_exit_are_not_success(self) -> None:
        from deepseek_harness.errors import SdkProtocolError, TransportClosedError
        def run(scenario: str, error_type: type[Exception]) -> None:
            with self.harness(scenario) as harness, self.assertRaises(error_type):
                harness.run("one", session_id="owned-session")
        await asyncio.to_thread(run, "malformed-end", SdkProtocolError)
        await asyncio.to_thread(run, "crash", TransportClosedError)

    async def test_sdk_callback_runs_on_owned_worker_without_blocking_event_loop(self) -> None:
        import threading
        callbacks: list[int] = []
        worker_ids: list[int] = []
        def run() -> None:
            worker_ids.append(threading.get_ident())
            with self.harness("slow") as harness:
                harness.run("one", session_id="owned-session",
                            on_notification=lambda _notification: callbacks.append(threading.get_ident()))
        worker = asyncio.create_task(asyncio.to_thread(run))
        ticks = 0
        deadline = time.monotonic() + 5
        while not worker.done() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            ticks += 1
        await asyncio.wait_for(worker, timeout=1)
        self.assertGreaterEqual(ticks, 5)
        self.assertTrue(callbacks)
        self.assertEqual(set(callbacks), set(worker_ids))


if __name__ == "__main__":
    unittest.main()

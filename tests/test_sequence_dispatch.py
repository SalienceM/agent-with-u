import asyncio
import json
import unittest

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatExtras, SeqTask


class SequenceDispatchGuardTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _bridge_with_task() -> tuple[BridgeWS, ChatExtras]:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._chat_turn_tasks = {}
        bridge._seq_dispatch_reservations = {}
        extras = ChatExtras(
            session_id="session-1",
            seq_tasks=[SeqTask(id="task-1", text="next question")],
        )
        bridge._chat_extras_get = lambda _sid: extras
        bridge._chat_extras_save = lambda _extras: None
        bridge._emit_seqtask_updated = lambda _extras: None
        return bridge, extras

    async def test_running_turn_keeps_queue_item_pending(self) -> None:
        bridge, extras = self._bridge_with_task()
        blocker = asyncio.Event()
        running = asyncio.create_task(blocker.wait())
        bridge._chat_turn_tasks["session-1"] = {running}

        result = json.loads(bridge._rpc_seqtaskTakeNext("session-1"))

        self.assertEqual(result["status"], "busy")
        self.assertIsNone(result["task"])
        self.assertEqual(extras.seq_tasks[0].status, "pending")
        blocker.set()
        await running

    async def test_take_next_reserves_dispatch_window(self) -> None:
        bridge, extras = self._bridge_with_task()

        first = json.loads(bridge._rpc_seqtaskTakeNext("session-1"))
        second = json.loads(bridge._rpc_seqtaskTakeNext("session-1"))
        state = json.loads(bridge._rpc_getSessionRunState("session-1"))

        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["task"]["id"], "task-1")
        self.assertEqual(extras.seq_tasks[0].status, "sent")
        self.assertEqual(second["status"], "busy")
        self.assertTrue(state["busy"])
        self.assertTrue(state["dispatchReserved"])

    async def test_send_message_tracks_real_task_lifetime(self) -> None:
        bridge, _extras = self._bridge_with_task()
        started = asyncio.Event()
        release = asyncio.Event()

        async def handle(_payload: str) -> None:
            started.set()
            await release.wait()

        bridge._handle_send_message = handle
        bridge._rpc_sendMessage(json.dumps({
            "sessionId": "session-1",
            "messageId": "message-1",
            "content": "hello",
            "backendId": "backend-1",
        }))

        await started.wait()
        self.assertTrue(json.loads(bridge._rpc_getSessionRunState("session-1"))["busy"])

        release.set()
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertFalse(json.loads(bridge._rpc_getSessionRunState("session-1"))["busy"])


if __name__ == "__main__":
    unittest.main()

import json
import unittest
from unittest.mock import Mock

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatAside, ChatExtras, SeqTask
from src.backend.loop_store import AsideTurn, LoopState


class BtwClearTests(unittest.TestCase):
    def test_chat_btw_clear_preserves_backend_and_sequence_tasks(self) -> None:
        extras = ChatExtras(
            session_id="chat-1",
            seq_tasks=[SeqTask(id="task-1", text="keep me")],
            asides=[ChatAside(id="aside-1", question="q", answer="a", status="done")],
            aside_backend_id="reviewer",
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._chat_aside_running = set()
        bridge._chat_extras_get = Mock(return_value=extras)
        bridge._chat_extras_save = Mock()
        bridge._emit_chat_aside_updated = Mock()

        result = json.loads(bridge._rpc_chatAsideClear("chat-1"))

        self.assertEqual("ok", result["status"])
        self.assertEqual(1, result["cleared"])
        self.assertEqual([], extras.asides)
        self.assertEqual("reviewer", extras.aside_backend_id)
        self.assertEqual(["task-1"], [item.id for item in extras.seq_tasks])
        bridge._chat_extras_save.assert_called_once_with(extras)
        bridge._emit_chat_aside_updated.assert_called_once_with(extras)

    def test_chat_btw_clear_refuses_while_answering(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._chat_aside_running = {"chat-1"}
        bridge._chat_extras_get = Mock()

        result = json.loads(bridge._rpc_chatAsideClear("chat-1"))

        self.assertEqual("error", result["status"])
        bridge._chat_extras_get.assert_not_called()

    def test_loop_btw_clear_preserves_loop_state(self) -> None:
        state = LoopState(
            session_id="loop-1",
            goal="keep goal",
            asides=[AsideTurn(id="aside-1", question="q", answer="a", status="done")],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._aside_running = set()
        bridge._loop_state = Mock(return_value=state)
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()

        result = json.loads(bridge._rpc_loopAsideClear("loop-1"))

        self.assertEqual("ok", result["status"])
        self.assertEqual(1, result["cleared"])
        self.assertEqual([], state.asides)
        self.assertEqual("keep goal", state.goal)
        bridge._loop_save.assert_called_once_with(state)
        bridge._emit_loop_updated.assert_called_once_with(state)

    def test_loop_btw_clear_refuses_while_answering(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._aside_running = {"loop-1"}
        bridge._loop_state = Mock()

        result = json.loads(bridge._rpc_loopAsideClear("loop-1"))

        self.assertEqual("error", result["status"])
        bridge._loop_state.assert_not_called()


if __name__ == "__main__":
    unittest.main()

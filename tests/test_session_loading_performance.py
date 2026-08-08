import json
import time
import unittest
from types import SimpleNamespace

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopRecord, LoopState, LoopStep, STAGE_EXECUTE
from src.types import ChatMessage, ImageAttachment, Session, ToolCallInfo


class _ExplodingMessage:
    def to_dict(self):
        raise AssertionError("分页首屏不应序列化未选中的旧消息")


class SessionLoadingPerformanceTests(unittest.TestCase):
    @staticmethod
    def _session() -> Session:
        return Session(
            id="fast-session", title="Fast", created_at=time.time(), updated_at=time.time(),
            messages=[_ExplodingMessage(), ChatMessage(id="latest", role="user", content="latest")],
            working_dir=".", backend_id="backend", session_type="loop",
            loop_control_mode="manual",
        )

    def test_initial_session_page_serializes_only_requested_tail(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = self._session()
        bridge._active_sessions = {session.id: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)

        payload = json.loads(bridge._rpc_loadSession(session.id, 1))

        self.assertEqual([item["id"] for item in payload["messages"]], ["latest"])
        self.assertEqual(payload["messagesTotal"], 2)
        self.assertTrue(payload["hasMore"])

    def test_message_page_slices_before_serialization(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = self._session()
        bridge._active_sessions = {session.id: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)

        payload = json.loads(bridge._rpc_loadSessionMessages(session.id, 1, 1))

        self.assertEqual([item["id"] for item in payload["messages"]], ["latest"])
        self.assertEqual(payload["total"], 2)

    def test_session_meta_uses_indexes_without_loading_session_or_stage(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._session_store = SimpleNamespace(
            get_meta=lambda _sid: {
                "id": "fast-session", "sessionType": "loop", "loopControlMode": None,
            },
        )
        bridge._loop_store = SimpleNamespace(load_meta=lambda _sid: {
            "controlMode": "manual", "stage": STAGE_EXECUTE,
        })
        bridge._loop_running = {"fast-session"}
        bridge._loop_tasks = {}

        payload = json.loads(bridge._rpc_loadSessionMeta("fast-session"))

        self.assertEqual(payload["loopControlMode"], "manual")
        self.assertEqual(payload["loopStage"], STAGE_EXECUTE)
        self.assertTrue(payload["loopRunning"])

    def test_compact_loop_payload_defers_large_record_details(self):
        huge = "x" * 1_000_000
        record = LoopRecord(
            seq=1, kind="manual", round=1, completed=True,
            result=huge,
            orchestration=[LoopStep(index=1, desc="step", status="done", output=huge)],
            manual_messages=[{
                "id": "m1", "role": "assistant", "content": "done",
                "toolCalls": [{"name": "shell", "output": huge}],
            }],
            manual_context=huge,
        )
        state = LoopState(
            session_id="loop-compact", stage=STAGE_EXECUTE,
            control_mode="loop", loops=[record],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_running = set()
        bridge._loop_tasks = {}
        bridge._loop_states = {state.session_id: state}

        compact = bridge._loop_payload(state, compact=True)
        serialized = json.dumps(compact)

        self.assertLess(len(serialized), 20_000)
        self.assertEqual(compact["loops"][0]["manualMessages"], [])
        self.assertEqual(compact["loops"][0]["orchestration"][0]["output"], "")
        self.assertFalse(compact["loops"][0]["detailLoaded"])

        detail = json.loads(bridge._rpc_loopGetRecord(state.session_id, 1))
        self.assertEqual(detail["status"], "ok")
        self.assertEqual(len(detail["record"]["manualContext"]), len(huge))
        self.assertTrue(detail["record"]["detailLoaded"])

    def test_manual_loop_snapshot_does_not_duplicate_base64_or_unbounded_tool_output(self):
        huge = "x" * 1_000_000
        message = ChatMessage(
            id="assistant", role="assistant", content="done",
            images=[ImageAttachment(id="img", base64=huge)],
            tool_calls=[ToolCallInfo(name="shell", output=huge, input=huge)],
        )

        payload = BridgeWS._manual_message_payload(message)
        serialized = json.dumps(payload)

        self.assertNotIn("base64", serialized)
        self.assertEqual(payload["imageCount"], 1)
        self.assertLessEqual(len(payload["toolCalls"][0]["input"]), 8_000)
        self.assertLessEqual(len(payload["toolCalls"][0]["output"]), 12_000)
        self.assertLess(len(serialized), 25_000)


if __name__ == "__main__":
    unittest.main()

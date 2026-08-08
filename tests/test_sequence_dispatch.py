import asyncio
import json
import unittest

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatExtras, SeqTask
from src.types import ChatMessage, Session


class _FollowUpBackend:
    def __init__(
        self, *, native=False, redirect=False, events=None,
        steer_result=None, steer_started=None, steer_release=None,
    ):
        self.native = native
        self.redirect = redirect
        self.events = events if events is not None else []
        self.steer_result = steer_result or {"status": "ok"}
        self.steer_started = steer_started
        self.steer_release = steer_release

    def follow_up_capabilities(self):
        return {
            "queue": True, "nativeSteer": self.native,
            "interruptResume": self.redirect, "steerAttachments": self.native,
        }

    async def steer_message(self, **kwargs):
        self.events.append(("steer", kwargs))
        if self.steer_started:
            self.steer_started.set()
        if self.steer_release:
            await self.steer_release.wait()
        return self.steer_result

    def abort(self, session_id):
        self.events.append(("abort", session_id))


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

    async def test_take_next_skips_task_being_steered(self) -> None:
        bridge, extras = self._bridge_with_task()
        extras.seq_tasks[0].status = "steering"
        extras.seq_tasks.append(SeqTask(id="task-2", text="ordinary queued message"))

        result = json.loads(bridge._rpc_seqtaskTakeNext("session-1"))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["task"]["id"], "task-2")
        self.assertEqual(extras.seq_tasks[0].status, "steering")

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

    async def test_redirect_is_persisted_at_queue_head_before_abort(self) -> None:
        bridge, extras = self._bridge_with_task()
        events = []
        backend = _FollowUpBackend(redirect=True, events=events)
        bridge._active_sessions = {
            "session-1": Session(
                id="session-1", title="s", created_at=1, updated_at=1,
                messages=[], working_dir=".", backend_id="qwen",
            ),
        }
        bridge._get_backend = lambda _backend_id: backend
        bridge._chat_extras_save = lambda _extras: events.append(("save", _extras.seq_tasks[0].id))
        bridge._emit_seqtask_updated = lambda _extras: events.append(("emit", _extras.seq_tasks[0].id))
        blocker = asyncio.Event()
        running = asyncio.create_task(blocker.wait())
        bridge._chat_turn_tasks["session-1"] = {running}

        result = json.loads(bridge._rpc_redirectMessage("session-1", "change direction"))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(extras.seq_tasks[0].delivery_mode, "redirect")
        self.assertEqual(extras.seq_tasks[0].text, "change direction")
        self.assertEqual([event[0] for event in events], ["save", "emit", "abort"])
        blocker.set()
        await running

    async def test_native_steer_inserts_visible_message_before_active_assistant(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        events = []
        backend = _FollowUpBackend(native=True, events=events)
        session = Session(
            id="session-1", title="s", created_at=1, updated_at=1,
            messages=[
                ChatMessage(id="user-1", role="user", content="start"),
                ChatMessage(id="assistant-1", role="assistant", content="partial", streaming=True),
            ],
            working_dir=".", backend_id="codex",
        )
        bridge._active_sessions = {"session-1": session}
        bridge._chat_turn_tasks = {}
        bridge._seq_dispatch_reservations = {}
        bridge._get_backend = lambda _backend_id: backend
        bridge._build_session_reference_context = lambda text, _sid: text
        bridge._session_store = type("Store", (), {"save": lambda _self, *_args, **_kwargs: None})()
        bridge._emit_session_updated = events.append
        blocker = asyncio.Event()
        running = asyncio.create_task(blocker.wait())
        bridge._chat_turn_tasks["session-1"] = {running}

        result = json.loads(await bridge._rpc_steerMessage(
            "session-1", "focus on tests", "", "", "follow-1",
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual([message.id for message in session.messages], [
            "user-1", "follow-1", "assistant-1",
        ])
        self.assertEqual(session.messages[1].delivery_mode, "steer")
        follow_event = next(event for event in events if isinstance(event, dict))
        self.assertEqual(follow_event["beforeMessageId"], "assistant-1")
        blocker.set()
        await running

    @staticmethod
    def _configure_seq_steer_bridge(
        bridge: BridgeWS,
        backend: _FollowUpBackend,
        extras: ChatExtras,
        events: list,
    ) -> Session:
        session = Session(
            id="session-1", title="s", created_at=1, updated_at=1,
            messages=[
                ChatMessage(id="user-1", role="user", content="start"),
                ChatMessage(id="assistant-1", role="assistant", content="partial", streaming=True),
            ],
            working_dir=".", backend_id="codex",
        )
        bridge._active_sessions = {"session-1": session}
        bridge._get_backend = lambda _backend_id: backend
        bridge._build_session_reference_context = lambda text, _sid: text
        bridge._session_store = type(
            "Store", (), {"save": lambda _self, *_args, **_kwargs: None},
        )()
        bridge._emit_session_updated = lambda data: events.append(("session", data))
        bridge._chat_extras_save = lambda state: events.append(
            ("save", [(task.id, task.status) for task in state.seq_tasks]),
        )
        bridge._emit_seqtask_updated = lambda state: events.append(
            ("seq", [(task.id, task.status) for task in state.seq_tasks]),
        )
        bridge._chat_extras_get = lambda _sid: extras
        return session

    async def test_seq_task_is_leased_then_removed_after_native_steer(self) -> None:
        bridge, extras = self._bridge_with_task()
        events = []
        steer_started = asyncio.Event()
        steer_release = asyncio.Event()
        backend = _FollowUpBackend(
            native=True, events=events,
            steer_started=steer_started, steer_release=steer_release,
        )
        session = self._configure_seq_steer_bridge(bridge, backend, extras, events)
        turn_release = asyncio.Event()
        running = asyncio.create_task(turn_release.wait())
        bridge._chat_turn_tasks["session-1"] = {running}

        conversion = asyncio.create_task(
            bridge._rpc_steerSeqTask("session-1", "task-1"),
        )
        await steer_started.wait()

        self.assertEqual(extras.seq_tasks[0].status, "steering")
        self.assertIn(("save", [("task-1", "steering")]), events)

        steer_release.set()
        result = json.loads(await conversion)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(extras.seq_tasks, [])
        self.assertEqual(session.messages[1].delivery_mode, "steer")

        turn_release.set()
        await running
        self.assertIsNone(json.loads(bridge._rpc_seqtaskTakeNext("session-1"))["task"])

    async def test_failed_seq_steer_restores_pending_task(self) -> None:
        bridge, extras = self._bridge_with_task()
        events = []
        backend = _FollowUpBackend(
            native=True, events=events,
            steer_result={"status": "error", "message": "steer rejected"},
        )
        self._configure_seq_steer_bridge(bridge, backend, extras, events)
        turn_release = asyncio.Event()
        running = asyncio.create_task(turn_release.wait())
        bridge._chat_turn_tasks["session-1"] = {running}

        result = json.loads(await bridge._rpc_steerSeqTask("session-1", "task-1"))

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["message"], "steer rejected")
        self.assertEqual(len(extras.seq_tasks), 1)
        self.assertEqual(extras.seq_tasks[0].status, "pending")
        self.assertIn(("save", [("task-1", "steering")]), events)
        self.assertIn(("save", [("task-1", "pending")]), events)
        turn_release.set()
        await running

    def test_persisted_steering_lease_recovers_as_pending(self) -> None:
        restored = SeqTask.from_dict({
            "id": "task-1", "text": "retry me", "status": "steering",
        })
        self.assertEqual(restored.status, "pending")


if __name__ == "__main__":
    unittest.main()

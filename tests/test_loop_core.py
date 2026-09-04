import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.loop_store import LoopRecord, LoopState, LoopStep, LoopStore
from src.backend.model_ledger import ModelLedger


class LoopCoreTests(unittest.TestCase):
    def test_legacy_concurrent_step_defaults_to_write(self):
        step = LoopStep.from_dict({"index": 1, "mode": "concurrent", "desc": "edit files"})
        self.assertEqual(step.access, "write")

    def test_read_access_round_trips(self):
        step = LoopStep(index=1, mode="concurrent", access="read", desc="inspect")
        self.assertEqual(LoopStep.from_dict(step.to_dict()).access, "read")

    def test_loop_step_recovery_metadata_round_trips(self):
        step = LoopStep(
            index=2,
            desc="verify",
            attempts=2,
            recovery_notes=["第一次无活动，已自动恢复"],
        )
        restored = LoopStep.from_dict(step.to_dict())
        self.assertEqual(restored.attempts, 2)
        self.assertEqual(restored.recovery_notes, ["第一次无活动，已自动恢复"])

    def test_manual_takeover_state_and_transcript_round_trip(self):
        record = LoopRecord(
            seq=2,
            kind="manual",
            goal="人工接管",
            manual_start_index=4,
            manual_messages=[{
                "id": "m1", "role": "assistant", "content": "done",
                "toolCalls": [{"name": "shell", "status": "done"}],
            }],
        )
        state = LoopState(session_id="session-manual", control_mode="manual", loops=[record])

        restored = LoopState.from_dict(state.to_dict())

        self.assertEqual(restored.control_mode, "manual")
        self.assertEqual(restored.loops[0].kind, "manual")
        self.assertEqual(restored.loops[0].manual_start_index, 4)
        self.assertEqual(restored.loops[0].manual_messages[0]["toolCalls"][0]["name"], "shell")

    def test_legacy_loop_state_defaults_to_automated_control(self):
        restored = LoopState.from_dict({"sessionId": "legacy", "loops": [{"seq": 1}]})
        self.assertEqual(restored.control_mode, "loop")
        self.assertEqual(restored.loops[0].kind, "agent")

    def test_loop_store_uses_atomic_replace_and_leaves_no_temp_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("src.backend.loop_store.paths.sub", return_value=root):
                store = LoopStore()
                state = LoopState(session_id="session-1", goal="first")
                store.save(state)
                state.goal = "second"
                store.save(state)
                self.assertEqual(store.load("session-1").goal, "second")
                self.assertFalse((root / "session-1.json.tmp").exists())

    def test_loop_store_keeps_lightweight_control_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("src.backend.loop_store.paths.sub", return_value=root):
                store = LoopStore()
                state = LoopState(
                    session_id="manual-session", stage="loopexecute",
                    control_mode="manual", round=3,
                )
                store.save(state)

                meta = store.load_meta("manual-session")

                self.assertEqual(meta["controlMode"], "manual")
                self.assertEqual(meta["stage"], "loopexecute")
                self.assertEqual(meta["round"], 3)
                self.assertLess((root / "manual-session.meta.json").stat().st_size, 1_000)

    def test_model_ledger_reports_success_duration_and_task_mix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("src.backend.model_ledger.paths.sub", return_value=root):
                ledger = ModelLedger()
                ledger.record("b1", "Backend", "execute", score=80, success=True,
                              duration_ms=1200, task_type="coding")
                role = ledger.list()[0]["roles"]["execute"]
                self.assertEqual(role["successRate"], 1.0)
                self.assertEqual(role["avgDurationMs"], 1200)
                self.assertEqual(role["taskTypes"], {"coding": 1})


if __name__ == "__main__":
    unittest.main()

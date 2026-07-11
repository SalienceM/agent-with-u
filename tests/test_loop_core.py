import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.loop_store import LoopState, LoopStep, LoopStore
from src.backend.model_ledger import ModelLedger


class LoopCoreTests(unittest.TestCase):
    def test_legacy_concurrent_step_defaults_to_write(self):
        step = LoopStep.from_dict({"index": 1, "mode": "concurrent", "desc": "edit files"})
        self.assertEqual(step.access, "write")

    def test_read_access_round_trips(self):
        step = LoopStep(index=1, mode="concurrent", access="read", desc="inspect")
        self.assertEqual(LoopStep.from_dict(step.to_dict()).access, "read")

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

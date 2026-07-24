import unittest

from src.backend.loop_store import LoopPolicy, LoopRecord
from src.types import Session


class RuntimeProfileTests(unittest.TestCase):
    def test_session_runtime_round_trip(self):
        session = Session(
            id="s1", title="runtime", created_at=1, updated_at=1,
            messages=[], working_dir=".", backend_id="official-codex",
            model_override="gpt-5.6-terra", reasoning_effort="medium",
        )
        payload = session.to_dict()
        self.assertEqual(payload["modelOverride"], "gpt-5.6-terra")
        self.assertEqual(payload["reasoningEffort"], "medium")
        self.assertEqual(session.meta_dict()["reasoningEffort"], "medium")

    def test_loop_roles_inherit_execute_runtime_and_override_analysis(self):
        policy = LoopPolicy.from_dict({
            "runtimes": {
                "execute": {"model": "gpt-5.6-terra", "reasoningEffort": "medium"},
                "analysis": {"model": "gpt-5.6-sol", "reasoningEffort": "xhigh"},
            },
        })
        self.assertEqual(policy.runtime_for("execute"), {
            "model": "gpt-5.6-terra", "reasoningEffort": "medium",
        })
        self.assertEqual(policy.runtime_for("idea"), {
            "model": "gpt-5.6-terra", "reasoningEffort": "medium",
        })
        self.assertEqual(policy.runtime_for("analysis"), {
            "model": "gpt-5.6-sol", "reasoningEffort": "xhigh",
        })

    def test_unknown_effort_is_dropped_but_custom_model_is_kept(self):
        policy = LoopPolicy.from_dict({
            "runtimes": {"analysis": {"model": "future-model", "reasoningEffort": "ultra"}},
        })
        self.assertEqual(policy.runtime_for("analysis"), {"model": "future-model"})

    def test_max_effort_is_supported_for_strict_review(self):
        policy = LoopPolicy.from_dict({
            "runtimes": {"analysis": {"model": "gpt-5.6-sol", "reasoningEffort": "max"}},
        })
        self.assertEqual(policy.runtime_for("analysis")["reasoningEffort"], "max")

    def test_loop_record_persists_actual_runtime(self):
        record = LoopRecord(
            seq=1,
            backends={"execute": "official-codex"},
            runtimes={"execute": {"model": "gpt-5.6-terra", "reasoningEffort": "medium"}},
        )
        restored = LoopRecord.from_dict(record.to_dict())
        self.assertEqual(restored.runtimes, record.runtimes)


if __name__ == "__main__":
    unittest.main()

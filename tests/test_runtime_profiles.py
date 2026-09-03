import unittest
from types import SimpleNamespace

from src.backend.bridge_ws import BridgeWS
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

    def test_loop_roles_inherit_execute_runtime_and_override_prepare_and_analysis(self):
        policy = LoopPolicy.from_dict({
            "runtimes": {
                "execute": {"model": "gpt-5.6-terra", "reasoningEffort": "medium"},
                "prepare": {"model": "gpt-5.6-sol", "reasoningEffort": "max"},
                "analysis": {"model": "gpt-5.6-sol", "reasoningEffort": "xhigh"},
            },
        })
        self.assertEqual(policy.runtime_for("execute"), {
            "model": "gpt-5.6-terra", "reasoningEffort": "medium",
        })
        self.assertEqual(policy.runtime_for("idea"), {
            "model": "gpt-5.6-terra", "reasoningEffort": "medium",
        })
        self.assertEqual(policy.runtime_for("prepare"), {
            "model": "gpt-5.6-sol", "reasoningEffort": "max",
        })
        self.assertEqual(policy.runtime_for("analysis"), {
            "model": "gpt-5.6-sol", "reasoningEffort": "xhigh",
        })

    def test_legacy_policy_prepare_still_inherits_execute_runtime(self):
        policy = LoopPolicy.from_dict({
            "runtimes": {
                "execute": {"model": "legacy-worker", "reasoningEffort": "low"},
            },
        })
        self.assertEqual(policy.runtime_for("prepare"), {
            "model": "legacy-worker", "reasoningEffort": "low",
        })

    def test_prepare_backend_is_persisted_as_a_routable_role(self):
        policy = LoopPolicy.from_dict({"backends": {
            "prepare": "strong-planner", "execute": "efficient-worker",
        }})
        self.assertEqual(policy.backend_for("prepare"), "strong-planner")
        self.assertEqual(policy.backend_for("execute"), "efficient-worker")
        self.assertEqual(policy.to_dict()["backends"]["prepare"], "strong-planner")
        self.assertEqual(policy.to_dict()["backends"]["execute"], "efficient-worker")

    def test_heterogeneous_planner_uses_its_default_not_executor_model(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(
            backend_id="worker", model_override="worker-only-model", reasoning_effort="low",
        )
        state = SimpleNamespace(policy=LoopPolicy.from_dict({
            "backends": {"prepare": "planner"},
            "runtimes": {
                "execute": {"model": "worker-only-model", "reasoningEffort": "low"},
            },
        }))
        self.assertEqual(bridge._loop_runtime(session, state, "prepare", "planner"), {})

        state.policy = LoopPolicy.from_dict({
            "backends": {"prepare": "planner"},
            "runtimes": {"prepare": {"model": "planner-model", "reasoningEffort": "max"}},
        })
        self.assertEqual(bridge._loop_runtime(session, state, "prepare", "planner"), {
            "model": "planner-model", "reasoningEffort": "max",
        })

    def test_roles_only_inherit_execute_runtime_on_the_same_backend(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(
            backend_id="session-backend", model_override="session-model", reasoning_effort="low",
        )
        state = SimpleNamespace(policy=LoopPolicy.from_dict({
            "backends": {"prepare": "worker", "execute": "worker"},
            "runtimes": {"execute": {"model": "worker-model", "reasoningEffort": "high"}},
        }))
        self.assertEqual(
            bridge._loop_runtime(session, state, "prepare", "worker", "worker"),
            {"model": "worker-model", "reasoningEffort": "high"},
        )
        self.assertEqual(
            bridge._loop_runtime(session, state, "analysis", "reviewer", "worker"),
            {},
        )

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
            backends={"prepare": "planner", "execute": "official-codex"},
            runtimes={
                "prepare": {"model": "gpt-5.6-sol", "reasoningEffort": "max"},
                "execute": {"model": "gpt-5.6-terra", "reasoningEffort": "medium"},
            },
        )
        restored = LoopRecord.from_dict(record.to_dict())
        self.assertEqual(restored.backends, record.backends)
        self.assertEqual(restored.runtimes, record.runtimes)


if __name__ == "__main__":
    unittest.main()

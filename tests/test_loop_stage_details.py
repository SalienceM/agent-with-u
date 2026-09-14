import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopRecord, LoopState, STAGE_EXECUTE


class LoopStageDetailsTests(unittest.IsolatedAsyncioTestCase):
    def setup_case(self):
        record = LoopRecord(seq=1)
        state = LoopState(session_id="stage-audit", stage=STAGE_EXECUTE, goal="修复回归", loops=[record])
        state.policy.intent_guard = False
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = [SimpleNamespace(id="worker")]
        bridge._resolved_runtime = lambda *_a, **_kw: {}
        bridge._loop_runtime = lambda *_a, **_kw: {}
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._loop_cancel = {}
        session = SimpleNamespace(id=state.session_id, backend_id="worker", working_dir=".")
        return bridge, session, state, record

    async def test_plan_retry_retains_both_originals_parsed_plan_and_validation(self):
        bridge, session, state, record = self.setup_case()
        texts = ['{"goal": 42, "steps": [{"index": 1}]}',
                 '{"goal":"核实回归","steps":[{"desc":"运行回归","mode":"concurrent","access":"write"}]}']
        calls = []

        async def run(*_args, **_kwargs):
            calls.append(True)
            if len(calls) == 2:
                self.assertEqual(record.stage_details["prepare"]["status"], "retrying")
                self.assertEqual(record.stage_details["prepare"]["attempts"][0]["rawOutput"], texts[0])
                self.assertGreater(bridge._loop_save.call_count, 1)
            return texts[len(calls) - 1], None

        bridge._loop_run_agent = run
        await bridge._loop_do_prepare(session, state, record, "")
        detail = record.stage_details["prepare"]
        self.assertEqual(detail["status"], "done")
        self.assertEqual(detail["attemptCount"], 2)
        self.assertEqual([attempt["valid"] for attempt in detail["attempts"]], [False, True])
        self.assertEqual([attempt["rawOutput"] for attempt in detail["attempts"]], texts)
        self.assertEqual(detail["attempts"][1]["parsed"]["steps"][0]["mode"], "concurrent")
        self.assertEqual(record.orchestration[0].mode, "sequential")
        self.assertEqual(LoopRecord.from_dict(record.to_dict()).stage_details, record.stage_details)

    async def test_exhausted_plan_is_degraded_and_fallback_is_an_inspectable_step(self):
        bridge, session, state, record = self.setup_case()
        calls = []

        async def run(_session, _prompt, *args, **kwargs):
            stage = args[0] if args else kwargs["sub_stage"]
            calls.append(stage)
            if stage == "prepare":
                return "没有有效 JSON", None
            self.assertEqual(record.stage_details["prepare"]["status"], "degraded")
            self.assertEqual(len(record.orchestration), 1)
            return "兜底步骤保留了已有成果并通过验证", None

        bridge._loop_run_agent = run
        await bridge._loop_do_prepare(session, state, record, "")
        self.assertEqual(record.stage_details["prepare"]["status"], "retrying")
        await bridge._loop_do_execute(session, state, record)
        self.assertEqual(calls, ["prepare", "prepare", "prepare", "step1"])
        self.assertEqual(record.stage_details["prepare"]["status"], "degraded")
        self.assertEqual(record.stage_details["prepare"]["attemptCount"], 3)
        self.assertEqual(record.orchestration[0].status, "done")
        self.assertIn("降级执行", record.orchestration[0].desc)
        self.assertEqual(record.stage_details["execute"]["rawOutput"], record.orchestration[0].output)

    async def test_analysis_preserves_original_and_labels_compatibility_parsing(self):
        bridge, session, state, record = self.setup_case()
        bridge._model_ledger = SimpleNamespace(record=Mock())
        bridge._backend_label = lambda bid: bid
        bridge._recompute_risk = Mock()
        bridge._loop_should_stop = lambda _state: (False, "")
        text = "评分：60。还未完成验证。"

        async def run(*_args, **_kwargs):
            return text, None

        bridge._loop_run_agent = run
        with patch("src.backend.bridge_ws.git_snapshot", return_value=None):
            await bridge._loop_do_analysis(session, state, record)
        self.assertEqual(record.stage_details["analysis"]["rawOutput"], text)
        self.assertEqual(record.stage_details["analysis"]["status"], "degraded")
        self.assertTrue(record.stage_details["analysis"]["validation"])

    def test_compact_keeps_stage_status_but_never_sends_or_mutates_audit_bodies(self):
        bridge, _session, state, record = self.setup_case()
        huge = "x" * 1_000_000
        record.stage_details = {"prepare": {"status": "degraded", "attemptCount": 1,
            "attempts": [{"rawOutput": huge, "parsed": {"goal": huge}, "validation": ["invalid"], "valid": False}]},
            "analysis": {"rawOutput": huge, "parsed": {"notes": huge}, "status": "done"}}
        bridge._loop_running = set()
        bridge._loop_tasks = {}
        bridge._loop_states = {state.session_id: state}
        compact = bridge._loop_payload(state, compact=True)
        self.assertLess(len(json.dumps(compact)), 20_000)
        self.assertEqual(compact["loops"][0]["stageDetails"]["prepare"]["status"], "degraded")
        full = json.loads(bridge._rpc_loopGetRecord(state.session_id, 1))["record"]
        self.assertEqual(full["stageDetails"]["prepare"]["attempts"][0]["rawOutput"], huge)
        self.assertEqual(full["stageDetails"]["analysis"]["rawOutput"], huge)

    def test_legacy_records_have_no_fabricated_stage_originals(self):
        self.assertEqual(LoopRecord.from_dict({"seq": 4, "completed": True}).stage_details, {})

    async def test_planner_exception_keeps_failing_stage_previous_attempt_and_partial_tail(self):
        bridge, session, state, record = self.setup_case()
        session.agent_session_id = None
        session.auto_commit = False
        bridge._active_sessions = {session.id: session}
        bridge._loop_state = lambda _sid: state
        bridge._loop_running = set()
        bridge._loop_pending_out = set()
        bridge._loop_pending_continues = {}
        bridge._loop_history_brief = lambda *_args, **_kwargs: ""
        bridge._maybe_autocontinue = Mock()
        calls = []

        async def run(*_args, **_kwargs):
            calls.append(True)
            if len(calls) == 1:
                return "无效计划原文", None
            bridge._remember_loop_progress(session.id, 1, "prepare", "中断前的可见文本")
            raise RuntimeError("规划后端断开")

        bridge._loop_run_agent = run
        with patch("src.backend.bridge_ws.print"):
            await bridge._run_loop_iteration(session.id)
        self.assertEqual(record.sub_stage, "prepare")
        self.assertFalse(record.completed)
        self.assertEqual(record.stage_details["prepare"]["status"], "error")
        self.assertEqual(record.stage_details["prepare"]["attempts"][0]["rawOutput"], "无效计划原文")
        self.assertEqual(record.stage_details["prepare"]["partialOutput"], "中断前的可见文本")

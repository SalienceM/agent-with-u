import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import (
    Addon,
    DEFAULT_STRATEGY,
    LEGACY_DEFAULT_STRATEGY,
    LEGACY_FRONTEND_DEFAULT_STRATEGY,
    IdeaEntry,
    LoopAnalysis,
    LoopPolicy,
    LoopRecord,
    LoopStep,
    LoopState,
    STAGE_EXECUTE,
    SUB_ANALYSIS,
    SUB_EXECUTE,
)


class LoopEvolutionTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _bridge() -> BridgeWS:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = [SimpleNamespace(id="executor")]
        bridge._resolved_runtime = lambda *_args, **_kwargs: {}
        bridge._loop_runtime = lambda *_args, **_kwargs: {}
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        return bridge

    async def test_prepare_uses_prior_diagnosis_and_addon_for_one_increment(self) -> None:
        previous = LoopRecord(
            seq=1,
            round=1,
            goal="先建立已有能力基线",
            completed=True,
            result="登录主链路已经存在",
            analysis=LoopAnalysis(
                score=62,
                verified="登录与退出测试已通过",
                gaps="刷新 token 后状态会丢失",
                next_focus="只修复 token 刷新回归",
                notes="整体尚未达到稳定标准",
            ),
        )
        current = LoopRecord(seq=2, round=1)
        addon = Addon(id="addon-1", text="同时保留离线登录兼容")
        state = LoopState(
            session_id="evolution-prepare",
            stage=STAGE_EXECUTE,
            goal="交付稳定的登录系统",
            ideas=[IdeaEntry(id="idea-1", prompt="登录不能影响离线用户")],
            loops=[previous, current],
            addons=[addon],
        )
        state.policy.intent_guard = False
        session = SimpleNamespace(id=state.session_id, backend_id="executor")
        bridge = self._bridge()
        prompts: list[str] = []

        async def run_agent(_session, prompt, *_args, **_kwargs):
            prompts.append(prompt)
            return (
                "```json\n"
                '{"goal":"修复 token 刷新且保持离线兼容","orchestration":['
                '{"mode":"sequential","access":"read","desc":"核实刷新回归"},'
                '{"mode":"sequential","access":"write","desc":"实施最小修复"}]}'
                "\n```",
                None,
            )

        bridge._loop_run_agent = run_agent
        history = bridge._loop_history_brief(state, exclude_seq=current.seq)

        await bridge._loop_do_prepare(session, state, current, history)

        prompt = prompts[0]
        self.assertIn("交付稳定的登录系统", prompt)
        self.assertIn("登录不能影响离线用户", prompt)
        self.assertIn("刷新 token 后状态会丢失", prompt)
        self.assertIn("同时保留离线登录兼容", prompt)
        self.assertIn("一个最高价值增量焦点", prompt)
        self.assertIn("不要尝试在本次重新完成整个目标", prompt)
        self.assertNotIn("一次完整、尽力的执行", prompt)
        self.assertEqual(current.iteration_mode, "evolution")
        self.assertIn("刷新 token 后状态会丢失", current.evolution_basis)
        self.assertIn("同时保留离线登录兼容", current.evolution_basis)
        self.assertEqual(current.sub_stage, SUB_EXECUTE)
        self.assertEqual(len(current.orchestration), 2)
        self.assertEqual(addon.status, "applied")
        self.assertEqual(addon.applied_seq, current.seq)

    def test_orchestration_parser_accepts_common_model_aliases_but_never_blank_steps(self) -> None:
        steps = BridgeWS._loop_parse_orchestration([
            {"mode": "concurrent", "access": "read", "description": "1. 核实现状"},
            {"mode": "concurrent", "access": "write", "task": "Step 2: 实施修正"},
            {"title": "步骤 3：运行回归测试"},
            "4) 汇总证据",
        ])

        self.assertEqual([step.desc for step in steps], [
            "核实现状", "实施修正", "运行回归测试", "汇总证据",
        ])
        self.assertEqual(steps[0].mode, "concurrent")
        self.assertEqual(steps[1].mode, "sequential")  # 写操作不能被模型标成并行
        self.assertEqual(BridgeWS._loop_parse_orchestration([
            {"mode": "sequential", "access": "read"},
            {"desc": "这一步虽然有效，但整份计划仍应拒绝"},
        ]), [])

    async def test_prepare_uses_distinct_planner_backend_and_runtime(self) -> None:
        current = LoopRecord(seq=1, round=1)
        state = LoopState(
            session_id="split-planner",
            stage=STAGE_EXECUTE,
            goal="完成一项需要先准确拆步的任务",
            loops=[current],
            policy=LoopPolicy.from_dict({
                "backends": {"prepare": "strong-planner"},
                "runtimes": {
                    "prepare": {"model": "planner-model", "reasoningEffort": "max"},
                    "execute": {"model": "worker-model", "reasoningEffort": "low"},
                },
            }),
        )
        state.policy.intent_guard = False
        session = SimpleNamespace(id=state.session_id, backend_id="worker")
        bridge = self._bridge()
        bridge._backend_configs = [
            SimpleNamespace(id="worker"),
            SimpleNamespace(id="strong-planner"),
        ]
        bridge._loop_runtime = lambda _session, _state, pos, *_backend_ids: _state.policy.runtime_for(pos)
        bridge._resolved_runtime = lambda _backend_id, runtime: dict(runtime)
        calls: list[dict] = []

        async def run_agent(_session, _prompt, *_args, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                # 有数组不等于有可执行计划：旧逻辑会接受这些空说明步骤，UI 只剩序号。
                return (
                    "```json\n"
                    '{"goal":"空说明不应通过","orchestration":['
                    '{"mode":"sequential","access":"read"}]}\n'
                    "```",
                    None,
                )
            return (
                "```json\n"
                '{"goal":"准确拆分当前任务","orchestration":['
                '{"mode":"sequential","access":"read","desc":"先核实现状"},'
                '{"mode":"sequential","access":"write","desc":"再执行修正"}]}'
                "\n```",
                None,
            )

        bridge._loop_run_agent = run_agent
        await bridge._loop_do_prepare(session, state, current, history="")

        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call["backend_id"], "strong-planner")
            self.assertEqual(call["runtime"], {
                "model": "planner-model", "reasoningEffort": "max",
            })
        self.assertEqual(current.backends["prepare"], "strong-planner")
        self.assertEqual(current.backends["execute"], "worker")
        self.assertEqual(current.runtimes["prepare"]["model"], "planner-model")
        self.assertEqual(current.runtimes["execute"]["model"], "worker-model")
        self.assertEqual(len(current.orchestration), 2)

    async def test_execute_routes_steps_and_summary_to_selected_backend(self) -> None:
        current = LoopRecord(
            seq=1,
            round=1,
            goal="执行已规划的修正",
            orchestration=[LoopStep(
                index=1, mode="sequential", access="write", desc="实施修正并验证",
            )],
            runtimes={"execute": {"model": "worker-model", "reasoningEffort": "high"}},
        )
        state = LoopState(
            session_id="split-executor",
            stage=STAGE_EXECUTE,
            goal="完成可验证的修正",
            loops=[current],
            policy=LoopPolicy.from_dict({
                "backends": {"execute": "dedicated-worker"},
                "runtimes": {"execute": {"model": "worker-model", "reasoningEffort": "high"}},
            }),
        )
        session = SimpleNamespace(id=state.session_id, backend_id="session-backend")
        bridge = self._bridge()
        bridge._backend_configs = [
            SimpleNamespace(id="session-backend"),
            SimpleNamespace(id="dedicated-worker"),
        ]
        bridge._loop_cancel = {}
        calls: list[dict] = []

        async def run_agent(_session, _prompt, *_args, **kwargs):
            calls.append(kwargs)
            return ("执行完成", "worker-thread")

        bridge._loop_run_agent = run_agent
        await bridge._loop_do_execute(session, state, current)

        self.assertEqual(len(calls), 2)  # 单步执行 + 执行汇总
        for call in calls:
            self.assertEqual(call["backend_id"], "dedicated-worker")
            self.assertEqual(call["runtime"], {
                "model": "worker-model", "reasoningEffort": "high",
            })
        self.assertEqual(current.backends["execute"], "dedicated-worker")
        self.assertEqual(current.orchestration[0].status, "done")
        self.assertEqual(current.sub_stage, SUB_ANALYSIS)

    async def test_execute_replans_blank_steps_persisted_by_legacy_parser(self) -> None:
        current = LoopRecord(
            seq=6,
            round=1,
            goal="完成 ETL 回归覆盖",
            orchestration=[LoopStep(index=1, access="write", desc="")],
        )
        state = LoopState(
            session_id="legacy-blank-steps",
            stage=STAGE_EXECUTE,
            goal="完成 ETL 回归覆盖",
            loops=[current],
        )
        session = SimpleNamespace(id=state.session_id, backend_id="executor")
        bridge = self._bridge()
        bridge._loop_cancel = {}
        calls: list[str] = []

        async def run_agent(_session, prompt, *_args, **_kwargs):
            calls.append(prompt)
            if len(calls) == 1:
                return (
                    "```json\n"
                    '{"goal":"补齐 ETL 回归","steps":['
                    '{"mode":"sequential","access":"write",'
                    '"description":"补齐并验证 ETL 回归"}]}\n'
                    "```",
                    None,
                )
            return ("执行完成并通过测试" if len(calls) == 2 else "本次已补齐 ETL 回归。", None)

        bridge._loop_run_agent = run_agent
        await bridge._loop_do_execute(session, state, current)

        self.assertEqual(len(calls), 3)  # 重规划 + 新步骤 + 汇总
        self.assertEqual(current.orchestration[0].desc, "补齐并验证 ETL 回归")
        self.assertEqual(current.orchestration[0].status, "done")
        self.assertEqual(current.sub_stage, SUB_ANALYSIS)

    async def test_analysis_scores_cumulative_state_and_emits_next_diagnosis(self) -> None:
        previous = LoopRecord(
            seq=1,
            round=1,
            completed=True,
            goal="建立基线",
            analysis=LoopAnalysis(score=55, gaps="缺少断线恢复"),
        )
        current = LoopRecord(
            seq=2,
            round=1,
            sub_stage=SUB_ANALYSIS,
            goal="补齐断线恢复",
            iteration_mode="evolution",
            evolution_basis="上一诊断：缺少断线恢复\n本次 Addon：不得破坏重连",
            result="增加了重连状态机并通过针对性测试",
            backends={"execute": "executor", "analysis": "executor"},
        )
        state = LoopState(
            session_id="evolution-analysis",
            stage=STAGE_EXECUTE,
            goal="连接长期稳定且可恢复",
            ideas=[IdeaEntry(id="idea", prompt="断网后要自动回来")],
            loops=[previous, current],
        )
        session = SimpleNamespace(
            id=state.session_id,
            backend_id="executor",
            working_dir=".",
        )
        bridge = self._bridge()
        bridge._model_ledger = SimpleNamespace(record=Mock())
        bridge._backend_label = lambda bid: bid
        bridge._recompute_risk = Mock()
        bridge._loop_should_stop = lambda _state: (False, "")
        prompts: list[str] = []

        async def run_agent(_session, prompt, *_args, **_kwargs):
            prompts.append(prompt)
            return (
                "```json\n"
                '{"score":78,"optimizationPotential":0.35,"trend":"上升",'
                '"verified":["重连测试通过","既有连接测试仍通过"],'
                '"gaps":"尚缺长时抖动测试","nextFocus":"只补长时抖动验证",'
                '"challenges":"","notes":"本次补齐恢复；整体仍需长时验证"}'
                "\n```",
                None,
            )

        bridge._loop_run_agent = run_agent
        with patch("src.backend.bridge_ws.git_snapshot", return_value=None):
            await bridge._loop_do_analysis(session, state, current)

        prompt = prompts[0]
        self.assertIn("当前累计工作区状态", prompt)
        self.assertIn("评分对象是当前真实产物对全局目标的整体完成度", prompt)
        self.assertIn("缺少断线恢复", prompt)
        self.assertIn("本次新增贡献", prompt)
        self.assertNotIn("完整尝试", prompt)
        self.assertEqual(current.analysis.score, 78)
        self.assertIn("重连测试通过", current.analysis.verified)
        self.assertEqual(current.analysis.gaps, "尚缺长时抖动测试")
        self.assertEqual(current.analysis.next_focus, "只补长时抖动验证")


class LoopEvolutionCompatibilityTests(unittest.TestCase):
    def test_analysis_fields_round_trip(self) -> None:
        original = LoopAnalysis(
            score=81,
            verified="构建通过",
            gaps="还缺端到端验证",
            next_focus="补一条端到端用例",
        )
        restored = LoopAnalysis.from_dict(original.to_dict())
        self.assertEqual(restored.verified, original.verified)
        self.assertEqual(restored.gaps, original.gaps)
        self.assertEqual(restored.next_focus, original.next_focus)

    def test_legacy_default_strategy_migrates_without_losing_suffix(self) -> None:
        policy = LoopPolicy.from_dict({
            "strategy": LEGACY_DEFAULT_STRATEGY + "\n\n额外：必须覆盖安全边界。",
        })
        self.assertTrue(policy.strategy.startswith(DEFAULT_STRATEGY))
        self.assertIn("额外：必须覆盖安全边界", policy.strategy)
        self.assertNotIn("每一次 loop 都是对【全局目标】的一次完整", policy.strategy)

        frontend_policy = LoopPolicy.from_dict({
            "strategy": LEGACY_FRONTEND_DEFAULT_STRATEGY,
        })
        self.assertEqual(frontend_policy.strategy, DEFAULT_STRATEGY)

    def test_history_prioritizes_structured_diagnosis(self) -> None:
        state = LoopState(
            session_id="history",
            stage=STAGE_EXECUTE,
            loops=[LoopRecord(
                seq=1,
                completed=True,
                analysis=LoopAnalysis(
                    score=70,
                    verified="已核实 A",
                    gaps="仍缺 B",
                    next_focus="优先 B",
                ),
            )],
        )
        history = BridgeWS._loop_history_brief(state, exclude_seq=2)
        self.assertIn("已核实 A", history)
        self.assertIn("仍缺 B", history)
        self.assertIn("优先 B", history)


if __name__ == "__main__":
    unittest.main()

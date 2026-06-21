"""
LoopStore: 可视化 Loop 集成的状态持久化（"stage 文件"）。

每个 loop session 在 ~/.agent-with-u/loops/<session_id>.json 留存一个 stage 文件。
全局阶段（stage）单向推进：

    loopidea  →  loopexecute  →  loopout

- loopidea：前台非阻塞地投递多条想法（idea），后端用并发池（默认 3）逐条让
  模型展开。封口（seal）后形成全局目标 goal，单向切到 loopexecute。
- loopexecute：按次（seq）执行 loop，每次 loop 分三个子阶段：
    prepare  —— 编排本次 loop 的分步（顺次 / 并发）、本次目标
    execute  —— 按编排执行，落地执行结果（未必成功）
    analysis —— 评估执行结果与全局目标的差距，给出分数与趋势分析
- loopout：全局产出阶段（可交付 / 可输出）。

评分心智模型（0–100）：
  >= 70 → 可交付（deliverable），进入优化阶段
  >= 85 → 可输出（outputtable），分析后续 loop 的优化空间与趋势
风险系数（risk_coefficient，0–1）：综合"最大 loop 约束"与"完不成的风险因子"，
用于避免为无法完成的任务做无谓 loop。
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import paths


# ── 阶段常量 ──────────────────────────────────────────────────────
STAGE_IDEA = "loopidea"
STAGE_EXECUTE = "loopexecute"
STAGE_OUT = "loopout"

SUB_PREPARE = "prepare"
SUB_EXECUTE = "execute"
SUB_ANALYSIS = "analysis"
SUB_DONE = "done"

DELIVERABLE_SCORE = 70.0   # 可交付门槛
OUTPUTTABLE_SCORE = 85.0   # 可输出门槛


def _now() -> float:
    return time.time()


@dataclass
class LoopStep:
    """本次 loop 编排中的一个分步。"""
    index: int
    mode: str = "sequential"   # "sequential" | "concurrent"
    desc: str = ""
    status: str = "pending"    # pending | running | done | error
    output: str = ""           # 该步执行产出（持久化，用于复盘）
    started_at: float = 0.0    # 开始执行时间戳（0 = 未开始），用于流程视图耗时
    ended_at: float = 0.0      # 结束时间戳（0 = 未结束）

    def to_dict(self) -> dict:
        return {"index": self.index, "mode": self.mode, "desc": self.desc,
                "status": self.status, "output": self.output,
                "startedAt": self.started_at, "endedAt": self.ended_at}

    @classmethod
    def from_dict(cls, d: dict) -> "LoopStep":
        return cls(
            index=int(d.get("index", 0)),
            mode=d.get("mode", "sequential"),
            desc=d.get("desc", ""),
            status=d.get("status", "pending"),
            output=d.get("output", ""),
            started_at=float(d.get("startedAt", 0) or 0),
            ended_at=float(d.get("endedAt", 0) or 0),
        )


@dataclass
class LoopAnalysis:
    """execute analysis 结果。"""
    score: float = 0.0                  # 0..100
    notes: str = ""                     # 分析正文
    trend: str = ""                     # 历史趋势评估
    optimization_potential: float = 0.0  # 0..1，下一次 loop 估计还能提升多少
    challenges: str = ""                # 环境/系统/网络等可触达性挑战
    deliverable: bool = False           # score >= 70
    outputtable: bool = False           # score >= 85

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "notes": self.notes,
            "trend": self.trend,
            "optimizationPotential": self.optimization_potential,
            "challenges": self.challenges,
            "deliverable": self.deliverable,
            "outputtable": self.outputtable,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopAnalysis":
        return cls(
            score=float(d.get("score", 0.0)),
            notes=d.get("notes", ""),
            trend=d.get("trend", ""),
            optimization_potential=float(d.get("optimizationPotential", 0.0)),
            challenges=d.get("challenges", ""),
            deliverable=bool(d.get("deliverable", False)),
            outputtable=bool(d.get("outputtable", False)),
        )


@dataclass
class LoopRecord:
    """一次 loopexecute 的完整记录。"""
    seq: int
    sub_stage: str = SUB_PREPARE        # prepare | execute | analysis | done
    round: int = 1                      # 属于第几轮（loopout 后可开启新一轮）
    goal: str = ""                      # 本次 loop 的计划目标
    orchestration: list[LoopStep] = field(default_factory=list)
    completed: bool = False             # 是否按步骤执行完成（含 analysis 完成）
    result: str = ""                    # 本次 loop 执行完成的结果信息
    analysis: Optional[LoopAnalysis] = None
    error: str = ""
    # 各子阶段的开始时间戳（{prepare/execute/analysis/done: ts}），用于流程视图耗时
    sub_started: dict = field(default_factory=dict)
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def mark_sub(self, sub: str) -> None:
        """记录某子阶段的开始时间（已记则不覆盖）。"""
        if sub and sub not in self.sub_started:
            self.sub_started[sub] = _now()

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "subStage": self.sub_stage,
            "round": self.round,
            "goal": self.goal,
            "orchestration": [s.to_dict() for s in self.orchestration],
            "completed": self.completed,
            "result": self.result,
            "analysis": self.analysis.to_dict() if self.analysis else None,
            "error": self.error,
            "subStarted": self.sub_started,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopRecord":
        return cls(
            seq=int(d.get("seq", 0)),
            sub_stage=d.get("subStage", SUB_PREPARE),
            round=int(d.get("round", 1)),
            goal=d.get("goal", ""),
            orchestration=[LoopStep.from_dict(s) for s in d.get("orchestration", [])],
            completed=bool(d.get("completed", False)),
            result=d.get("result", ""),
            analysis=LoopAnalysis.from_dict(d["analysis"]) if d.get("analysis") else None,
            error=d.get("error", ""),
            sub_started=dict(d.get("subStarted") or {}),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class IdeaEntry:
    """loopidea 阶段的一条想法（并发池中的一个任务）。"""
    id: str
    prompt: str
    status: str = "pending"   # pending | running | done | error
    result: str = ""
    error: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "IdeaEntry":
        return cls(
            id=d.get("id", ""),
            prompt=d.get("prompt", ""),
            status=d.get("status", "pending"),
            result=d.get("result", ""),
            error=d.get("error", ""),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class AsideTurn:
    """一条 "by the way" 旁路问答（独立 agent session，不污染 loop 主线）。"""
    id: str
    question: str
    answer: str = ""
    status: str = "answering"   # answering | done | error
    stage: str = ""             # 提问时的 loop 阶段快照
    seq: int = 0                # 提问时正在跑的 loop（0 表示无）
    image_count: int = 0        # 提问时附带的图片数（base64 不落盘，仅记数量）
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "answer": self.answer,
            "status": self.status,
            "stage": self.stage,
            "seq": self.seq,
            "imageCount": self.image_count,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AsideTurn":
        return cls(
            id=d.get("id", ""),
            question=d.get("question", ""),
            answer=d.get("answer", ""),
            status=d.get("status", "done"),
            stage=d.get("stage", ""),
            seq=int(d.get("seq", 0)),
            image_count=int(d.get("imageCount", 0)),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class Addon:
    """执行过程中随手补充的要求（addon）。不影响当前 loop；
    在 loop 结束的 analysis 与下一次 loop 的 prepare 时带上、并在 prepare 时消费。"""
    id: str
    text: str
    status: str = "pending"     # pending（待纳入）| applied（已纳入某次 loop）
    applied_seq: int = 0        # 被哪一次 loop 的 prepare 纳入
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "text": self.text, "status": self.status,
            "appliedSeq": self.applied_seq,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Addon":
        return cls(
            id=d.get("id", ""),
            text=d.get("text", ""),
            status=d.get("status", "pending"),
            applied_seq=int(d.get("appliedSeq", 0)),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


DEFAULT_STRATEGY = (
    "每一次 loop 都是对【全局目标】的一次完整、尽力的尝试（不是把任务拆到多个 loop 分步完成）。\n"
    "- prepare：规划这一遍的策略与分步编排（可并发 concurrent / 顺次 sequential）。\n"
    "- execute：实际执行编排（读写文件、运行命令），如实记录产出与成败。\n"
    "- analysis：对照全局目标打分（0–100），评估趋势、优化空间与硬约束。\n"
    "评分心智：优先把每一遍做到尽量完整，而不是保留实力分多次；遇到环境/权限/网络等"
    "硬约束要在 challenges 里点明，避免为不可能的任务做无谓 loop。"
)


@dataclass
class LoopPolicy:
    """Loop 的策略与心智（可在建会话时编辑、运行时实时查看/调整）。"""
    deliverable_score: float = DELIVERABLE_SCORE   # 可交付门槛
    outputtable_score: float = OUTPUTTABLE_SCORE   # 可输出门槛
    max_loops: int = 8                             # 基础最大 loop 约束
    risk_threshold: float = 0.85                   # 风险止损阈值（≥ 即收口）
    strategy: str = DEFAULT_STRATEGY               # 注入到 prepare/analysis 的策略心智文本

    def to_dict(self) -> dict:
        return {
            "deliverableScore": self.deliverable_score,
            "outputtableScore": self.outputtable_score,
            "maxLoops": self.max_loops,
            "riskThreshold": self.risk_threshold,
            "strategy": self.strategy,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopPolicy":
        d = d or {}
        def _f(key, default):
            try:
                return float(d.get(key, default))
            except (TypeError, ValueError):
                return default
        dv = max(0.0, min(100.0, _f("deliverableScore", DELIVERABLE_SCORE)))
        ov = max(dv, min(100.0, _f("outputtableScore", OUTPUTTABLE_SCORE)))  # 不低于可交付
        try:
            ml = int(d.get("maxLoops", 8))
        except (TypeError, ValueError):
            ml = 8
        ml = max(1, min(50, ml))
        rt = max(0.1, min(1.0, _f("riskThreshold", 0.85)))
        strat = d.get("strategy")
        return cls(
            deliverable_score=dv, outputtable_score=ov, max_loops=ml, risk_threshold=rt,
            strategy=strat if isinstance(strat, str) and strat.strip() else DEFAULT_STRATEGY,
        )


@dataclass
class GoalRevision:
    """全局目标的一个版本。封口初版 / 按提示微调 / 手动改 都各留一版,体现演变。"""
    goal: str
    hint: str = ""              # 本次微调的额外提示(初版/手动为空)
    source: str = "seal"        # seal(封口汇总) | refine(按提示微调) | manual(手动)
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {"goal": self.goal, "hint": self.hint,
                "source": self.source, "createdAt": self.created_at}

    @classmethod
    def from_dict(cls, d: dict) -> "GoalRevision":
        return cls(
            goal=d.get("goal", ""),
            hint=d.get("hint", ""),
            source=d.get("source", "seal"),
            created_at=d.get("createdAt", _now()),
        )


@dataclass
class LoopState:
    """单个 loop session 的完整 stage 文件。"""
    session_id: str
    stage: str = STAGE_IDEA             # loopidea | loopexecute | loopout
    goal: str = ""                      # 全局目标（idea 封口后形成）
    goal_history: list[GoalRevision] = field(default_factory=list)  # 目标版本演变
    ideas: list[IdeaEntry] = field(default_factory=list)
    loops: list[LoopRecord] = field(default_factory=list)
    risk_coefficient: float = 0.3       # 0..1 综合风险系数
    policy: LoopPolicy = field(default_factory=LoopPolicy)  # 策略与心智（可编辑）
    round: int = 1                      # 当前轮次（loopout 后可开启新一轮）
    auto: bool = False                  # 自动连跑：一次 loop 完成后自动开始下一次
    status: str = "active"              # active | delivered | output | aborted
    stop_reason: str = ""               # 触发 loopout / 终止的原因
    asides: list[AsideTurn] = field(default_factory=list)  # by the way 旁路问答
    addons: list[Addon] = field(default_factory=list)      # 执行中补充的要求
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    # ── 派生指标 ────────────────────────────────────────────────
    def record_goal(self, goal: str, hint: str = "", source: str = "seal") -> None:
        """登记一版全局目标(去重:与当前最新版相同则不追加)。"""
        g = (goal or "").strip()
        if not g:
            return
        if self.goal_history and self.goal_history[-1].goal == g:
            return
        self.goal_history.append(GoalRevision(goal=g, hint=hint, source=source))

    def round_loops(self) -> list["LoopRecord"]:
        """当前轮次的 loop（分数/风险/收口都按当前轮计算）。"""
        return [l for l in self.loops if l.round == self.round]

    def best_score(self) -> float:
        scores = [l.analysis.score for l in self.round_loops() if l.analysis]
        return max(scores) if scores else 0.0

    def latest_score(self) -> float:
        done = [l for l in self.round_loops() if l.analysis]
        return done[-1].analysis.score if done else 0.0

    def effective_max_loops(self) -> int:
        """风险越高，允许的 loop 上限越低（避免无谓 loop）。"""
        return max(1, round(self.policy.max_loops * (1.0 - 0.5 * self.risk_coefficient)))

    def to_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "stage": self.stage,
            "goal": self.goal,
            "goalHistory": [g.to_dict() for g in self.goal_history],
            "ideas": [i.to_dict() for i in self.ideas],
            "loops": [l.to_dict() for l in self.loops],
            "riskCoefficient": self.risk_coefficient,
            "policy": self.policy.to_dict(),
            "maxLoops": self.policy.max_loops,
            "effectiveMaxLoops": self.effective_max_loops(),
            "round": self.round,
            "roundLoopCount": len(self.round_loops()),
            "auto": self.auto,
            "status": self.status,
            "stopReason": self.stop_reason,
            "asides": [a.to_dict() for a in self.asides],
            "addons": [a.to_dict() for a in self.addons],
            "bestScore": self.best_score(),
            "latestScore": self.latest_score(),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopState":
        # 策略：新字段 policy；老存档没有则用旧的 maxLoops 迁移，其余取默认
        if d.get("policy") is not None:
            policy = LoopPolicy.from_dict(d["policy"])
        else:
            policy = LoopPolicy.from_dict({"maxLoops": d.get("maxLoops", 8)})
        return cls(
            session_id=d.get("sessionId", ""),
            stage=d.get("stage", STAGE_IDEA),
            goal=d.get("goal", ""),
            goal_history=[GoalRevision.from_dict(g) for g in d.get("goalHistory", [])],
            ideas=[IdeaEntry.from_dict(i) for i in d.get("ideas", [])],
            loops=[LoopRecord.from_dict(l) for l in d.get("loops", [])],
            risk_coefficient=float(d.get("riskCoefficient", 0.3)),
            policy=policy,
            round=int(d.get("round", 1)),
            auto=bool(d.get("auto", False)),
            status=d.get("status", "active"),
            stop_reason=d.get("stopReason", ""),
            asides=[AsideTurn.from_dict(a) for a in d.get("asides", [])],
            addons=[Addon.from_dict(a) for a in d.get("addons", [])],
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


class LoopStore:
    """Loop stage 文件的读写。线程安全（与 SessionStore 同进程）。"""

    def __init__(self):
        self._dir = paths.sub("loops")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, sid: str) -> Path:
        return self._dir / f"{sid}.json"

    def exists(self, sid: str) -> bool:
        return self._path(sid).exists()

    def load(self, sid: str) -> Optional[LoopState]:
        path = self._path(sid)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return LoopState.from_dict(data)
        except Exception as e:
            print(f"[LoopStore] failed to load {sid}: {e}")
            return None

    def save(self, state: LoopState) -> None:
        state.updated_at = _now()
        with self._lock:
            self._path(state.session_id).write_text(
                json.dumps(state.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def create(self, sid: str) -> LoopState:
        state = LoopState(session_id=sid)
        self.save(state)
        return state

    def get_or_create(self, sid: str) -> LoopState:
        return self.load(sid) or self.create(sid)

    def delete(self, sid: str) -> bool:
        try:
            p = self._path(sid)
            if p.exists():
                p.unlink()
            return True
        except Exception:
            return False

"""
ModelLedger: 跨 session 的「模型能力台账」——大脑的长期记忆。

把每次 loop 的真实结果按 backend × 角色积累下来（执行得了多少分、参与了多少次评审
等），形成"谁擅长什么"的参考，供下一次任务启动时做能力匹配的分配决策。

存于 ~/.agent-with-u/model-ledger/ledger.json，结构：
    { "<backend_id>|<model>|<effort>": { "backendId", "model", "reasoningEffort", "label",
        "roles": { "execute"|"analysis"|"idea"|...: {count, scored, sum, lastAt} } } }
"""

from __future__ import annotations

import json
import threading
import time
from typing import Optional

from . import paths


class ModelLedger:
    def __init__(self):
        self._dir = paths.sub("model-ledger")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "ledger.json"
        self._lock = threading.Lock()

    def _load(self) -> dict:
        if not self._path.exists():
            return {}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save(self, data: dict) -> None:
        self._path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                              encoding="utf-8")

    def record(self, backend_id: str, label: str, role: str,
               score: Optional[float] = None, success: Optional[bool] = None,
               duration_ms: Optional[float] = None, task_type: str = "general",
               model: str = "", reasoning_effort: str = "") -> None:
        """记一次 backend × 模型 × 档位使用；score 非空时计入均分。"""
        if not backend_id or not role:
            return
        model = str(model or "").strip()
        reasoning_effort = str(reasoning_effort or "").strip().lower()
        ledger_key = backend_id
        if model or reasoning_effort:
            ledger_key = f"{backend_id}|{model or 'default'}|{reasoning_effort or 'default'}"
        runtime_suffix = " · ".join(x for x in (model, reasoning_effort) if x)
        runtime_label = f"{label or backend_id} · {runtime_suffix}" if runtime_suffix else (label or backend_id)
        with self._lock:
            data = self._load()
            b = data.setdefault(ledger_key, {
                "backendId": backend_id, "model": model,
                "reasoningEffort": reasoning_effort,
                "label": runtime_label, "roles": {},
            })
            b["backendId"] = backend_id
            b["model"] = model
            b["reasoningEffort"] = reasoning_effort
            b["label"] = runtime_label
            r = b["roles"].setdefault(role, {
                "count": 0, "scored": 0, "sum": 0.0, "lastAt": 0,
                "successes": 0, "failures": 0, "durationCount": 0,
                "durationSumMs": 0.0, "taskTypes": {},
            })
            r["count"] = int(r.get("count", 0)) + 1
            if score is not None:
                try:
                    r["sum"] = float(r.get("sum", 0.0)) + float(score)
                    r["scored"] = int(r.get("scored", 0)) + 1
                except (TypeError, ValueError):
                    pass
            if success is not None:
                key = "successes" if success else "failures"
                r[key] = int(r.get(key, 0)) + 1
            if duration_ms is not None:
                try:
                    r["durationSumMs"] = float(r.get("durationSumMs", 0.0)) + max(0.0, float(duration_ms))
                    r["durationCount"] = int(r.get("durationCount", 0)) + 1
                except (TypeError, ValueError):
                    pass
            task_types = r.setdefault("taskTypes", {})
            category = (task_type or "general").strip() or "general"
            task_types[category] = int(task_types.get(category, 0)) + 1
            r["lastAt"] = time.time()
            self._save(data)

    def list(self) -> list[dict]:
        data = self._load()
        out = []
        for bid, b in data.items():
            roles = {}
            for role, r in (b.get("roles") or {}).items():
                scored = int(r.get("scored", 0) or 0)
                avg = (float(r.get("sum", 0.0)) / scored) if scored else None
                outcomes = int(r.get("successes", 0)) + int(r.get("failures", 0))
                duration_count = int(r.get("durationCount", 0) or 0)
                roles[role] = {"count": int(r.get("count", 0) or 0), "scored": scored,
                               "avgScore": avg, "lastAt": r.get("lastAt", 0),
                               "successRate": (int(r.get("successes", 0)) / outcomes) if outcomes else None,
                               "avgDurationMs": (float(r.get("durationSumMs", 0.0)) / duration_count)
                               if duration_count else None,
                               "taskTypes": dict(r.get("taskTypes") or {})}
            out.append({
                "runtimeKey": bid,
                "backendId": b.get("backendId", bid),
                "model": b.get("model", ""),
                "reasoningEffort": b.get("reasoningEffort", ""),
                "label": b.get("label", bid),
                "roles": roles,
            })
        # 执行均分高的排前面，便于"谁更能干"一眼看到
        out.sort(key=lambda x: (x["roles"].get("execute", {}).get("avgScore") or -1), reverse=True)
        return out

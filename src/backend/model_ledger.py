"""
ModelLedger: 跨 session 的「模型能力台账」——大脑的长期记忆。

把每次 loop 的真实结果按 backend × 角色积累下来（执行得了多少分、参与了多少次评审
等），形成"谁擅长什么"的参考，供下一次任务启动时做能力匹配的分配决策。

存于 ~/.agent-with-u/model-ledger/ledger.json，结构：
    { "<backend_id>": { "backendId", "label",
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
               score: Optional[float] = None) -> None:
        """记一次 backend 在某角色上的使用；score 非空时计入均分（如执行后得到的评分）。"""
        if not backend_id or not role:
            return
        with self._lock:
            data = self._load()
            b = data.setdefault(backend_id, {"backendId": backend_id, "label": label or backend_id, "roles": {}})
            b["label"] = label or b.get("label") or backend_id
            r = b["roles"].setdefault(role, {"count": 0, "scored": 0, "sum": 0.0, "lastAt": 0})
            r["count"] = int(r.get("count", 0)) + 1
            if score is not None:
                try:
                    r["sum"] = float(r.get("sum", 0.0)) + float(score)
                    r["scored"] = int(r.get("scored", 0)) + 1
                except (TypeError, ValueError):
                    pass
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
                roles[role] = {"count": int(r.get("count", 0) or 0), "scored": scored,
                               "avgScore": avg, "lastAt": r.get("lastAt", 0)}
            out.append({"backendId": bid, "label": b.get("label", bid), "roles": roles})
        # 执行均分高的排前面，便于"谁更能干"一眼看到
        out.sort(key=lambda x: (x["roles"].get("execute", {}).get("avgScore") or -1), reverse=True)
        return out

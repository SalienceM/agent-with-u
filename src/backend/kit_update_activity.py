"""安装前有界、只读检查持久化活动；不可读不等于空闲。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterator

from .kit_update_journal import JournalError


def records(store: Any) -> Iterator[dict[str, Any]]:
    folder = getattr(store, "_dir", None)
    if folder is None:
        return
    budget = 64 * 1024 * 1024
    count = 0
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if not entry.name.endswith(".json") or entry.name.endswith(".meta.json"):
                    continue
                count += 1
                info = entry.stat(follow_symlinks=False)
                budget -= info.st_size
                if (count > 512 or budget < 0 or info.st_size > 16 * 1024 * 1024
                        or entry.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400):
                    raise JournalError("活动记录超过安全核对范围或存在重定向；不能确认节点空闲")
                value = json.loads(Path(entry.path).read_text(encoding="utf-8"))
                if not isinstance(value, dict) or not value.get("sessionId"):
                    raise JournalError("活动记录缺少会话归属；不能确认节点空闲")
                yield value
    except (OSError, ValueError) as error:
        raise JournalError("活动记录损坏或不可读；不能确认节点空闲") from error


def loop_unsettled(data: dict[str, Any]) -> bool:
    from .loop_execution_environment import normalize_environment
    from .loop_task_recovery import repair_active
    operation = data.get("controlOperation") or {}
    return bool(data.get("running") or data.get("startup", {}).get("status") in {"running", "unknown"}
                or operation and operation.get("status") not in {"succeeded", "failed", "blocked", "interrupted"}
                or repair_active(data.get("contractRepairs"))
                or any(not b["quiesced"] for b in normalize_environment(data.get("executionEnvironment"))["blockers"]))

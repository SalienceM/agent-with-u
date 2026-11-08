"""安装前有界、只读检查持久化活动；不可读不等于空闲。"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Iterator

from .aside_files import secure_open
from .aside_inspection import InspectionError
from .kit_activity_json import ActivityJSON
from .kit_update_journal import JournalError


_FIELDS = {
    "sessionId": True, "runs": [{"id": True, "status": True}],
    "running": True, "startup": {"status": True}, "controlOperation": True,
    "contractRepairs": [{"version": True, "status": True}], "executionEnvironment": True,
}


def _revision(info: os.stat_result) -> tuple[int, ...]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def records(store: Any) -> Iterator[dict[str, Any]]:
    folder = getattr(store, "_dir", None)
    if folder is None:
        return
    budget = 64 * 1024 * 1024
    activity_budget = 16 * 1024 * 1024
    count = 0
    cached = getattr(store, "_update_activity_cache", {})
    current = {}
    try:
        folder = Path(folder).absolute()
        folder_before = folder.stat(follow_symlinks=False)
        if stat.S_ISLNK(folder_before.st_mode) or getattr(folder_before, "st_file_attributes", 0) & 0x400:
            raise JournalError("活动记录目录存在重定向；不能确认节点空闲")
        with secure_open(folder, True), os.scandir(folder) as entries:
            for entry in entries:
                if not entry.name.endswith(".json") or entry.name.endswith(".meta.json"):
                    continue
                count += 1
                if count > 512:
                    raise JournalError("活动记录数量超过 512 份安全核对上限；不能确认节点空闲")
                # Windows DirEntry.stat() 的 dev/ino 为零，不能与真实句柄修订比较。
                info = Path(entry.path).stat(follow_symlinks=False)
                if (not stat.S_ISREG(info.st_mode) or entry.is_symlink()
                        or getattr(info, "st_file_attributes", 0) & 0x400):
                    raise JournalError("活动记录不是普通文件或存在重定向；不能确认节点空闲")
                version = _revision(info)
                old = cached.get(entry.name)
                if old and old[0] == version:
                    value = old[1]
                else:
                    budget -= info.st_size
                    if budget < 0:
                        raise JournalError("活动记录本次读取超过 64 MiB 安全核对上限；不能确认节点空闲")
                    # 旧文件仍校验完整 JSON，但不构建 loops/日志等无关历史对象。
                    # 句柄、读取前后修订都核对；缓存从不作为过期文件的空闲证明。
                    with secure_open(Path(entry.path), False) as fd:
                        if _revision(os.fstat(fd)) != version:
                            raise JournalError("活动记录在核对期间变化；请稍后重试")
                        with os.fdopen(os.dup(fd), "r", encoding="utf-8") as stream:
                            value = ActivityJSON(stream, limit=activity_budget, max_chars=info.st_size).read(_FIELDS)
                        if _revision(os.fstat(fd)) != version:
                            raise JournalError("活动记录在核对期间变化；请稍后重试")
                if _revision(Path(entry.path).stat(follow_symlinks=False)) != version:
                    raise JournalError("活动记录在核对期间变化；请稍后重试")
                if not isinstance(value, dict) or not isinstance(value.get("sessionId"), str) or not value["sessionId"]:
                    raise JournalError("活动记录缺少会话归属；不能确认节点空闲")
                activity_budget -= len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
                if activity_budget < 0:
                    raise JournalError("活动状态字段超过安全核对上限；不能确认节点空闲")
                current[entry.name] = (version, value)
                yield value
        if _revision(folder.stat(follow_symlinks=False)) != _revision(folder_before):
            raise JournalError("活动记录目录在核对期间变化；请稍后重试")
        store._update_activity_cache = current
    except InspectionError as error:
        raise JournalError("活动记录路径无法安全读取或存在重定向；不能确认节点空闲") from error
    except (OSError, ValueError) as error:
        raise JournalError("活动记录损坏或不可读；不能确认节点空闲") from error


def loop_unsettled(data: dict[str, Any]) -> bool:
    from .loop_execution_environment import normalize_environment
    from .loop_task_recovery import repair_active
    operation = data.get("controlOperation") or {}
    return bool(data.get("running") or (data.get("startup") or {}).get("status") in {"running", "unknown"}
                or operation and operation.get("status") not in {"succeeded", "failed", "blocked", "interrupted"}
                or repair_active(data.get("contractRepairs"))
                or any(not b["quiesced"] for b in normalize_environment(data.get("executionEnvironment"))["blockers"]))

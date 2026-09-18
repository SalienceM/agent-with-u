"""仓库批量文件导入；不准备依赖、不启用 Skill，也不运行模型。"""
from __future__ import annotations

import asyncio
import json
from collections import Counter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .skill_market import SkillMarket


def parse_batch(raw: str) -> list[dict]:
    items = json.loads(raw)
    if not isinstance(items, list) or not 1 <= len(items) <= 500:
        raise ValueError("一次批量安装需包含 1–500 个 Skill")
    seen: set[str] = set()
    result = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"path", "digest"}:
            raise ValueError("批量条目必须包含预览中的 path 和 digest")
        path, digest = item["path"], item["digest"]
        if not isinstance(path, str) or len(path) > 2048 or path in seen:
            raise ValueError("批量条目路径无效或重复")
        if not isinstance(digest, str) or not digest or len(digest) > 128:
            raise ValueError("缺少有效的内容指纹，请重新预览")
        seen.add(path)
        result.append({"path": path, "digest": digest})
    return result


async def install_batch(market: SkillMarket, source_id: str, items: list[dict],
                        allow_replace: bool, progress: dict) -> dict:
    source = next((s for s in market.list_sources() if s["id"] == source_id), None)
    if not source:
        raise ValueError("仓库来源不存在，请刷新市场")
    candidates, ref, _issues = await market._catalog_for_source(source, force=False)
    by_path = {str(c.get("path") or ""): c for c in candidates}
    counts = Counter(by_path[item["path"]]["name"].casefold() for item in items if item["path"] in by_path)
    for index, item in enumerate(items):
        row = progress["items"][index]
        row["status"] = "running"
        candidate = by_path.get(item["path"])
        try:
            if not candidate or candidate["digest"] != item["digest"]:
                raise ValueError("条目已变化，请刷新预览后重新安装")
            row["name"] = candidate["name"]
            current = await asyncio.to_thread(market._public_item, source, candidate, ref)
            reason = ""
            if counts[candidate["name"].casefold()] > 1:
                reason = "仓库内存在多个同名 Skill，请分别选择安装"
            elif current["installed"] and current["sameSource"] and not current["updateAvailable"]:
                reason = "已是当前版本"
            elif not allow_replace and (current["conflict"] or current["localModified"]):
                reason = "保留现有同名 Skill 或本地修改"
            if reason:
                row.update(status="skipped", message=reason)
            else:
                installed = await market.install(source_id, item["path"], item["digest"],
                                                 allow_replace=allow_replace, protect_local=True)
                row.update(status="installed", name=installed.get("name") or candidate["name"], message="文件已导入")
        except Exception as exc:
            row.update(status="failed", message=str(exc)[:1000])
        progress["completed"] = index + 1
    failed = sum(row["status"] == "failed" for row in progress["items"])
    return {"status": "partial" if failed else "ok", "batch": progress}

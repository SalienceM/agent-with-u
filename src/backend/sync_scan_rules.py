"""Versioned comparison-only scope. Keep semantics aligned with syncScanRules.ts."""
from __future__ import annotations

from fnmatch import fnmatchcase
from functools import lru_cache
import re


class ScanRules:
    def __init__(self, value: object = None) -> None:
        if value is None:
            value = {"version": 1, "prefixes": [], "excludes": []}
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError("不支持的扫描规则版本")
        self.prefixes = self._lines(value.get("prefixes"), False)
        self.excludes = self._lines(value.get("excludes"), True)

    @staticmethod
    def _lines(value: object, patterns: bool) -> list[str]:
        if not isinstance(value, list) or len(value) > 128 or any(not isinstance(x, str) for x in value):
            raise ValueError("每栏最多 128 条扫描规则")
        if sum(len(x) + 1 for x in value) > 16_384:
            raise ValueError("扫描规则过长")
        result = []
        for raw in value:
            line = raw.strip().replace("\\", "/")
            if not line or line.startswith("#"):
                continue
            if line.startswith("./"):
                line = line[2:]
            body = line.removeprefix("!").removeprefix("/") if patterns else line
            if (not body or len(body) > 512 or re.search(r"[:\x00-\x1f\[\]{}]", body)
                    or (not patterns and re.search(r"[*?!]", body)) or body.startswith("/")
                    or any(p in ("", ".", "..") for p in body.removesuffix("/").split("/"))
                    or (patterns and any("**" in p and p != "**" for p in body.split("/")))):
                raise ValueError(f"不支持的扫描规则：{line}")
            if patterns or line not in result:
                result.append(line)
        return result

    def to_dict(self) -> dict:
        return {"version": 1, "prefixes": self.prefixes, "excludes": self.excludes}

    def allows(self, rel: str, directory: bool = False) -> bool:
        if self.prefixes and not any(rel.startswith(p) or (directory and (
                p.startswith(rel + "/") or rel == p.removesuffix("/"))) for p in self.prefixes):
            return False
        parts = rel.split("/")
        for end in range(1, len(parts) + 1):
            is_dir = end < len(parts) or directory
            path = "/".join(parts[:end])
            excluded = False
            for raw in self.excludes:
                negate = raw.startswith("!")
                pattern = raw.removeprefix("!")
                anchored, dir_only = pattern.startswith("/"), pattern.endswith("/")
                pattern = pattern.removeprefix("/").removesuffix("/")
                if dir_only and not is_dir:
                    continue
                target = path if anchored or "/" in pattern else parts[end - 1]
                if _glob(pattern, target):
                    excluded = not negate
            if excluded:
                return False
        return True


def _glob(pattern: str, path: str) -> bool:
    pats, parts = pattern.split("/"), path.split("/")

    @lru_cache(None)
    def match(i: int, j: int) -> bool:
        if i == len(pats):
            return j == len(parts)
        if pats[i] == "**":
            return match(i + 1, j) or (j < len(parts) and match(i, j + 1))
        return j < len(parts) and fnmatchcase(parts[j], pats[i]) and match(i + 1, j + 1)

    return match(0, 0)

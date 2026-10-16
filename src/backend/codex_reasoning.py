"""Codex 档位是目录返回的字符串；只校验安全 token，不维护模型能力白名单。"""

import re


def normalize_reasoning_effort(value: object) -> str:
    if not isinstance(value, str):
        return ""
    effort = value.strip().lower()
    return effort if re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", effort) else ""

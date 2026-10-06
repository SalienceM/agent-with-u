"""Codex 候选仅用于界面建议，不参与运行模型的白名单校验。"""

import unicodedata
from typing import Optional


def normalize_model_options(value: object) -> Optional[list[dict[str, str]]]:
    """保留 None / [] 的区别，返回独立副本，非法数据整体拒绝。"""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("modelOptions 必须是最多 100 项的数组或 null")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        prefix = f"modelOptions 第 {index + 1} 项"
        if not isinstance(item, dict) or set(item) - {"id", "label"}:
            raise ValueError(f"{prefix} 必须是只含 id 和可选 label 的对象")
        if not isinstance(item.get("id"), str):
            raise ValueError(f"{prefix} ID 必须是字符串")
        model_id = item["id"].strip()
        if (not model_id or len(model_id) > 200 or any(
            ch.isspace() or unicodedata.category(ch) == "Cc" for ch in model_id
        )):
            raise ValueError(f"{prefix} ID 必须为 1–200 字符，不能包含空白或控制字符")
        if model_id in seen:
            raise ValueError(f"{prefix} ID 重复：{model_id}")
        label = item.get("label", "")
        if not isinstance(label, str):
            raise ValueError(f"{prefix} 显示名称必须是字符串")
        label = label.strip()
        if len(label) > 120 or any(unicodedata.category(ch) == "Cc" for ch in label):
            raise ValueError(f"{prefix} 显示名称最多 120 字符，不能包含控制字符")
        seen.add(model_id)
        result.append({"id": model_id, **({"label": label} if label else {})})
    return result

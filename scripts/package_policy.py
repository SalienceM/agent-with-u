"""冻结包只携带进程内依赖；本地 STT 由外部系统 Python 执行。"""
from __future__ import annotations

from typing import Any


# 不卸载构建机依赖，也不排除其他功能可能使用的 numpy/Pillow 等共享库。
FROZEN_EXCLUDES = ("faster_whisper", "ctranslate2", "onnxruntime", "av", "deepseek_harness_runtime")


def validate_analysis(analysis: Any) -> None:
    """在生成 EXE 前检查实际 TOC，防止 hook/data 收集绕过 import 排除。"""
    unwanted: set[str] = set()
    for collection in (analysis.pure, analysis.binaries, analysis.datas):
        for name, *_ in collection:
            normalized = name.replace("\\", "/")
            root = normalized.split("/", 1)[0].split(".", 1)[0]
            if root in FROZEN_EXCLUDES or any(part.startswith("deepseek-harness-sdk-runtime-")
                                             or part.startswith("deepseek_harness_runtime_bin-")
                                             for part in normalized.split("/")):
                unwanted.add(name)
    if unwanted:
        examples = ", ".join(sorted(unwanted)[:8])
        raise RuntimeError("External local-STT/Harness dependencies leaked into frozen package: " + examples)

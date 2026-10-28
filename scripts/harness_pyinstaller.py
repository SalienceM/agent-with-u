"""Windows/Linux/Web 共用 Harness 收集规则，缺失制品即阻止打包。"""
from __future__ import annotations

from pathlib import Path


def collect() -> tuple[list[tuple[str, str]], list[tuple[str, str]], list[str]]:
    from PyInstaller.utils.hooks import collect_all, copy_metadata
    from src.backend.deepseek_harness_distribution import verify_bundle
    verify_bundle()
    root = Path(__file__).resolve().parents[1]
    data, binaries, imports = [], [], []
    for module in ("deepseek_harness", "deepseek_harness_runtime"):
        rows, native, hidden = collect_all(module)
        data.extend(rows)
        binaries.extend(native)
        imports.extend(hidden)
    for distribution in ("deepseek-harness-sdk", "deepseek-harness-runtime-bin"):
        data.extend(copy_metadata(distribution))
    data.extend([(str(root / "build/deepseek-harness/bridge"), "deepseek-harness/bridge"),
                 (str(root / "build/deepseek-harness/bundle-manifest.json"), "deepseek-harness")])
    return data, binaries, imports

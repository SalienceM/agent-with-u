"""Windows/Linux/Web 共用 Harness 收集规则，缺失制品即阻止打包。"""
from __future__ import annotations

from pathlib import Path


def collect() -> tuple[list[tuple[str, str]], list[tuple[str, str]], list[str]]:
    from PyInstaller.utils.hooks import collect_all, copy_metadata
    from src.backend.deepseek_harness_distribution import verify_adapter
    verify_adapter()
    root = Path(__file__).resolve().parents[1]
    data, binaries, imports = [], [], []
    for module in ("deepseek_harness",):
        rows, native, hidden = collect_all(module)
        data.extend(rows)
        binaries.extend(native)
        imports.extend(hidden)
    for distribution in ("deepseek-harness-sdk",):
        data.extend(copy_metadata(distribution))
    data.extend([(str(root / "build/deepseek-harness/bridge"), "deepseek-harness/bridge"),
                 (str(root / "build/deepseek-harness/bundle-manifest.json"), "deepseek-harness")])
    data.append((str(root / "deploy/deepseek-harness.external.json"), "deepseek-harness"))
    # PyInstaller 的 tuple 目标是目录，保持与源码文件一致的文件名。
    return data, binaries, imports

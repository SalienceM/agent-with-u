"""精确发行清单校验与 PyInstaller 资源定位，不连接任何服务。"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from .deepseek_harness_config import COMMIT, VERSION


def _verify_file(path: Path, details: dict[str, Any], root: Path, *, repair_executable: bool = False) -> None:
    from .deepseek_harness_state import reject_links
    reject_links(path)
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise RuntimeError("Harness 发行资源缺失或越界: " + path.name)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != details["sha256"]:
        raise RuntimeError("Harness 发行资源校验失败: " + path.name)
    if details["executable"] and sys.platform == "linux" and not os.access(path, os.X_OK):
        if not repair_executable:
            raise RuntimeError("Harness 发行可执行权限缺失: " + path.name)
        path.chmod(path.stat().st_mode | 0o100)


def target_platform() -> str:
    if platform.machine().lower() not in {"amd64", "x86_64"} or sys.platform not in {"win32", "linux"}:
        raise RuntimeError("Harness 仅验证 Windows amd64 和 Linux x86_64")
    return "win-x64" if sys.platform == "win32" else "linux-x64"


def bundle_manifest() -> tuple[Path, dict[str, Any]]:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    folder = base / ("deepseek-harness" if getattr(sys, "frozen", False) else "build/deepseek-harness")
    manifest = json.loads((folder / "bundle-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or manifest.get("version") != VERSION or manifest.get("commit") != COMMIT:
        raise RuntimeError("Harness 发行清单版本不匹配")
    return base, manifest


def verify_bundle(*, repair_executable: bool = False) -> dict[str, Path]:
    base, manifest = bundle_manifest()
    target = target_platform()
    frozen = getattr(sys, "frozen", False)
    from deepseek_harness_runtime import bundled_package_dir
    site = bundled_package_dir().parent
    files = {**manifest["platforms"][target], **manifest["bridge"]}
    found = {}
    for name, details in files.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
            raise RuntimeError("Harness 发行清单路径无效")
        root = base if frozen else base / "build" if name.startswith("deepseek-harness/") else site
        path = root.joinpath(*relative.parts)
        # DATA 解包可能不保留 x 位；只能修复已校验的本次冻结解包文件。
        _verify_file(path, details, root, repair_executable=frozen and repair_executable)
        found[name] = path
    for distribution in ("deepseek-harness-sdk", "deepseek-harness-runtime-bin"):
        if importlib.metadata.version(distribution) != VERSION:
            raise RuntimeError("Harness 配套 SDK/runtime 版本不匹配")
    return found


def verify_runtime_override(path: Path) -> Path:
    """允许迁移配套目录，不接受仅自报相同版本的未知可执行体。"""
    _, manifest = bundle_manifest()
    target = target_platform()
    expected = "deepseek-harness-sdk-runtime-" + target + (".exe" if target == "win-x64" else "")
    if not path.is_absolute() or path.name != expected:
        raise RuntimeError("Harness 路径覆盖必须指向锁定发行的原名可执行体")
    prefix = "deepseek_harness_runtime/runtime/"
    resources = {name[len(prefix):]: details for name, details in manifest["platforms"][target].items()
                 if name.startswith(prefix)}
    if expected not in resources:
        raise RuntimeError("Harness 发行清单缺少运行时")
    for name, details in resources.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
            raise RuntimeError("Harness 路径覆盖清单无效")
        _verify_file(path.parent.joinpath(*relative.parts), details, path.parent)
    return path.resolve()

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

from .deepseek_harness_config import COMMIT, VERSION, RUNTIME_VERSION
from .deepseek_harness_image_contract import image_resource_contract

IMAGE_CONTRACT_FILE = "image-contract.json"
BRIDGE_RESOURCE_NAMES = ("lib/index.mjs", "package.json", "UPSTREAM-LICENSE", "THIRD_PARTY_NOTICES.md")


def require_image_contract(value: Any) -> None:
    # JSON 的布尔值不能用 Python 的 True == 1 冒充扩展版本/限额。
    if json.dumps(value, sort_keys=True, allow_nan=False) != json.dumps(image_resource_contract(), sort_keys=True):
        raise RuntimeError("Harness 图片资源契约不匹配")


def distribution_base() -> Path:
    return Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2]


def bundle_directory() -> Path:
    return distribution_base() / ("deepseek-harness" if getattr(sys, "frozen", False) else "build/deepseek-harness")


def verify_image_bridge(entry: Path) -> dict[str, Any]:
    """只读验证选中的桥；旧文字桥可继续用，但不能取得图片资源资格。"""
    from .deepseek_harness_state import reject_links
    try:
        if entry.name != "index.mjs" or entry.parent.name != "lib":
            raise ValueError("unexpected bridge layout")
        folder = entry.parent.parent
        contract_file = folder / IMAGE_CONTRACT_FILE
        reject_links(contract_file)
        if contract_file.stat().st_size > 16 * 1024:
            raise ValueError("contract too large")
        record = json.loads(contract_file.read_text(encoding="utf-8"))
        if (not isinstance(record, dict) or set(record) != {"schema", "contract", "resources"}
                or type(record["schema"]) is not int or record["schema"] != 1):
            raise ValueError("contract schema")
        require_image_contract(record["contract"])
        resources = record["resources"]
        if not isinstance(resources, dict) or set(resources) != set(BRIDGE_RESOURCE_NAMES):
            raise ValueError("contract inventory")
        for name in BRIDGE_RESOURCE_NAMES:
            details = resources[name]
            if (not isinstance(details, dict) or set(details) != {"sha256", "executable"}
                    or details["executable"] is not False):
                raise ValueError("contract resource")
            _verify_file(folder / name, details, folder)
        package = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        if (not isinstance(package, dict) or package.get("name") != "@agentwithu/deepseek-harness-bridge"
                or package.get("version") != RUNTIME_VERSION):
            raise ValueError("contract package")
        return record["contract"]
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        # 不把路径、JSON 或底层异常串到聊天；不执行桥来探测缺失资源。
        raise RuntimeError("Harness 图片资源缺失或不匹配，禁止提交图片；请重新准备配套桥") from None


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
    base = distribution_base()
    folder = bundle_directory()
    manifest = json.loads((folder / "bundle-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or manifest.get("version") != VERSION or manifest.get("commit") != COMMIT:
        raise RuntimeError("Harness 发行清单版本不匹配")
    return base, manifest


def verify_adapter() -> dict[str, Path]:
    """只验证 AWU 包内轻量层；不导入 runtime-bin、不寻找 Node 或访问网络。"""
    base, manifest = bundle_manifest()
    from .deepseek_harness_cli import load_external_contract
    load_external_contract()
    if importlib.metadata.version("deepseek-harness-sdk") != VERSION:
        raise RuntimeError("Harness SDK 版本不匹配")
    frozen = getattr(sys, "frozen", False)
    site = Path(importlib.metadata.distribution("deepseek-harness-sdk").locate_file(""))
    files = {**{name: row for name, row in manifest["platforms"][target_platform()].items()
                if name.startswith("deepseek_harness_sdk-")}, **manifest["bridge"]}
    expected = {"deepseek-harness/bridge/" + name for name in (*BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE)}
    if set(manifest["bridge"]) != expected or not any(name.endswith("/METADATA") for name in files):
        raise RuntimeError("Harness 轻量资源清单缺失")
    found = {}
    for name, details in files.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
            raise RuntimeError("Harness 发行清单路径无效")
        root = base if frozen else base / "build" if name.startswith("deepseek-harness/") else site
        path = root.joinpath(*relative.parts)
        _verify_file(path, details, root)
        found[name] = path
    require_image_contract(manifest.get("imageContract"))
    verify_image_bridge(found["deepseek-harness/bridge/lib/index.mjs"])
    return found


def verify_bundle(*, repair_executable: bool = False, require_images: bool = False) -> dict[str, Path]:
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
    if require_images or "imageContract" in manifest:
        require_image_contract(manifest.get("imageContract"))
        expected = {"deepseek-harness/bridge/" + name for name in (*BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE)}
        if set(manifest["bridge"]) != expected:
            raise RuntimeError("Harness 图片资源清单缺失或不匹配")
        verify_image_bridge(found["deepseek-harness/bridge/lib/index.mjs"])
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

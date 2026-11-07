"""所属执行节点的外部 Harness 定位；只读检查，不运行 npm/npx 或安装脚本。"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
from typing import Mapping, Any

from .deepseek_harness_config import COMMIT, RUNTIME_VERSION

INSTALL_COMMAND = "npm install -g @deepseek-ai/dsh@0.2.1-rc.3"
DEPENDENCY_REASONS = frozenset({"cli_missing", "path_invalid", "node_missing", "node_version",
                              "version_mismatch", "installation_invalid", "contract_invalid"})


class HarnessDependencyError(RuntimeError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        descriptions = {"cli_missing": "未找到外部 Harness CLI", "path_invalid": "指定的 Harness cliPath 无效，不自动回退",
            "node_missing": "缺少 Node.js", "node_version": "Node.js 不兼容，需要 Node 24（至少 24.10）",
            "version_mismatch": "Harness CLI 版本不匹配", "installation_invalid": "Harness CLI 安装不完整或关键资源已变化",
            "contract_invalid": "AWU 外部 Harness 资源契约缺失或不匹配"}
        super().__init__(f"{descriptions[reason]}。请在本 Session 所属执行节点准备 Node 24，然后执行 `{INSTALL_COMMAND}`；"
                         "AWU 不会自动安装、升级或重发输入。")


def external_contract_path() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "deepseek-harness/deepseek-harness.external.json"
    return Path(__file__).resolve().parents[2] / "deploy/deepseek-harness.external.json"


def load_external_contract() -> dict[str, Any]:
    try:
        path = external_contract_path()
        if path.stat().st_size > 256 * 1024:
            raise ValueError("oversize")
        data = json.loads(path.read_text(encoding="utf-8"))
        if (data.get("schema") != 1 or data.get("version") != RUNTIME_VERSION or data.get("commit") != COMMIT
                or data.get("nodeMajor") != 24 or data.get("nodeMinimum") != [24, 10, 0]
                or not isinstance(data.get("packages"), dict) or "@deepseek-ai/dsh" not in data["packages"]):
            raise ValueError("identity")
        return data
    except (OSError, ValueError, TypeError):
        raise HarnessDependencyError("contract_invalid") from None


@dataclass(frozen=True)
class ExternalHarness:
    node: Path
    entry: Path
    source: str
    version: str = RUNTIME_VERSION

    def argv(self, profile: str, patches: tuple[str, ...]) -> tuple[str, ...]:
        result = [str(self.node), str(self.entry), "--profile", profile]
        for overlay in patches:
            result.extend(("--patch", str(overlay)))
        return tuple(result)


def _package_from_entry(candidate: Path) -> Path:
    """不执行/解释 shim 文本；只接纳 npm 标准同目录布局或真实包入口。"""
    if not candidate.is_file():
        raise HarnessDependencyError("path_invalid")
    resolved = candidate.resolve()
    if resolved.name == "bin.js" and resolved.parent.name == "lib":
        return resolved.parent.parent
    if candidate.name.lower() not in {"dsh", "dsh.cmd", "dsh.ps1"}:
        raise HarnessDependencyError("path_invalid")
    folder = candidate.parent / "node_modules/@deepseek-ai/dsh"
    if not (folder / "lib/bin.js").is_file():
        raise HarnessDependencyError("installation_invalid")
    return folder.resolve()


def verify_external_package(package: Path, contract: dict[str, Any]) -> None:
    try:
        meta = json.loads((package / "package.json").read_text(encoding="utf-8"))
        if meta.get("name") != "@deepseek-ai/dsh" or meta.get("version") != RUNTIME_VERSION:
            raise HarnessDependencyError("version_mismatch")
        if meta.get("bin") != {"dsh": "lib/bin.js"} or package.parent.name != "@deepseek-ai":
            raise ValueError("package layout")
        modules = package.parent.parent
        for name, record in contract["packages"].items():
            if not re.fullmatch(r"@deepseek-ai/dsh(?:-[a-z0-9-]+)?", name):
                raise ValueError("package identity")
            folder = modules / name
            manifest = json.loads((folder / "package.json").read_text(encoding="utf-8"))
            if manifest.get("name") != name or manifest.get("version") != record["version"]:
                raise HarnessDependencyError("version_mismatch")
            for relative, expected in record["resources"].items():
                member = PurePosixPath(relative)
                if member.is_absolute() or ".." in member.parts or "\\" in relative or ":" in relative:
                    raise ValueError("resource path")
                file = folder.joinpath(*member.parts)
                if not file.resolve().is_relative_to(folder.resolve()) or file.stat().st_size > 16 * 1024 * 1024:
                    raise ValueError("resource boundary")
                if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
                    raise ValueError("resource digest")
    except (OSError, ValueError, TypeError, KeyError):
        raise HarnessDependencyError("installation_invalid") from None


def _node_for(candidate: Path, environment: Mapping[str, str]) -> Path:
    sibling = candidate.parent / ("node.exe" if os.name == "nt" else "node")
    found = str(sibling) if sibling.is_file() else shutil.which("node", path=environment.get("PATH", ""))
    if not found:
        raise HarnessDependencyError("node_missing")
    node = Path(found).resolve()
    # 在校验 Node 版本时也不接受宿主注入，且不打印原始环境/输出。
    env = {key: value for key, value in environment.items() if key.upper() not in {"NODE_OPTIONS", "NODE_PATH"}}
    try:
        output = subprocess.run([str(node), "--version"], env=env, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, timeout=5, check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0).stdout.strip()
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", output)
        version = tuple(map(int, match.groups())) if match else ()
        if not version or version[0] != 24 or version < (24, 10, 0):
            raise ValueError("unsupported Node")
    except (OSError, ValueError, subprocess.SubprocessError):
        raise HarnessDependencyError("node_version") from None
    return node


def resolve_external_cli(explicit: str | None = None, *, environment: Mapping[str, str] | None = None) -> ExternalHarness:
    env = os.environ if environment is None else environment
    contract = load_external_contract()
    candidates: list[tuple[Path, str]] = []
    if explicit:
        path = Path(explicit)
        if not path.is_absolute():
            raise HarnessDependencyError("path_invalid")
        candidates.append((path, "explicit"))
    else:
        if os.name == "nt" and env.get("APPDATA"):
            candidates.append((Path(env["APPDATA"]) / "npm/dsh.cmd", "npm-global"))
        # 查找标准 npm 入口，不执行碰巧同名的 Python dsh.exe。
        for folder in env.get("PATH", "").split(os.pathsep):
            if folder and Path(folder).is_absolute():
                for name in (("dsh.cmd", "dsh.ps1", "dsh") if os.name == "nt" else ("dsh",)):
                    candidates.append((Path(folder) / name, "PATH"))
    for candidate, source in candidates:
        if not candidate.is_file() and not explicit:
            continue
        package = _package_from_entry(candidate)
        verify_external_package(package, contract)
        return ExternalHarness(_node_for(candidate, env), package / "lib/bin.js", source)
    raise HarnessDependencyError("cli_missing")

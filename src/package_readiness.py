"""冻结包自检与构建探针隔离；不初始化用户存储或调用模型。"""
from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import sys
from typing import Any

MODULES = (
    "websockets", "PIL.Image", "httpx", "claude_agent_sdk", "qwen_code_sdk",
    "anthropic", "dashscope", "edge_tts", "yaml", "pydantic_core", "mcp", "pathspec",
)
RESOURCES = ("awu-jdt-diagnostics.jar", "typescript-diagnostics.cjs")


def check_components(*, resources: bool = True, web: bool = False) -> dict[str, Any]:
    failures: list[str] = []
    modules = list(MODULES)
    if sys.version_info < (3, 11):
        modules.append("tomli")
    if sys.platform == "win32":
        modules.extend(("winpty", "winpty.enums"))
    for name in modules:
        try:
            module = importlib.import_module(name)
            if name == "pathspec":
                getattr(module, "GitIgnoreSpec")
        except Exception:
            failures.append("module:" + name)
    if resources:
        base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
        directory = base / ("engine-providers" if getattr(sys, "frozen", False) else "tools/engine-providers")
        for name in RESOURCES:
            try:
                with (directory / name).open("rb") as source:
                    if not source.read(1):
                        raise ValueError("empty")
            except (OSError, ValueError):
                failures.append("resource:" + name)
        if web and not (base / "frontend_dist/index.html").is_file():
            failures.append("resource:frontend_dist/index.html")
    from ._version import __version__
    return {"ok": not failures, "failures": failures, "version": __version__, "platform": sys.platform}


def probe_root() -> Path | None:
    value = os.environ.get("AGENT_WITH_U_PACKAGE_PROBE_ROOT")
    if not value:
        return None
    root = Path(value).resolve(strict=True)
    if not (root / ".awu-package-probe").is_file():
        raise RuntimeError("invalid package probe root")
    expected = {"USERPROFILE": root / "home", "HOME": root / "home",
                "APPDATA": root / "appdata", "LOCALAPPDATA": root / "localappdata",
                "AGENT_WITH_U_DATA_ROOT": root / "data"}
    for name, path in expected.items():
        if Path(os.environ.get(name, "")).resolve() != path or not path.is_dir():
            raise RuntimeError("invalid package probe isolation: " + name)
    if Path.home().resolve() != root / "home" or Path.cwd().resolve() != root / "work":
        raise RuntimeError("invalid package probe home/cwd")
    return root


def entry_check(*, web: bool = False) -> None:
    if "--agentwithu-package-probe" in sys.argv:
        # 先等父进程绑定 Job/进程组，再导入可能加载原生库的模块。
        if sys.stdin.readline(16).strip() != "GO":
            raise SystemExit(2)
        if probe_root() is None:
            raise SystemExit(2)
        sys.argv.remove("--agentwithu-package-probe")
    if "--agentwithu-package-check" in sys.argv:
        result = check_components(web=web)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        raise SystemExit(0 if result["ok"] else 1)

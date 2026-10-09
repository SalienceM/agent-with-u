"""共享 sidecar 冻结配置；依赖准备由调用入口先执行。"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.package_readiness import MODULES, RESOURCES


def command() -> list[str]:
    args = [sys.executable, "-m", "PyInstaller", "--name", "agent-with-u-backend",
            "--onefile", "--console", "--clean", "--noconfirm"]
    for module in MODULES:
        args.extend(["--hidden-import", module])
    args.extend(["--collect-data", "certifi"])
    for module in ("pydantic_core", "dashscope", "edge_tts", "pathspec"):
        args.extend(["--collect-all", module])
    if sys.version_info < (3, 11):
        args.extend(["--hidden-import", "tomli"])
    if sys.platform == "win32":
        args.extend(["--collect-all", "winpty"])
    for resource in RESOURCES:
        args.extend(["--add-data", f"tools/engine-providers/{resource}{';' if sys.platform == 'win32' else ':'}engine-providers"])
    return args + ["ws_main_entry.py"]


if __name__ == "__main__":
    raise SystemExit(subprocess.call(command(), cwd=ROOT))

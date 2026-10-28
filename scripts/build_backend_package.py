"""共享 sidecar 冻结配置；依赖准备由调用入口先执行。"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def command() -> list[str]:
    return [sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
            "agent-with-u-backend.spec"]


if __name__ == "__main__":
    # 使用共用 spec，避免命令行入口遗漏 Harness metadata/许可证/资源。
    raise SystemExit(subprocess.call(command(), cwd=ROOT))

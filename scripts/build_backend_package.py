"""共享 sidecar 冻结配置；依赖准备由调用入口先执行。"""
from __future__ import annotations

from pathlib import Path
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def command() -> list[str]:
    return [sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
            "agent-with-u-backend.spec"]


def clean_outputs(root: Path) -> None:
    """只清理本次冻结的输出；build 中的 Harness 等目录是构建输入。"""
    root = root.resolve(strict=True)
    filename = "agent-with-u-backend" + (".exe" if sys.platform == "win32" else "")
    targets = [
        (root / "build" / "agent-with-u-backend", True),
        (root / "dist" / filename, False),
        (root / "dist" / (filename + ".readiness.json"), False),
    ]
    # 全部检查通过后再删除，避免链接/junction 把清理导向工作区之外。
    for path, directory in targets:
        if not path.resolve().is_relative_to(root):
            raise ValueError(f"Build output escapes project: {path}")
        current = root
        for part in path.relative_to(root).parts:
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError(f"Refusing linked build output: {current}")
        if path.exists() and path.is_dir() != directory:
            raise ValueError(f"Unexpected build output type: {path}")
    for path, directory in targets:
        if path.exists():
            print(f"[CLEAN] {path.relative_to(root)}", flush=True)
            if directory:
                shutil.rmtree(path)
            else:
                path.unlink()


def build(root: Path = ROOT) -> int:
    try:
        clean_outputs(root)
        # 使用共用 spec，避免命令行入口遗漏 Harness metadata/许可证/资源。
        return subprocess.call(command(), cwd=root)
    except (OSError, ValueError) as exc:
        print(f"[FAILED] Backend packaging: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(build())

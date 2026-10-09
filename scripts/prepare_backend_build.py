"""使用本次打包解释器准备应用依赖；失败不得进入 PyInstaller。"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def validate_requirements() -> list[str]:
    try:
        from packaging.requirements import Requirement
    except ImportError:
        # PyInstaller 尚未安装的干净环境也能解析依赖；pip 本身携带解析器。
        from pip._vendor.packaging.requirements import Requirement
    failures: list[str] = []
    for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        req = Requirement(line)
        if req.marker and not req.marker.evaluate():
            continue
        try:
            version = importlib.metadata.version(req.name)
            if version not in req.specifier:
                failures.append("version:" + req.name)
        except importlib.metadata.PackageNotFoundError:
            failures.append("missing:" + req.name)
    return failures


def prepare(*, install: bool = True) -> int:
    print("[dependencies] interpreter=" + sys.executable, flush=True)
    if install:
        result = subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=False)
        if result.returncode:
            return result.returncode
    failures = validate_requirements()
    from src.package_readiness import check_components
    failures.extend(check_components()["failures"])
    result = subprocess.run([sys.executable, "-m", "pip", "check"], check=False)
    if result.returncode:
        failures.append("pip-check")
    print(json.dumps({"ok": not failures, "failures": failures}, ensure_ascii=False))
    return int(bool(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    raise SystemExit(prepare(install=not args.check_only))

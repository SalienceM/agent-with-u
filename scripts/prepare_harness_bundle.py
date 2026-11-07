"""从已校验配套 wheel 生成平台资源清单；不下载、不启动模型。"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.prepare_deepseek_harness import load_lock, verify_wheel
from scripts.harness_image_resources import verify_frontend_contract
from src.backend.deepseek_harness_distribution import BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE, verify_image_bridge


def prepare() -> Path:
    lock = load_lock()
    build = ROOT / "build/deepseek-harness"
    verify_frontend_contract(ROOT)
    image_contract = verify_image_bridge(build / "bridge/lib/index.mjs")
    platforms = {}
    for target, suffix in (("win-x64", "windows"), ("linux-x64", "linux")):
        receipt = json.loads((ROOT / f"deploy/deepseek-harness.build-{suffix}.json").read_text(encoding="utf-8"))
        if receipt["commit"] != lock["commit"] or receipt["pythonVersion"] != lock["pythonVersion"]:
            raise ValueError("Harness build receipt does not match source lock")
        files = {}
        for wheel in receipt["wheels"]:
            path = build / "wheels" / wheel["filename"]
            runtime = "runtime_bin" in path.name
            actual = verify_wheel(path, lock, target if runtime else None)
            if actual["sha256"] != wheel["sha256"]:
                raise ValueError("Harness wheel digest differs from audited build")
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    name = member.filename
                    # Python 模块由 PyInstaller 编译；原始资源和许可证逐文件核对。
                    if member.is_dir() or name.endswith((".py", "/RECORD", "/WHEEL")):
                        continue
                    files[name] = {"sha256": hashlib.sha256(archive.read(member)).hexdigest(),
                                   "executable": bool((member.external_attr >> 16) & 0o111)}
        platforms[target] = files
    bridge = {}
    for name in (*BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE):
        path = build / "bridge" / name
        bridge["deepseek-harness/bridge/" + name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "executable": False}
    manifest = {"schema": 1, "version": lock["pythonVersion"], "commit": lock["commit"],
                "platforms": platforms, "bridge": bridge, "imageContract": image_contract}
    output = build / "bundle-manifest.json"
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    print(prepare())

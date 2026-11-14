"""从固定源码和 npm 安装构建 Docker 轻量适配层，不读取宿主 build 缓存。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.prepare_deepseek_harness import load_lock, verify_source, verify_wheel
from scripts.harness_image_resources import verify_source_contracts, write_bridge_contract
from src.backend.deepseek_harness_cli import load_external_contract, verify_external_package
from src.backend.deepseek_harness_distribution import BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE, verify_image_bridge


def sdk_resources(wheel: Path) -> dict:
    """只登记轻量 SDK 的元数据/许可，不虚构 native runtime 制品。"""
    lock = load_lock()
    actual = verify_wheel(wheel, lock)
    receipt = json.loads((ROOT / "deploy/deepseek-harness.build-linux.json").read_text(encoding="utf-8"))
    expected = next(row for row in receipt["wheels"] if row["filename"] == wheel.name)
    if receipt["commit"] != lock["commit"] or receipt.get("pythonVersion", lock["pythonVersion"]) != lock["pythonVersion"]:
        raise ValueError("Docker Harness SDK receipt differs from source lock")
    if actual["sha256"] != expected["sha256"]:
        # 审计 SDK wheel 在 Windows 生成；Linux hatchling 只把 ZIP 的 create_system
        # 从 0 写成 3。仅统一中央目录这一字段，保留所有文件字节/压缩流/权限。
        # 之后仍要求整包命中原审计 SHA-256，任何其它差异都不能因此通过。
        with zipfile.ZipFile(wheel, "a") as archive:
            for member in archive.infolist():
                member.create_system = 0
            archive.comment = archive.comment  # 让 zipfile 重写中央目录。
        actual = verify_wheel(wheel, lock)
    if actual["sha256"] != expected["sha256"]:
        raise ValueError("Docker Harness SDK differs from audited source build")
    with zipfile.ZipFile(wheel) as archive:
        return {member.filename: {
            "sha256": hashlib.sha256(archive.read(member)).hexdigest(), "executable": False,
        } for member in archive.infolist()
            if not member.is_dir() and not member.filename.endswith((".py", "/RECORD", "/WHEEL"))}


def build(source: Path, modules: Path, node: Path) -> Path:
    lock = load_lock()
    verify_source(source, lock)
    if subprocess.check_output([str(node), "--version"], text=True).strip() != "v" + lock["toolchain"]["node"]:
        raise ValueError("Docker Harness build requires the locked Node toolchain")
    verify_external_package(modules / "@deepseek-ai/dsh", load_external_contract())
    verify_source_contracts(ROOT, node)
    output = ROOT / "build/deepseek-harness"
    wheels = output / "wheels"
    wheels.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, str(source / "scripts/build-python-release.py"),
                    "--package", "sdk", "--output-dir", str(wheels)], check=True)
    wheel = wheels / f"deepseek_harness_sdk-{lock['pythonVersion']}-py3-none-any.whl"
    resources = sdk_resources(wheel)
    bridge = output / "bridge"
    (bridge / "lib").mkdir(parents=True, exist_ok=True)
    package = ROOT / "tools/deepseek-harness"
    subprocess.run([
        str(modules / "esbuild/bin/esbuild"), str(package / "index.ts"),
        "--bundle", "--platform=node", "--format=esm", "--target=node24",
        "--banner:js=import { createRequire as awuCreateRequire } from 'node:module'; const require = awuCreateRequire(import.meta.url);",
        f"--outfile={bridge / 'lib/index.mjs'}",
        *[f"--alias:@deepseek-ai/{name}={modules / '@deepseek-ai' / name}" for name in (
            "dsh-sdk-jsonrpc-server", "dsh-sdk-protocol", "dsh-mcp-client", "dsh-llm-deepseek", "dsh-llm")],
    ], check=True)
    shutil.copyfile(package / "package.json", bridge / "package.json")
    shutil.copyfile(source / "LICENSE", bridge / "UPSTREAM-LICENSE")
    shutil.copyfile(source / "THIRD_PARTY_NOTICES.md", bridge / "THIRD_PARTY_NOTICES.md")
    write_bridge_contract(bridge, node)
    manifest = {
        "schema": 1, "version": lock["pythonVersion"], "commit": lock["commit"],
        "platforms": {"linux-x64": resources},
        "bridge": {"deepseek-harness/bridge/" + name: {
            "sha256": hashlib.sha256((bridge / name).read_bytes()).hexdigest(), "executable": False,
        } for name in (*BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE)},
        "imageContract": verify_image_bridge(bridge / "lib/index.mjs"),
    }
    (output / "bundle-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    print(build(args.source.resolve(), args.modules.resolve(), args.node.resolve()))

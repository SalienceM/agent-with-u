"""在已准备的固定上游源码中构建受信单连接桥；不下载/安装依赖。"""
from __future__ import annotations

import argparse
import zipfile
import json
import shutil
import subprocess
from pathlib import Path

from prepare_deepseek_harness import load_lock, verify_source


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--esbuild", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    lock = load_lock()
    verify_source(args.source.resolve(), lock)
    version = subprocess.check_output([str(args.node), "--version"], text=True).strip()
    if version != "v" + lock["toolchain"]["node"]:
        raise ValueError("Use the locked Node build toolchain")
    root = Path(__file__).resolve().parents[1]
    package = root / "tools/deepseek-harness"
    if json.loads((package / "package.json").read_text())["version"] != lock["version"]:
        raise ValueError("AWU bridge version must match SDK/runtime")
    output = args.output.resolve()
    # 防止构建输出覆盖源代码、上游 checkout 或用户选择的任意现有目录。
    if not output.is_relative_to(root / "build/deepseek-harness") or output == root / "build/deepseek-harness":
        raise ValueError("Bridge output must be a child of build/deepseek-harness")
    output.mkdir(parents=True, exist_ok=True)
    (output / "lib").mkdir(exist_ok=True)
    subprocess.run([
        str(args.node), str(args.esbuild), str(package / "index.ts"),
        "--bundle", "--platform=node", "--format=esm", "--target=node24",
        "--banner:js=import { createRequire as awuCreateRequire } from 'node:module'; const require = awuCreateRequire(import.meta.url);",
        f"--outfile={output / 'lib/index.mjs'}",
        f"--alias:@deepseek-ai/dsh-sdk-jsonrpc-server={args.source.resolve() / 'packages/sdk/server/src/index.ts'}",
        f"--alias:@deepseek-ai/dsh-sdk-protocol={args.source.resolve() / 'packages/sdk/protocol/src/index.ts'}",
        f"--alias:@deepseek-ai/dsh-mcp-client={args.source.resolve() / 'packages/mcp/mcp-client/src/index.ts'}",
    ], check=True)
    shutil.copyfile(package / "package.json", output / "package.json")
    shutil.copyfile(args.source / "LICENSE", output / "UPSTREAM-LICENSE")
    # 原生 wheel 的许可清单来自同一源码构建，覆盖桥复用的上游依赖。
    wheel = root / "build/deepseek-harness/wheels/deepseek_harness_runtime_bin-0.2.1rc3-py3-none-win_amd64.whl"
    with zipfile.ZipFile(wheel) as archive:
        name = next(name for name in archive.namelist() if name.endswith("/licenses/THIRD_PARTY_NOTICES.md"))
        (output / "THIRD_PARTY_NOTICES.md").write_bytes(archive.read(name))
    print(output / "lib/index.mjs")


if __name__ == "__main__":
    main()

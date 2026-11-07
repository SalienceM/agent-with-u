"""构建时核对三端静态契约并绑定生成资源；不需要 wheel、不安装或运行模型。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
from typing import Any

from src.backend.deepseek_harness_distribution import (
    BRIDGE_RESOURCE_NAMES, IMAGE_CONTRACT_FILE, require_image_contract, verify_image_bridge,
)
from src.backend.deepseek_harness_image_contract import image_resource_contract


def verify_frontend_contract(root: Path) -> None:
    value = json.loads((root / "frontend/src/types/harnessImageContract.json").read_text(encoding="utf-8"))
    require_image_contract(value)


def read_node_contract(node: Path, entry: Path) -> dict[str, Any]:
    # 仅限仓库受信入口/生成入口的静态导出；不调用 apply 或原生运行时。
    command = "const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.IMAGE_RESOURCE_CONTRACT));"
    result = subprocess.run([str(node), "--input-type=module", "-e", command, entry.resolve().as_uri()],
        check=True, capture_output=True, text=True, encoding="utf-8", timeout=15)
    if len(result.stdout) > 16 * 1024:
        raise ValueError("Harness image contract export too large")
    contract = json.loads(result.stdout)
    require_image_contract(contract)
    return contract


def verify_source_contracts(root: Path, node: Path) -> None:
    verify_frontend_contract(root)
    read_node_contract(node, root / "tools/deepseek-harness/image-limits.mjs")


def write_bridge_contract(folder: Path, node: Path) -> None:
    # 先核对实际 bundle 的导出，再签记每个生成文件；失败不生成合格标记。
    read_node_contract(node, folder / "lib/index.mjs")
    resources = {name: {"sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest(),
                        "executable": False} for name in BRIDGE_RESOURCE_NAMES}
    record = {"schema": 1, "contract": image_resource_contract(), "resources": resources}
    (folder / IMAGE_CONTRACT_FILE).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify_image_bridge(folder / "lib/index.mjs")

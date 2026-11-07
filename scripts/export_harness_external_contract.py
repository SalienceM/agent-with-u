"""从已锁定的隔离 npm 安装导出关键资源摘要，不安装、不执行 CLI。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 覆盖启动/解析、协议、会话、权限及图片传输；UI 和未启用插件不属于此契约。
PACKAGES = (
    "dsh", "dsh-app-boot", "dsh-sdk-app", "dsh-sdk-minimal", "dsh-sdk-jsonrpc-server",
    "dsh-sdk-protocol", "dsh-base", "dsh-agent", "dsh-agent-loop", "dsh-llm",
    "dsh-llm-deepseek", "dsh-llm-deepseek-api-key", "dsh-attachment-local",
    "dsh-session", "dsh-session-persistence-jsonl", "dsh-session-log-deepseek",
    "dsh-user-approval", "dsh-sandbox-policy", "dsh-sandbox-local", "dsh-fs-sandbox",
    "dsh-fs-local", "dsh-tool-fs", "dsh-subprocess-local", "dsh-home-paths",
    "dsh-http-proxy", "dsh-launch-environment",
)


def collect(installation: Path) -> dict:
    lock = json.loads((ROOT / "deploy/deepseek-harness.lock.json").read_text(encoding="utf-8"))
    npm_lock = json.loads((installation / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    top = npm_lock["node_modules/@deepseek-ai/dsh"]
    if top["integrity"] != lock["npm"]["integrity"] or top["resolved"] != lock["npm"]["tarball"]:
        raise ValueError("npm installation does not match audited artifact")
    packages = {}
    for name in PACKAGES:
        relative = "node_modules/@deepseek-ai/" + name
        folder = installation / relative
        meta = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        row = npm_lock[relative]
        if meta["name"] != "@deepseek-ai/" + name or meta["version"] != lock["version"]:
            raise ValueError("Wrong critical package: " + name)
        if not row.get("integrity") or not row["resolved"].startswith("https://registry.npmjs.org/"):
            raise ValueError("Unverified critical package origin: " + name)
        resources = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(folder.rglob("*")) if p.is_file() and p.suffix in {".js", ".mjs", ".json", ".yml", ".yaml"}}
        packages[meta["name"]] = {"version": meta["version"], "integrity": row["integrity"],
                                 "resolved": row["resolved"], "resources": resources}
    return {"schema": 1, "version": lock["version"], "commit": lock["commit"],
            "nodeMajor": 24, "nodeMinimum": [24, 10, 0], "packages": packages}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installation", type=Path)
    args = parser.parse_args()
    # 只输出，维护者通过审阅后的补丁保存契约。
    print(json.dumps(collect(args.installation), ensure_ascii=False, indent=2))

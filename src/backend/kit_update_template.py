"""只生成/预览组合；不会修改原 Kit 或启动任何步骤。"""
from __future__ import annotations
import re
from typing import Any


def is_build_command(command: str) -> bool:
    return bool(re.search(r"(?i)(?:^|[\\/\s\"'])build_all\.bat(?:$|[\s\"'])|register_release_candidate\.py", command))


def requested(intent: str) -> bool:
    lowered = intent.casefold()
    return (any(word in lowered for word in ("本机更新", "更新本机", "本机完成更新", "本地更新", "local update"))
            and any(word in lowered for word in ("打包", "build", "package"))
            and any(word in lowered for word in ("发布", "上传", "publish", "upload"))
            and not any(word in lowered for word in ("不要更新", "不更新本机", "不安装", "without updating")))


def build_template(state: Any, intent: str) -> dict[str, Any]:
    candidates = []
    for kit in state.visible_kits():
        if not kit.enabled:
            continue
        steps = kit.steps or [{"type": "command", "target": kit.execution_target, "command": kit.command}]
        if (all(step.get("type", "command") == "command" and step.get("target", "executor") == "executor" for step in steps)
                and sum(is_build_command(step.get("command", "")) for step in steps) == 1):
            candidates.append(kit)
    explicit = [kit for kit in candidates if kit.id in intent]
    if explicit:
        candidates = explicit
    if len(candidates) != 1:
        return {"status": "needs_input", "ready": False,
                "questions": ["请选择一个当前 Session 的已登记构建 Kit（把真实 ID 写入目标）；需使用支持构建登记的 build_all.bat 或 register_release_candidate.py"],
                "candidates": [{"id": kit.id, "title": kit.title} for kit in candidates], "warnings": []}
    build = candidates[0]
    return {"status": "ok", "ready": True, "kit": {
        "title": "打包、发布并更新本机", "description": "本次构建 → 独立发布确认 → 独立安装确认 → 重启验收",
        "executionTarget": "executor", "shell": "powershell", "cwd": ".", "command": "",
        "timeoutSeconds": 21600, "inputs": build.inputs, "enabled": True,
        "steps": [
            {"id": "build", "type": "kit_call", "target": "executor", "title": build.title, "kitId": build.id,
             "captureBuild": True, "inputs": {item["key"]: "{{" + item["key"] + "}}" for item in build.inputs if item.get("key")}},
            {"id": "publish", "type": "awu_capability", "target": "executor", "title": "发布本次构建",
             "config": {"capability": "release.publish_latest", "arguments": {"bindBuild": True, "channel": "stable", "projectRoot": "."}}},
            {"id": "install", "type": "awu_capability", "target": "executor", "title": "安装本次发布并验收重启",
             "config": {"capability": "node.update_local_published", "arguments": {}}},
        ], "schedule": {"mode": "manual"}, "assertions": [{"type": "exit_code", "expected": 0}],
        "outputs": [], "view": {"default": "summary", "showLogs": True, "showTerminal": False},
    }}

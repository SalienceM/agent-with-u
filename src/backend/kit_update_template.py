"""只生成/预览组合；不会修改原 Kit 或启动任何步骤。"""
from __future__ import annotations
import re
from typing import Any
from .kit_capabilities import UPDATE_CAPABILITY, CHECK_UPDATE_CAPABILITY, LOCAL_UPDATE_CAPABILITIES


def validate_update_sequence(configs: list[dict[str, Any]]) -> list[str]:
    """保存与运行使用同一展开计划规则；旧错误 Kit 不自动改变更新来源。"""
    positions = [i for i, config in enumerate(configs) if config.get("capability") in LOCAL_UPDATE_CAPABILITIES]
    errors = []
    if positions and positions != [len(configs) - 1]:
        errors.append("本机更新必须且只能是展开计划的最后一步")
    for index in positions:
        if configs[index].get("capability") == UPDATE_CAPABILITY:
            sources = [config for config in configs[:index] if config.get("capability") == "release.publish_latest"
                       and (config.get("arguments") or {}).get("bindBuild") is True]
            if len(sources) != 1:
                errors.append("安装本次发布需要前面唯一的 bindBuild 发布步骤；独立检查更新请重新生成“本机检查并更新” Kit（node.check_update_local），不会自动改用其他发布记录")
    return errors


def standalone_requested(intent: str) -> bool:
    lowered = intent.casefold()
    return (any(word in lowered for word in ("本机更新", "更新本机", "本机一键检查并更新", "检查并更新本机",
                                             "本机检查并更新", "本机检查更新并安装", "local update", "check and update"))
            and not any(word in lowered for word in ("打包", "构建", "发布", "上传", "build", "publish", "upload",
                                                      "不要更新", "不更新本机", "不安装", "without updating")))


def standalone_template() -> dict[str, Any]:
    return {"status": "ok", "ready": True, "kit": {
        "title": "本机一键检查并更新", "description": "检查节点更新源 → 冻结版本 → 独立安装确认 → 重启验收；无更新仅报告检查结果",
        "executionTarget": "executor", "shell": "powershell", "cwd": ".", "command": "",
        "timeoutSeconds": 21600, "inputs": [], "enabled": True,
        "steps": [{"id": "update", "type": "awu_capability", "target": "executor", "title": "检查更新并验收重启",
                   "config": {"capability": CHECK_UPDATE_CAPABILITY, "arguments": {}}}],
        "schedule": {"mode": "manual"}, "assertions": [{"type": "exit_code", "expected": 0}],
        "outputs": [], "view": {"default": "summary", "showLogs": True, "showTerminal": False},
    }}


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

"""只生成/预览组合；不会修改原 Kit 或启动任何步骤。"""
from __future__ import annotations
import re
from typing import Any
from .kit_capabilities import UPDATE_CAPABILITY, CHECK_UPDATE_CAPABILITY, BUILD_UPDATE_CAPABILITY, LOCAL_UPDATE_CAPABILITIES


def validate_update_sequence(configs: list[dict[str, Any]]) -> list[str]:
    """保存与运行使用同一展开计划规则；旧错误 Kit 不自动改变更新来源。"""
    positions = [i for i, config in enumerate(configs) if config.get("capability") in LOCAL_UPDATE_CAPABILITIES]
    errors = []
    if positions and positions != [len(configs) - 1]:
        errors.append("本机更新必须且只能是展开计划的最后一步")
    for index in positions:
        if configs[index].get("capability") == BUILD_UPDATE_CAPABILITY:
            if sum(config.get("captureBuild") is True for config in configs[:index]) != 1:
                errors.append("安装本机构建需要前面唯一的 captureBuild 构建步骤；不能选择任意安装包或其他运行的制品")
            publishers = [i for i, config in enumerate(configs[:index])
                          if config.get("capability") == "release.publish_latest"]
            builds = [i for i, config in enumerate(configs[:index]) if config.get("captureBuild") is True]
            if publishers and (len(publishers) != 1 or len(builds) != 1
                    or publishers[0] <= builds[0]
                    or (configs[publishers[0]].get("arguments") or {}).get("bindBuild") is not True):
                errors.append("发布后本地安装需要唯一 captureBuild 构建之后的唯一 bindBuild 发布步骤")
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
        "title": "本机一键检查并更新", "description": "运行前确认 → 检查更新源 → 优先复用本机包 → 安装与重启验收；无更新仅报告检查结果",
        "executionTarget": "executor", "shell": "powershell", "cwd": ".", "command": "",
        "timeoutSeconds": 21600, "inputs": [], "enabled": True,
        "steps": [{"id": "update", "type": "awu_capability", "target": "executor", "title": "检查更新并验收重启",
                   "config": {"capability": CHECK_UPDATE_CAPABILITY, "arguments": {}}}],
        "schedule": {"mode": "manual"}, "assertions": [{"type": "exit_code", "expected": 0}],
        "outputs": [], "view": {"default": "summary", "showLogs": True, "showTerminal": False},
    }}


def is_build_command(command: str) -> bool:
    return bool(re.search(r"(?i)(?:^|[\\/\s\"'])build_all\.bat(?:$|[\s\"'])|register_release_candidate\.py", command))


def publication_requested(intent: str) -> bool:
    # 否定上传/发布不能因为命中名词而生成正式发布步骤。
    remaining = re.sub(r"(?:无需|无须|不用|不必|不要|不需要|不想|不再|禁止|跳过|免|不)(?:再|先)?\s*(?:上传|发布)", "", intent.casefold())
    remaining = re.sub(r"(?:without|no|don't|do not|skip)\s+(?:upload(?:ing)?|publish(?:ing)?)", "", remaining)
    return any(word in remaining for word in ("发布", "上传", "publish", "upload"))


def update_prohibited(intent: str) -> bool:
    return bool(re.search(r"(?:无需|无须|禁止|不(?:要|需要|必|用|再|想)?)(?:本机|本地)?(?:更新|安装)|without (?:updating|installing)", intent.casefold()))


def requested(intent: str) -> bool:
    lowered = intent.casefold()
    return (any(word in lowered for word in ("本机更新", "更新本机", "本机完成更新", "本地更新", "local update"))
            and any(word in lowered for word in ("打包", "build", "package"))
            and publication_requested(lowered)
            and not update_prohibited(lowered))


def local_build_requested(intent: str) -> bool:
    lowered = intent.casefold()
    return (any(word in lowered for word in ("本机", "本地", "local"))
            and any(word in lowered for word in ("打包", "构建", "build", "package"))
            and any(word in lowered for word in ("更新", "安装", "update", "install"))
            and (not publication_requested(lowered) or bool(re.search(
                r"本地(?:直装|安装)|(?:本地|本机)(?:包|安装包|制品).{0,12}(?:安装|更新)|"
                r"(?:不(?:用|要|需要|再)?|无需).{0,16}(?:下载|远端拉)|"
                r"(?:without|no|don't|do not).{0,12}(?:download|re-download)|install locally", lowered)))
            and not update_prohibited(lowered))


def build_template(state: Any, intent: str, *, local_build: bool = False) -> dict[str, Any]:
    candidates = []
    for kit in state.visible_kits():
        if not kit.enabled:
            continue
        steps = kit.steps or [{"type": "command", "target": kit.execution_target, "command": kit.command}]
        if (all(step.get("type", "command") == "command" and (step.get("target") or kit.execution_target) == "executor" for step in steps)
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
    publish = not local_build or publication_requested(intent)
    title = "打包、发布并本地直装" if local_build and publish else "本机打包并直接更新" if local_build else "打包、发布并更新本机"
    description = ("运行前确认 → 构建与发布 → 本地包校验 → 安装与重启验收；不重新下载安装包"
                   if local_build and publish else
                   "运行前确认 → 本机构建 → 本地包校验 → 安装与重启验收；不上传、不下载" if local_build else
                   "运行前确认 → 构建与发布 → 优先复用本机包 → 安装与重启验收")
    return {"status": "ok", "ready": True, "kit": {
        "title": title, "description": description,
        "executionTarget": "executor", "shell": "powershell", "cwd": ".", "command": "",
        "timeoutSeconds": 21600, "inputs": build.inputs, "enabled": True,
        "steps": [
            {"id": "build", "type": "kit_call", "target": "executor", "title": build.title, "kitId": build.id,
             "captureBuild": True, "inputs": {item["key"]: "{{" + item["key"] + "}}" for item in build.inputs if item.get("key")}},
            *([] if not publish else [{"id": "publish", "type": "awu_capability", "target": "executor", "title": "发布本次构建",
             "config": {"capability": "release.publish_latest", "arguments": {"bindBuild": True, "channel": "stable", "projectRoot": "."}}}]),
            {"id": "install", "type": "awu_capability", "target": "executor", "title": "安装本次本机构建并验收重启" if local_build else "安装本次发布并验收重启",
             "config": {"capability": BUILD_UPDATE_CAPABILITY if local_build else UPDATE_CAPABILITY, "arguments": {}}},
        ], "schedule": {"mode": "manual"}, "assertions": [{"type": "exit_code", "expected": 0}],
        "outputs": [], "view": {"default": "summary", "showLogs": True, "showTerminal": False},
    }}

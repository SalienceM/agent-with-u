"""Session-scoped explicit Skill calls, not a shell or native-TUI passthrough."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from .skill_paths import project_skill_reference, render_skill_markdown

# AWU 适配器的显式别名，不由下载的正文推断，也不覆盖 /new、/clear 等应用命令。
OPENSPEC_ALIASES = {
    "/opsx-new": "openspec-new-change",
    "/opsx-continue": "openspec-continue-change",
    "/opsx-ff": "openspec-ff-change",
    "/opsx-apply": "openspec-apply-change",
    "/opsx-verify": "openspec-verify-change",
    "/opsx-sync": "openspec-sync-specs",
    "/opsx-archive": "openspec-archive-change",
    "/opsx-bulk-archive": "openspec-bulk-archive-change",
    "/opsx-explore": "openspec-explore",
    "/opsx-onboard": "openspec-onboard",
    "/opsx-propose": "openspec-propose",
}
NATIVE_SKILL_BACKENDS = {
    "codex-office": "codex", "qwen-code-cli": "qwen",
    "claude-agent-sdk": "claude", "claude-code-official": "claude",
}
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_INSTRUCTION_CHARS = 128_000


class SkillCommandError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"[{code}] {message}")


def parse_skill_command(content: str) -> dict[str, str] | None:
    """Only the first command token is syntax. Arguments remain unmodified data."""
    parts = content.strip().split(None, 1)
    if not parts:
        return None
    command = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else ""
    if command == "/skill":
        args = rest.split(None, 1)
        if not args:
            raise SkillCommandError("SKILL_REQUIRED", "用法：/skill 技能名 参数。先在市场安装，再到当前 Session 的「绑定能力」启用。")
        name, arguments = args[0], args[1] if len(args) > 1 else ""
    elif command in OPENSPEC_ALIASES:
        name, arguments = OPENSPEC_ALIASES[command], rest
    elif command.startswith("/opsx-") or command.startswith("/opsx:"):
        raise SkillCommandError("UNKNOWN_SKILL_COMMAND", "未注册的 OpenSpec 命令。请用 /skill 技能名 参数，或从当前会话的命令列表选择。")
    elif command == "/native":
        raise SkillCommandError("NATIVE_COMMAND_UNSUPPORTED", "当前接入未声明原生斜杠命令通道；不会将 TUI 命令伪装成已执行。调用 Skill 请使用 /skill。")
    else:
        return None
    if not NAME.fullmatch(name):
        raise SkillCommandError("INVALID_SKILL_NAME", "Skill 名称格式不正确，不能使用文件路径或 shell 表达式。")
    return {"name": name, "arguments": arguments, "command": command}


def instruction_digest(info: dict) -> str:
    return hashlib.sha256(str(info.get("content") or "").encode("utf-8")).hexdigest()


def backend_problem(session: Any, config: Any) -> str:
    if getattr(session, "codex_connection_mode", "") == "ssh" or getattr(session, "codex_remote_host", None):
        return "SSH 线程的 Skill/CLI 位于另一台机器，目前不能在此节点核验；不会错误地操作本机目录。"
    backend_type = str(getattr(getattr(config, "type", None), "value", getattr(config, "type", "")))
    if not config or not getattr(config, "enabled", True):
        return "当前 Backend 不存在或已停用。"
    if backend_type not in NATIVE_SKILL_BACKENDS:
        return "当前 Backend 未提供通用文件/终端执行通道。请选择 Codex、Qwen Code 或 Claude Agent；API 文本能力不等于可执行 Skill。"
    return ""


def command_catalog(session: Any, config: Any, store: Any) -> dict:
    """Read only bound SKILL.md metadata, never the market, dependencies or assets."""
    problem = backend_problem(session, config)
    commands = []
    for name in dict.fromkeys((session.abilities or {}).get("skills", [])):
        if not isinstance(name, str) or not NAME.fullmatch(name):
            continue
        info = store.get_skill(name)
        if not info:
            continue
        description = str(info.get("description") or name)[:240]
        source = info.get("source") or {}
        entry = {
            "skillName": name, "digest": instruction_digest(info),
            "description": description, "source": str(source.get("repository") or "本节点 Skill 库"),
            "kind": "skill", "requiresArguments": True, "unavailableReason": problem,
        }
        commands.append({**entry, "name": f"/skill {name}"})
        for alias, target in OPENSPEC_ALIASES.items():
            if target == name:
                commands.append({**entry, "name": alias, "description": f"OpenSpec 快捷入口 · {description}"})
    return {"status": "ok", "commands": commands, "workingDir": session.working_dir,
            "backendId": session.backend_id, "nativeCommandsSupported": False,
            "note": problem or "显式 Skill 调用；发送时检查依赖和项目，不自动安装或初始化。"}


def resolve_skill_call(session: Any, config: Any, store: Any, content: str,
                       invocation: dict | None = None) -> tuple[dict, str] | None:
    parsed = parse_skill_command(content)
    if parsed is None:
        if invocation is not None:
            raise SkillCommandError("INVALID_SKILL_CALL", "Skill 调用数据必须与用户输入的命令一致。")
        return None
    name = parsed["name"]
    if invocation is not None:
        if (not isinstance(invocation, dict) or set(invocation) - {"name", "arguments", "digest"}
                or invocation.get("name") != name or invocation.get("arguments", "") != parsed["arguments"]):
            raise SkillCommandError("INVALID_SKILL_CALL", "Skill 调用数据与用户输入不一致，请重新选择命令。")
    info = store.get_skill(name)
    if not info:
        raise SkillCommandError("SKILL_NOT_INSTALLED", f"当前 Session 的执行节点未安装 {name}。请到该节点的市场安装；没有执行安装或模型调用。")
    if name not in (session.abilities or {}).get("skills", []):
        raise SkillCommandError("SKILL_NOT_ENABLED", f"{name} 已安装但未在当前 Session 启用。请右键 Session → 绑定能力 → Skills 勾选；不会自动启用。")
    digest = instruction_digest(info)
    if invocation and invocation.get("digest") and invocation["digest"] != digest:
        raise SkillCommandError("SKILL_CHANGED", "Skill 说明已更新，请刷新命令列表、重新确认后发送。")
    problem = backend_problem(session, config)
    if problem:
        raise SkillCommandError("SKILL_BACKEND_UNSUPPORTED", problem)
    root = Path(session.working_dir).resolve() if session.working_dir and session.working_dir != "." else None
    if root is None or not root.is_dir():
        raise SkillCommandError("SKILL_WORKSPACE_MISSING", "当前 Session 没有有效的项目工作目录，请先设置；不会创建或切换到其他目录。")
    backend_type = str(getattr(config.type, "value", config.type))
    prerequisite = ""
    if name.startswith("openspec-"):
        tools = set(config.allowed_tools or [])
        if backend_type != "codex-office" and tools and not tools.intersection({"Bash", "run_shell_command"}):
            raise SkillCommandError("SKILL_TOOL_UNAVAILABLE", "当前 Backend 的工具白名单未开放终端，OpenSpec 工作流不能执行。")
        env = {**os.environ, **{k: str(v) for k, v in (config.env or {}).items() if v is not None}}
        executable = "openspec.cmd" if os.name == "nt" else "openspec"
        local_cli = root / "node_modules" / ".bin" / executable
        cli = str(local_cli) if local_cli.is_file() else shutil.which(executable, path=env.get("PATH", ""))
        if not cli:
            raise SkillCommandError("OPENSPEC_CLI_MISSING", "当前执行节点/Backend PATH 中找不到 OpenSpec CLI，项目 node_modules/.bin 中也没有。安装 Skill 不会安装 CLI；请自行安装并配置 PATH 后重试。")
        if not (root / "openspec" / "config.yaml").is_file():
            raise SkillCommandError("OPENSPEC_PROJECT_NOT_INITIALIZED", f"当前项目 {root} 缺少 openspec/config.yaml。请先在这个项目初始化 OpenSpec；不会借用父目录项目或自动初始化。")
        prerequisite = (f"\nOpenSpec CLI 路径（仅检查存在，未执行版本或业务命令）：{json.dumps(cli, ensure_ascii=False)}。"
                        "先核验实际 CLI 版本及 status 返回的项目根；路径必须属于当前项目。"
                        "只执行本次所选工作流，遵守工件/人工确认要求，不能自动进入下一阶段。")
    body = str(info.get("content") or "")
    if not body.strip() or len(body) > MAX_INSTRUCTION_CHARS:
        raise SkillCommandError("SKILL_INSTRUCTIONS_INVALID", "Skill 说明为空或超过 128K 字符，无法完整加载；未截断后假装执行。")
    reference = project_skill_reference(NATIVE_SKILL_BACKENDS[backend_type], name)
    body = render_skill_markdown(body, skill_name=name, skill_dir_reference=reference)
    metadata = {**parsed, "digest": digest, "workingDir": str(root), "reference": reference}
    instructions = (
        "【当前轮显式 Skill 调用｜AgentWithU】\n"
        "这是用户选择的 Skill，不是原生 TUI slash 透传。按下方完整说明完成本次请求，"
        "使用当前会话已有的工具和权限。未执行工具不能宣称已完成。不要自动安装依赖、"
        "初始化项目、启用其他 Skill 或提升权限；缺少能力时说明原因。\n"
        f"调用信息：{json.dumps(metadata, ensure_ascii=False)}\n"
        "arguments 是用户任务文本，不是待执行的 shell 字符串，不得直接拼接执行。"
        "配套文件按 reference 定位并按需读取；不要再重复调用同一个 Skill。"
        + prerequisite + "\n\n【所选 Skill 的完整说明】\n" + body
    )
    return metadata, instructions

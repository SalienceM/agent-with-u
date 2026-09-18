"""AWU compatibility configurations; same portable schema as awu.commands.json.

No dispatcher branches on these IDs. An installed package declaration replaces
the matching preset; merely shipping this module never installs/enables a Skill.
"""
from __future__ import annotations

CLI = {"executable": "openspec", "windowsExecutable": "openspec.cmd", "localBin": "node_modules/.bin"}
PROJECT = {"requiredPaths": ["openspec/config.yaml"],
           "yamlGuards": [{"path": "openspec/config.yaml", "forbidKeys": ["store"]}]}
WORKFLOWS = {
    "new": "new-change", "continue": "continue-change", "ff": "ff-change",
    "apply": "apply-change", "verify": "verify-change", "sync": "sync-specs",
    "archive": "archive-change", "bulk-archive": "bulk-archive-change",
    "explore": "explore", "onboard": "onboard", "propose": "propose",
}


def _project(name: str, description: str, argv: list[str], *, parameters: list | None = None,
             checks: dict | None = None, instructions: str = "") -> dict:
    return {"name": f"/opsx-{name}", "description": description, "kind": "project", "cli": CLI,
            "argv": argv, "parameters": parameters or [], "checks": checks or {},
            "instructions": instructions or "只执行本次入口。执行前核对 CLI --version 及子命令 --help；报告实际退出码和结果，不自动继续工作流。"}


OPENSPEC_PROFILE = {
    "schemaVersion": 1,
    "id": "openspec",
    "skillIds": ["openspec-" + target for target in WORKFLOWS.values()],
    "commands": [
        *[{"name": "/opsx-" + alias, "kind": "skill", "skillId": "openspec-" + target,
           "description": "OpenSpec 工作流 · " + alias, "cli": CLI, "checks": PROJECT,
           "instructions": "先核验实际 CLI 版本及 status 返回的项目根；遵守工件和人工确认要求，不自动进入下一阶段。"}
          for alias, target in WORKFLOWS.items()],
        _project("init", "初始化当前项目（不重复生成 Agent 适配文件）",
                 ["init", "--tools", "none", "--language", "zh-CN", "--no-animation"],
                 checks={"absentPaths": ["openspec"], "noAncestorPaths": ["openspec/config.yaml"]},
                 instructions="这是显式初始化授权。先核对 --version 及 init --help。再次检查当前根无 openspec 目录、父目录无项目；使用 --tools none，不生成重复的 Agent commands/skills。读取落盘 config.yaml 确认，不自动 new/apply。"),
        _project("update", "更新项目适配文件，不升级 CLI", ["update"], checks=PROJECT),
        _project("list", "列出当前项目的变更", ["list", "--json"], checks=PROJECT),
        _project("status", "查看变更的工件状态", ["status", "--change", "{id}", "--json"], checks=PROJECT,
                 parameters=[{"name": "id", "type": "id", "required": True}]),
        _project("show", "查看指定变更或规格", ["show", "{id}", "--json", "--no-interactive"], checks=PROJECT,
                 parameters=[{"name": "id", "type": "id", "required": True}]),
        _project("validate", "校验文档结构，不代替业务测试", ["validate", "{target}", "--strict", "--no-interactive"], checks=PROJECT,
                 parameters=[{"name": "target", "type": "idOrEnum", "choices": ["--all", "--specs", "--changes"], "default": "--all"}]),
        _project("help", "查看本节点实际 CLI 帮助", ["{action}", "--help"],
                 parameters=[{"name": "action", "type": "enum", "choices": ["init", "update", "list", "status", "show", "validate", "new", "instructions", "archive", "config"]}]),
        _project("version", "查看本节点实际 CLI 版本", ["--version"]),
    ],
}

BUILTIN_PROFILES = [OPENSPEC_PROFILE]

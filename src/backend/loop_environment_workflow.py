"""Resolve explicit LOOP prerequisites from installed declarations, never prose."""
from __future__ import annotations

from typing import Any

from .loop_execution_environment import digest, normalize_workflow
from .skill_command_presets import CLI, WORKFLOWS
from .skill_commands import registered_definitions, _entry_digest

SUPPORTED_SKILLS = frozenset('openspec-' + target for target in WORKFLOWS.values())


class WorkflowSelectionError(ValueError):
    pass


def workflow_choices(session: Any, store: Any) -> list[dict]:
    entries, _ = registered_definitions(store)
    bound = (getattr(session, 'abilities', None) or {}).get('skills', [])
    choices = []
    for name, entry in entries.items():
        command = entry['definition']
        skill_id = command.get('skillId', '')
        if command.get('kind') != 'skill' or skill_id not in SUPPORTED_SKILLS or skill_id not in bound:
            continue
        info = store.get_skill(skill_id)
        if not info:
            continue
        # 首版只支持固定 OpenSpec 工具声明，不执行包配置中的任意探测命令。
        if command.get('cli') != CLI:
            continue
        choices.append(normalize_workflow({'skillId': skill_id, 'command': name,
                       'profileId': entry['profileId'], 'digest': _entry_digest(entry, info)}))
    return choices[:100]


def select_workflow(session: Any, store: Any, command: str, expected_digest: str,
                    goal: str, *, source: str = 'explicit_selection', revision: int = 1) -> dict:
    if not command:
        return {}
    choice = next((v for v in workflow_choices(session, store) if v['command'] == command), None)
    if not choice or not expected_digest or choice['digest'] != expected_digest:
        raise WorkflowSelectionError('工作流未安装、未绑定、声明已变化或不支持，请刷新并明确选择。')
    return normalize_workflow({**choice, 'source': source, 'scope': digest(goal), 'revision': revision})


def resolve_workflow(session: Any, store: Any, reference: dict, goal: str) -> dict:
    ref = normalize_workflow(reference)
    if not ref:
        return {}
    if ref.get('scope') != digest(goal):
        raise WorkflowSelectionError('目标范围已变化，请重新确认工作流依赖；未自动选择新的工作流。')
    return select_workflow(session, store, ref['command'], ref['digest'], goal,
                           source=ref['source'], revision=ref['revision'])

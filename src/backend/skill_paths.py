"""Agent-native Skill directory mappings and deployment rendering.

Skill source content belongs to the AgentWithU library and must not assume that
Claude is the active runtime. Deployment chooses the native directory for each
agent and rewrites only references to the Skill's own folder.
"""

import re
from pathlib import Path


PROJECT_SKILL_ROOTS: dict[str, Path] = {
    "claude": Path(".claude") / "skills",
    "qwen": Path(".qwen") / "skills",
    "codex": Path(".agents") / "skills",
}

GLOBAL_SKILL_ROOTS: dict[str, Path] = {
    "claude": Path.home() / ".claude" / "skills",
    "qwen": Path.home() / ".qwen" / "skills",
    "codex": Path.home() / ".codex" / "skills",
}


def project_skill_root(working_dir: str | Path, agent_name: str) -> Path:
    """Return the project Skill root used by one agent runtime."""
    try:
        relative_root = PROJECT_SKILL_ROOTS[agent_name]
    except KeyError as exc:
        raise ValueError(f"Unsupported agent Skill runtime: {agent_name}") from exc
    return Path(working_dir) / relative_root


def project_skill_reference(agent_name: str, skill_name: str) -> str:
    """Return a POSIX-style path suitable for commands in a project SKILL.md."""
    try:
        root = PROJECT_SKILL_ROOTS[agent_name]
    except KeyError as exc:
        raise ValueError(f"Unsupported agent Skill runtime: {agent_name}") from exc
    return (root / skill_name).as_posix()


def deployment_targets(name: str, target_key: str) -> list[tuple[str, Path, str]]:
    """Return ``(agent, target_dir, command_reference)`` deployment targets.

    Project deployments use project-relative command references so the Skill
    remains portable with the repository. Global deployments use absolute
    references because the agent can be launched from any working directory.
    """
    targets: list[tuple[str, Path, str]] = []
    if target_key == "global":
        for agent_name, root in GLOBAL_SKILL_ROOTS.items():
            target = root / name
            targets.append((agent_name, target, target.as_posix()))
        return targets

    for agent_name in PROJECT_SKILL_ROOTS:
        target = project_skill_root(target_key, agent_name) / name
        targets.append((
            agent_name,
            target,
            project_skill_reference(agent_name, name),
        ))
    return targets


def render_skill_markdown(
    content: str,
    *,
    skill_name: str,
    skill_dir_reference: str,
) -> str:
    """Render one library SKILL.md for a concrete deployment directory.

    New Skills can use ``{{SKILL_DIR}}`` (preferred) or ``<SKILL_DIR>``.
    Existing Skills that hard-coded one of the supported project roots are
    migrated transparently when they are deployed.
    """
    rendered = content.replace("{{SKILL_DIR}}", skill_dir_reference)
    rendered = rendered.replace("<SKILL_DIR>", skill_dir_reference)
    for root in PROJECT_SKILL_ROOTS.values():
        legacy_reference = (root / skill_name).as_posix()
        rendered = re.sub(
            re.escape(legacy_reference) + r"(?=$|[/\\])",
            lambda _match: skill_dir_reference,
            rendered,
        )
        legacy_windows_reference = str(root / skill_name)
        if legacy_windows_reference != legacy_reference:
            rendered = re.sub(
                re.escape(legacy_windows_reference) + r"(?=$|[/\\])",
                lambda _match: skill_dir_reference,
                rendered,
            )
    return rendered

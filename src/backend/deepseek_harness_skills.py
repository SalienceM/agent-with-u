"""只镜像当前 Session 明确绑定的 Skills；不复用任何其他 Agent 目录。"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import PurePosixPath
from pathlib import Path
from typing import Any

from .deepseek_harness_state import HarnessLayout, atomic_json, reject_links


def skill_root(*, owner: str, backend: str, session: str) -> Path:
    return HarnessLayout.for_session(owner=owner, executor="local", backend=backend, session=session).root / "skills"


def _check_tree(root: Path) -> None:
    reject_links(root)
    if root.exists():
        for entry in root.rglob("*"):
            reject_links(entry)


def prepare_bound_skills(bridge: Any, session: Any) -> None:
    from .skill_store import SkillStore, MANAGED_MARKER, LIBRARY_DIR
    store = bridge._skill_store
    root = skill_root(owner=session.owner_id, backend=session.backend_id, session=session.id)
    _check_tree(root)
    bound = (session.abilities or {}).get("skills", [])
    if not isinstance(bound, list) or len(bound) > 256:
        raise ValueError("Harness Skill 绑定无效或超出限额")
    # 列表、绑定和参数浏览不调用本函数；只在已授权的发送准备边界复制。
    with store._deployment_lock:
        selected: set[str] = set()
        for name in bound:
            store._validate_library_name(name)
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
                raise ValueError("Harness 原生 Skill 名称仅支持小写 kebab-case，不能静默改名")
            info = store.get_skill(name)
            if not info:
                raise ValueError("Harness 绑定的 Skill 未安装，不能静默忽略")
            source = LIBRARY_DIR / name
            _check_tree(source)
            target = root / name
            _check_tree(target)
            if target.exists() and any(target.iterdir()) and not SkillStore.is_managed_directory(target):
                raise ValueError("Harness Skill 目标含非管理文件，不能覆盖用户目录")
            if bridge._is_backend_enhanced_skill(info):
                config = next((config for config in bridge._backend_configs if config.id == info.get("backend")), None)
                is_image = bool(config and config.type.value == "dashscope-image")
                markdown = bridge._generate_backend_skill_md(name, info, agent_name="harness",
                    is_image_backend=is_image, skill_dir_reference=target.as_posix())
                call = bridge._generate_backend_skill_call_py(name, info, is_image_backend=is_image)
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                # 与标准 Skill 使用相同逐文件管理标记；不靠 _call.py 猜目录归属。
                old = set(SkillStore._read_managed_files(target))
                for filename, content in (("SKILL.md", markdown), ("_call.py", call)):
                    file = target / filename
                    reject_links(file)
                    if not file.exists() or file.read_text(encoding="utf-8") != content:
                        file.write_text(content, encoding="utf-8")
                for stale in old - {"SKILL.md", "_call.py"}:
                    candidate = target / stale
                    if candidate.resolve().is_relative_to(target.resolve()) and candidate.is_file():
                        candidate.unlink()
                atomic_json(target / MANAGED_MARKER, {"managedBy": "AgentWithU", "runtime": "deepseek-harness",
                    "files": ["SKILL.md", "_call.py"]})
            else:
                store.deploy_to_directory(name, target, target.as_posix())
            selected.add(name)
        if root.exists():
            for target in root.iterdir():
                _check_tree(target)
                if target.is_dir() and target.name not in selected and SkillStore.is_managed_directory(target):
                    SkillStore.undeploy_from_directory(target)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        identity = HarnessLayout.for_session(owner=session.owner_id, executor="local", backend=session.backend_id, session=session.id).identity
        atomic_json(root / "selection.json", {"schema": 1, "identity": identity, "names": sorted(selected)})


def run_skill_view(layout: HarnessLayout, run_dir: Path) -> tuple[list[str], list[str]]:
    """只暴露冻结清单中的管理文件；保留的用户目录不能混入原生 Skill catalog。"""
    root = layout.root / "skills"
    selection = root / "selection.json"
    reject_links(selection)
    if not selection.exists():
        return [], []
    if selection.stat().st_size > 32768:
        raise ValueError("Harness Skill 冻结清单超限")
    data = json.loads(selection.read_text(encoding="utf-8"))
    names = data.get("names")
    if (data.get("schema") != 1 or data.get("identity") != layout.identity
            or not isinstance(names, list) or len(names) > 256
            or any(not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) for name in names)):
        raise ValueError("Harness Skill 冻结清单身份/格式不匹配")
    if not names:
        return [], []
    from .skill_store import SkillStore
    view = run_dir / "skill-view"
    reject_links(view)
    view.mkdir(mode=0o700)
    for name in names:
        source = root / name
        _check_tree(source)
        files = SkillStore._read_managed_files(source)
        if not files or "SKILL.md" not in files:
            raise ValueError("Harness 已绑定 Skill 的管理文件不完整")
        for relative in files:
            rel = PurePosixPath(relative)
            if rel.is_absolute() or ":" in relative or "\\" in relative or any(part in {"", ".", ".."} for part in rel.parts):
                raise ValueError("Harness Skill 资源路径越界")
            target = view / name / Path(*rel.parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copy2(source.joinpath(*rel.parts), target)
    return [str(view)], names

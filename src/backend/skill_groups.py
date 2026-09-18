"""Executor-local repository parents; child Skill identities and bindings stay intact."""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

PARENT_ID = re.compile(r'^repo\.[a-f0-9]{16}$')
CHILD_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')


class SkillGroups:
    def __init__(self, root: Path, lock: Any, index: dict) -> None:
        self.root, self.lock, self.index = root.resolve(), lock, index

    def _path(self) -> Path:
        path = (self.root / '.groups.json').resolve()
        if not path.is_relative_to(self.root):
            raise ValueError('Skill 父级设置路径越界')
        return path

    def _settings(self) -> dict:
        path = self._path()
        if not path.is_file():
            return {}
        if path.stat().st_size > 1_000_000:
            raise ValueError('Skill 父级设置文件过大')
        settings = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(settings, dict):
            raise ValueError('Skill 父级设置损坏，请恢复备份')
        return settings

    def list(self) -> list[dict]:
        # 只读取成员索引和目录存在性；不读手册、不联网、不部署 Skill。
        with self.lock:
            settings = self._settings()
            groups: dict[str, dict] = {}
            for name, entry in sorted(self.index.items()):
                source = entry.get('source') or {}
                repository = source.get('repository', '') if isinstance(source, dict) else ''
                if not isinstance(repository, str) or not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
                    continue
                directory = self.root / name
                if not CHILD_NAME.fullmatch(name) or directory.is_symlink() or not (directory / 'SKILL.md').is_file():
                    continue
                key = 'repo.' + hashlib.sha256(repository.casefold().encode()).hexdigest()[:16]
                saved = settings.get(key) or {}
                group = groups.setdefault(key, {
                    'id': key, 'name': saved.get('name') or repository.split('/')[-1],
                    'repository': repository, 'children': [],
                    'revision': hashlib.sha256(json.dumps(saved, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
                })
                group['children'].append(name)
            return list(groups.values())

    def annotate(self, skills: list[dict]) -> list[dict]:
        membership = {name: group for group in self.list() for name in group['children']}
        return [{**skill, **({'parent': {key: membership[skill['name']][key]
                    for key in ('id', 'name', 'repository', 'revision')}} if skill['name'] in membership else {})}
                for skill in skills]

    def resolve(self, reference: str) -> dict | None:
        if CHILD_NAME.fullmatch(reference) and (self.root / reference / 'SKILL.md').is_file():
            return None  # 旧的子 Skill 引用始终保持原意。
        groups = self.list()
        if PARENT_ID.fullmatch(reference):
            current = next((group for group in groups if group['id'] == reference), None)
            if current is None:
                raise ValueError('[SKILL_PARENT_MISSING] 此节点没有该仓库的已安装子 Skill；不会自动安装。')
            return current
        matches = [group for group in groups if group['name'].casefold() == reference.casefold()]
        if len(matches) > 1:
            raise ValueError('[SKILL_PARENT_AMBIGUOUS] 父级名称重复，请从 @SKILL 菜单选择具体仓库。')
        if matches:
            return matches[0]
        return None

    def rename(self, parent_id: str, name: str, revision: str) -> dict:
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80 or any(ord(c) < 32 for c in name):
            raise ValueError('父级名称需为 1–80 个可见字符')
        name = name.strip()
        if PARENT_ID.fullmatch(name):
            raise ValueError('名称不能使用内部引用 ID 格式')
        with self.lock:
            groups = self.list()
            current = next((group for group in groups if group['id'] == parent_id), None)
            if current is None:
                raise ValueError('Skill 父级不存在')
            if current['revision'] != revision:
                raise ValueError('[SKILL_PARENT_CHANGED] 名称已被其他窗口修改，请刷新核对')
            if any(group['id'] != parent_id and group['name'].casefold() == name.casefold() for group in groups):
                raise ValueError('该父级名称已使用，请换一个名称')
            if CHILD_NAME.fullmatch(name) and (self.root / name / 'SKILL.md').exists():
                raise ValueError('名称与子 Skill 重复，请换一个父级名称')
            settings = self._settings()
            settings[parent_id] = {'name': name}
            path = self._path()
            temporary = path.with_suffix(f'.{uuid.uuid4().hex}.tmp')
            try:
                temporary.write_text(json.dumps(settings, ensure_ascii=False), encoding='utf-8')
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            return next(group for group in self.list() if group['id'] == parent_id)

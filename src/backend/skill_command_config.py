"""Read/edit portable command files under the executor's installed Skill library."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from .skill_command_manifest import FILENAME, MAX_BYTES, SKILL_ID, digest, parse_manifest
from .skill_command_presets import BUILTIN_PROFILES


class SkillCommandConfigs:
    def __init__(self, store: Any, root: Path):
        self.store, self.root = store, root.resolve()

    def _path(self, name: str) -> Path:
        if not SKILL_ID.fullmatch(name):
            raise ValueError("Skill ID 格式无效")
        directory = self.root / name
        path = directory / FILENAME
        if directory.is_symlink() or not path.resolve().is_relative_to(directory.resolve()) or not directory.resolve().is_relative_to(self.root):
            raise ValueError("命令配置路径越界")
        if not (directory / "SKILL.md").is_file():
            raise ValueError("此执行节点未安装该 Skill")
        return path

    def _read(self, name: str) -> str | None:
        path = self._path(name)
        if not path.exists():
            return None
        with path.open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("命令配置超过 128 KB")
        return raw.decode("utf-8-sig")

    def sources(self) -> dict:
        installed, configured, profiles, issues = [], [], [], []
        with self.store._lock:
            if not self.root.exists():
                return {"installed": [], "configured": [], "profiles": [], "issues": []}
            for directory in sorted(self.root.iterdir()):
                if not SKILL_ID.fullmatch(directory.name) or not directory.is_dir() or directory.is_symlink():
                    continue
                if not (directory / "SKILL.md").is_file():
                    continue
                installed.append(directory.name)
                if (directory / FILENAME).exists() or (directory / FILENAME).is_symlink():
                    configured.append(directory.name)
                try:
                    raw = self._read(directory.name)
                    if raw is not None:
                        profiles.append({"owner": directory.name, "content": raw})
                except (OSError, ValueError) as exc:
                    issues.append({"source": directory.name, "message": str(exc)})
        return {"installed": installed, "configured": configured, "profiles": profiles, "issues": issues}

    def get(self, name: str) -> dict:
        with self.store._lock:
            group = self.store.groups().resolve(name)
            owners = group["children"] if group else [name]
            copies = {owner: self._read(owner) for owner in owners}
            configured = [raw for raw in copies.values() if raw is not None]
            preset = next((profile for profile in BUILTIN_PROFILES if set(owners) & set(profile["skillIds"])), None)
            default = ({**preset, "skillIds": list(dict.fromkeys([*preset["skillIds"], *owners]))} if preset
                       else {"schemaVersion": 1, "id": owners[0], "skillIds": owners, "commands": []})
            raw = configured[0] if configured else json.dumps(default, ensure_ascii=False, indent=2)
            warnings = []
            if len(set(configured)) > 1:
                warnings.append("子 Skill 的配置不同。此处显示首份；保存将明确统一当前仓库所有已安装子 Skill。")
            try:
                parse_manifest(raw)
            except ValueError as exc:
                warnings.append(str(exc))
            return {"status": "ok", "name": name, "displayName": group["name"] if group else name, "owners": owners, "content": raw,
                    "revision": digest(copies), "origin": "package" if configured else "compatibility" if preset else "new",
                    "warnings": warnings}

    def save(self, name: str, content: str, revision: str) -> dict:
        profile = parse_manifest(content)
        with self.store._deployment_lock, self.store._lock:
            current = self.get(name)
            if revision != current["revision"]:
                raise ValueError("命令配置或仓库成员已变化，请刷新后重新确认")
            owners = current["owners"]
            if not set(owners).issubset(profile["skillIds"]):
                raise ValueError("skillIds 必须包含本次保存目标的全部 Skill ID")
            paths = [self._path(owner) for owner in owners]
            backups = {path: path.read_bytes() if path.exists() else None for path in paths}
            staged: list[Path] = []
            replaced: list[Path] = []
            try:
                for path in paths:
                    temp = path.with_name(f".{FILENAME}.{uuid.uuid4().hex}.tmp")
                    staged.append(temp)
                    temp.write_text(content, encoding="utf-8")
                for path, temp in zip(paths, staged):
                    os.replace(temp, path)
                    replaced.append(path)
            except Exception:
                for path in reversed(replaced):
                    old = backups[path]
                    if old is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(old)
                raise
            finally:
                for temp in staged:
                    temp.unlink(missing_ok=True)
            for owner in owners:
                source = self.store._index.get(owner, {}).get("source")
                if isinstance(source, dict):
                    source["dirty"] = True
            self.store._save_index()
            return self.get(name)

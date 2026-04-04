"""
SkillStore: 管理 Skill 孵化库与激活状态。

设计原则：
  - 孵化库：~/.agent-with-u/skill-library/<name>/SKILL.md  （全局积累）
  - 激活 = 将 SKILL.md 复制到目标位置
  - 项目级激活 → <working_dir>/.claude/skills/<name>/SKILL.md
  - 全局激活  → ~/.claude/skills/<name>/SKILL.md
  - 停用 = 删除目标位置的文件
  - 激活记录存在 index.json 中，key 为 "global" 或工作目录绝对路径
"""

import json
import re
import shutil
import threading
from pathlib import Path
from typing import Optional

import yaml  # PyYAML — already in requirements (anthropic dep)

LIBRARY_DIR = Path.home() / ".agent-with-u" / "skill-library"
INDEX_FILE  = LIBRARY_DIR / "index.json"

DEFAULT_SKILL_TEMPLATE = """\
---
name: {name}
description: Describe what this skill does and when Claude should use it (max 250 chars)
# backend: backend-id          # 可选：指定路由到哪个 Backend（Backend Skill 模式）
# input_schema:                # 可选：Backend Skill 的输入参数定义（JSON Schema）
#   type: object
#   properties:
#     prompt:
#       type: string
#       description: 输入描述
---

## Instructions

Write step-by-step instructions for Claude here.

## Example Usage

Describe example prompts that would trigger this skill.
"""


def parse_skill_frontmatter(content: str) -> dict:
    """解析 SKILL.md 的 YAML frontmatter，返回字段字典。
    支持字段：name, description, backend, input_schema 等。
    """
    m = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
    if not m:
        return {}
    try:
        data = yaml.safe_load(m.group(1))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


class SkillStore:
    def __init__(self):
        LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._index: dict = self._load_index()

    # ── 内部持久化 ────────────────────────────────────────────────

    def _load_index(self) -> dict:
        """index 结构: { skill_name: { activations: ["global", "/path/a", ...] } }"""
        if INDEX_FILE.exists():
            try:
                return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def _save_index(self):
        INDEX_FILE.write_text(
            json.dumps(self._index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── 目标路径计算 ────────────────────────────────────────────────

    @staticmethod
    def _target_dir(name: str, target_key: str) -> Path:
        if target_key == "global":
            return Path.home() / ".claude" / "skills" / name
        return Path(target_key) / ".claude" / "skills" / name

    # ── 部署/撤销 ────────────────────────────────────────────────────

    def _deploy(self, name: str, content: str, target_key: str):
        """将 SKILL.md 写到目标位置。"""
        target = self._target_dir(name, target_key)
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(content, encoding="utf-8")

    def _undeploy(self, name: str, target_key: str):
        """从目标位置删除 SKILL.md，目录为空则一并删除。"""
        target = self._target_dir(name, target_key)
        skill_file = target / "SKILL.md"
        if skill_file.exists():
            skill_file.unlink()
        try:
            if target.exists() and not any(target.iterdir()):
                target.rmdir()
        except Exception:
            pass

    # ── 公开 API ─────────────────────────────────────────────────────

    def list_skills(self, working_dir: str = "") -> list[dict]:
        """
        返回孵化库中所有 skill 的信息，附带当前工作目录的激活状态。
        """
        with self._lock:
            result = []
            if not LIBRARY_DIR.exists():
                return result
            for skill_dir in sorted(LIBRARY_DIR.iterdir()):
                if not skill_dir.is_dir():
                    continue
                name = skill_dir.name
                skill_file = skill_dir / "SKILL.md"
                if not skill_file.exists():
                    continue
                content = skill_file.read_text(encoding="utf-8")
                activations: list[str] = self._index.get(name, {}).get("activations", [])
                # 验证激活状态是否真实存在（防止文件被手动删除）
                valid_activations = []
                for ak in activations:
                    if (self._target_dir(name, ak) / "SKILL.md").exists():
                        valid_activations.append(ak)
                if set(valid_activations) != set(activations):
                    self._index.setdefault(name, {})["activations"] = valid_activations
                    self._save_index()
                    activations = valid_activations

                fm = parse_skill_frontmatter(content)
                item: dict = {
                    "id": name,  # 使用 name 作为 ID（确保唯一性）
                    "name": name,
                    "content": content,
                    "isGlobal": "global" in activations,
                    "isProject": bool(working_dir) and working_dir in activations,
                    "projectActivations": [a for a in activations if a != "global"],
                    "description": fm.get("description", ""),
                }
                # Backend Skill 扩展字段
                if fm.get("backend"):
                    item["backend"] = fm["backend"]
                if fm.get("input_schema"):
                    item["inputSchema"] = fm["input_schema"]
                result.append(item)
            return result

    def get_skill(self, name: str) -> Optional[dict]:
        with self._lock:
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                return None
            content = skill_file.read_text(encoding="utf-8")
            activations = self._index.get(name, {}).get("activations", [])
            fm = parse_skill_frontmatter(content)
            result: dict = {
                "id": name,
                "name": name,
                "content": content,
                "activations": activations,
                "description": fm.get("description", ""),
            }
            if fm.get("backend"):
                result["backend"] = fm["backend"]
            if fm.get("input_schema"):
                result["inputSchema"] = fm["input_schema"]
            return result

    def save_skill(self, name: str, content: str) -> None:
        """
        保存或更新孵化库中的 skill，并同步到所有已激活的目标位置。
        """
        with self._lock:
            skill_dir = LIBRARY_DIR / name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
            # 确保索引中存在此 skill（为 ID 概念做准备）
            if name not in self._index:
                self._index[name] = {"activations": []}
                self._save_index()
            # 同步所有已激活的位置
            for target_key in self._index.get(name, {}).get("activations", []):
                try:
                    self._deploy(name, content, target_key)
                except Exception as e:
                    print(f"[SkillStore] sync activate failed ({target_key}): {e}", flush=True)

    def delete_skill(self, name: str) -> None:
        """从孵化库删除 skill，并撤销所有激活位置。"""
        with self._lock:
            for target_key in self._index.get(name, {}).get("activations", []):
                try:
                    self._undeploy(name, target_key)
                except Exception:
                    pass
            skill_dir = LIBRARY_DIR / name
            if skill_dir.exists():
                shutil.rmtree(skill_dir)
            self._index.pop(name, None)
            self._save_index()

    def activate(self, name: str, scope: str, working_dir: str = "") -> None:
        """
        激活 skill。
          scope: "global"  → ~/.claude/skills/<name>/
          scope: "project" → <working_dir>/.claude/skills/<name>/
        """
        with self._lock:
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                raise ValueError(f"Skill '{name}' not found in library")
            target_key = "global" if scope == "global" else working_dir
            if not target_key:
                raise ValueError("working_dir is required for project-scope activation")
            content = skill_file.read_text(encoding="utf-8")
            self._deploy(name, content, target_key)
            entry = self._index.setdefault(name, {"activations": []})
            if target_key not in entry["activations"]:
                entry["activations"].append(target_key)
            self._save_index()

    def deactivate(self, name: str, scope: str, working_dir: str = "") -> None:
        """停用 skill，删除目标位置的 SKILL.md。"""
        with self._lock:
            target_key = "global" if scope == "global" else working_dir
            if not target_key:
                raise ValueError("working_dir is required for project-scope deactivation")
            self._undeploy(name, target_key)
            entry = self._index.get(name, {})
            acts = entry.get("activations", [])
            if target_key in acts:
                acts.remove(target_key)
            self._save_index()

    def rename_skill(self, old_name: str, new_name: str, new_content: str) -> None:
        """重命名 skill（删旧建新，保留激活记录）。"""
        with self._lock:
            old_file = LIBRARY_DIR / old_name / "SKILL.md"
            if not old_file.exists():
                raise ValueError(f"Skill '{old_name}' not found")
            if old_name == new_name:
                # 只更新内容
                old_file.write_text(new_content, encoding="utf-8")
                for target_key in self._index.get(old_name, {}).get("activations", []):
                    try:
                        self._deploy(old_name, new_content, target_key)
                    except Exception:
                        pass
                return
            # 实际重命名
            old_activations = self._index.get(old_name, {}).get("activations", [])
            # 撤销旧 skill 的所有激活
            for target_key in old_activations:
                try:
                    self._undeploy(old_name, target_key)
                except Exception:
                    pass
            shutil.rmtree(LIBRARY_DIR / old_name, ignore_errors=True)
            self._index.pop(old_name, None)
            # 创建新 skill
            new_dir = LIBRARY_DIR / new_name
            new_dir.mkdir(parents=True, exist_ok=True)
            (new_dir / "SKILL.md").write_text(new_content, encoding="utf-8")
            # 恢复激活
            entry = self._index.setdefault(new_name, {"activations": []})
            for target_key in old_activations:
                try:
                    self._deploy(new_name, new_content, target_key)
                    if target_key not in entry["activations"]:
                        entry["activations"].append(target_key)
                except Exception:
                    pass
            self._save_index()

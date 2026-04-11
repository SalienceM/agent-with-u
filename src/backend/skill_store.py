"""
SkillStore: 管理 Skill 孵化库与激活状态。

设计原则：
  - 孵化库：~/.agent-with-u/skill-library/<name>/SKILL.md  （全局积累）
  - 激活 = 将 SKILL.md 复制到目标位置
  - 项目级激活 → <working_dir>/.claude/skills/<name>/SKILL.md
  - 全局激活  → ~/.claude/skills/<name>/SKILL.md
  - 停用 = 删除目标位置的文件
  - 激活记录存在 index.json 中，key 为 "global" 或工作目录绝对路径

插件包格式（.awu）：
  - 本质是 zip 文件，内含 manifest.json + SKILL.md + 可选文件
  - 敏感配置通过 secrets.schema.json 声明，由客户端 UI 引导填写
  - 运行时凭据存于 ~/.agent-with-u/skill-secrets/<name>.json（仅 owner 可读）
  - 凭据永不传入大模型 context
"""

import json
import re
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Optional

import yaml  # PyYAML — already in requirements (anthropic dep)

LIBRARY_DIR  = Path.home() / ".agent-with-u" / "skill-library"
INDEX_FILE   = LIBRARY_DIR / "index.json"
SECRETS_DIR  = Path.home() / ".agent-with-u" / "skill-secrets"

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
    """解析 SKILL.md 的 YAML frontmatter，返回字段字典。"""
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
        target = self._target_dir(name, target_key)
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(content, encoding="utf-8")

    def _undeploy(self, name: str, target_key: str):
        target = self._target_dir(name, target_key)
        skill_file = target / "SKILL.md"
        if skill_file.exists():
            skill_file.unlink()
        try:
            if target.exists() and not any(target.iterdir()):
                target.rmdir()
        except Exception:
            pass

    # ── 辅助 ─────────────────────────────────────────────────────────

    def _read_manifest(self, skill_dir: Path) -> Optional[dict]:
        mf = skill_dir / "manifest.json"
        if mf.exists():
            try:
                return json.loads(mf.read_text(encoding="utf-8"))
            except Exception:
                pass
        return None

    # ── 公开 API：Skill CRUD ──────────────────────────────────────────

    def list_skills(self, working_dir: str = "") -> list[dict]:
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
                valid_activations = [
                    ak for ak in activations
                    if (self._target_dir(name, ak) / "SKILL.md").exists()
                ]
                if set(valid_activations) != set(activations):
                    self._index.setdefault(name, {})["activations"] = valid_activations
                    self._save_index()
                    activations = valid_activations

                fm = parse_skill_frontmatter(content)
                item: dict = {
                    "id": name,
                    "name": name,
                    "content": content,
                    "isGlobal": "global" in activations,
                    "isProject": bool(working_dir) and working_dir in activations,
                    "projectActivations": [a for a in activations if a != "global"],
                    "description": fm.get("description", ""),
                    "isDefault": bool(self._index.get(name, {}).get("isDefault", False)),
                    # 插件包扩展字段
                    "hasCallPy": (skill_dir / "call.py").exists(),
                    "hasSecrets": (SECRETS_DIR / f"{name}.json").exists(),
                    "hasSecretsSchema": (skill_dir / "secrets.schema.json").exists(),
                    "manifest": self._read_manifest(skill_dir),
                }
                if fm.get("backend"):
                    item["backend"] = fm["backend"]
                if fm.get("type"):
                    item["type"] = fm["type"]
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
            skill_dir = LIBRARY_DIR / name
            result: dict = {
                "id": name,
                "name": name,
                "content": content,
                "activations": activations,
                "description": fm.get("description", ""),
                "isDefault": bool(self._index.get(name, {}).get("isDefault", False)),
                "hasCallPy": (skill_dir / "call.py").exists(),
                "hasSecretsSchema": (skill_dir / "secrets.schema.json").exists(),
                "manifest": self._read_manifest(skill_dir),
            }
            if fm.get("backend"):
                result["backend"] = fm["backend"]
            if fm.get("type"):
                result["type"] = fm["type"]
            if fm.get("input_schema"):
                result["inputSchema"] = fm["input_schema"]
            return result

    def save_skill(self, name: str, content: str) -> None:
        with self._lock:
            skill_dir = LIBRARY_DIR / name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
            if name not in self._index:
                self._index[name] = {"activations": []}
                self._save_index()
            for target_key in self._index.get(name, {}).get("activations", []):
                try:
                    self._deploy(name, content, target_key)
                except Exception as e:
                    print(f"[SkillStore] sync failed ({target_key}): {e}", flush=True)

    def delete_skill(self, name: str) -> None:
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
            # 删除 skill 时一并清理凭据
            secrets_file = SECRETS_DIR / f"{name}.json"
            if secrets_file.exists():
                try:
                    secrets_file.unlink()
                except Exception:
                    pass

    def activate(self, name: str, scope: str, working_dir: str = "") -> None:
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
        with self._lock:
            old_file = LIBRARY_DIR / old_name / "SKILL.md"
            if not old_file.exists():
                raise ValueError(f"Skill '{old_name}' not found")
            if old_name == new_name:
                old_file.write_text(new_content, encoding="utf-8")
                for target_key in self._index.get(old_name, {}).get("activations", []):
                    try:
                        self._deploy(old_name, new_content, target_key)
                    except Exception:
                        pass
                return
            old_entry = self._index.get(old_name, {}) or {}
            old_activations = old_entry.get("activations", [])
            old_is_default = bool(old_entry.get("isDefault", False))
            for target_key in old_activations:
                try:
                    self._undeploy(old_name, target_key)
                except Exception:
                    pass
            shutil.rmtree(LIBRARY_DIR / old_name, ignore_errors=True)
            self._index.pop(old_name, None)
            new_dir = LIBRARY_DIR / new_name
            new_dir.mkdir(parents=True, exist_ok=True)
            (new_dir / "SKILL.md").write_text(new_content, encoding="utf-8")
            entry = self._index.setdefault(new_name, {"activations": []})
            if old_is_default:
                entry["isDefault"] = True
            for target_key in old_activations:
                try:
                    self._deploy(new_name, new_content, target_key)
                    if target_key not in entry["activations"]:
                        entry["activations"].append(target_key)
                except Exception:
                    pass
            self._save_index()

    def set_default(self, name: str, is_default: bool) -> bool:
        """标记/取消某个 Skill 为默认档。默认档会在新建 session 时自动绑定。"""
        with self._lock:
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                return False
            entry = self._index.setdefault(name, {"activations": []})
            entry["isDefault"] = bool(is_default)
            self._save_index()
            return True

    def list_default_names(self) -> list[str]:
        """返回所有被标记为默认档的 Skill 名称列表。"""
        with self._lock:
            return [
                name for name, entry in self._index.items()
                if entry.get("isDefault") and (LIBRARY_DIR / name / "SKILL.md").exists()
            ]

    # ── 插件包安装 ────────────────────────────────────────────────────

    # 包内白名单文件（防止路径穿越攻击）
    _PKG_ALLOWED = {
        "manifest.json", "SKILL.md", "call.py",
        "secrets.schema.json", "requirements.txt", "README.md", "icon.png",
    }

    def install_package(self, pkg_path: str) -> dict:
        """
        安装 .awu 插件包（zip 格式）到孵化库。

        必须文件：manifest.json、SKILL.md
        可选文件：call.py、secrets.schema.json、requirements.txt、README.md、icon.png

        manifest.json 必须字段：
          id          小写字母+数字+连字符，全局唯一
          name        显示名称
          version     语义版本号
          description 简介

        返回解析后的 manifest dict。
        """
        with self._lock:
            with zipfile.ZipFile(pkg_path, "r") as zf:
                names = set(zf.namelist())

                if "manifest.json" not in names:
                    raise ValueError("包缺少 manifest.json")
                if "SKILL.md" not in names:
                    raise ValueError("包缺少 SKILL.md")

                manifest: dict = json.loads(zf.read("manifest.json").decode("utf-8"))
                skill_id: str = manifest.get("id", "")

                if not re.match(r'^[a-z][a-z0-9-]{0,63}$', skill_id):
                    raise ValueError(
                        f"manifest.id 格式非法：{skill_id!r}（要求小写字母开头，仅含小写字母/数字/连字符）"
                    )

                skill_dir = LIBRARY_DIR / skill_id
                skill_dir.mkdir(parents=True, exist_ok=True)

                # 只提取白名单文件
                for item in names:
                    if item.endswith("/"):
                        continue
                    filename = Path(item).name
                    if filename not in self._PKG_ALLOWED:
                        print(f"[SkillStore] install_package: skip {item!r} (not whitelisted)",
                              flush=True)
                        continue
                    (skill_dir / filename).write_bytes(zf.read(item))

                if skill_id not in self._index:
                    self._index[skill_id] = {"activations": []}
                    self._save_index()

                print(f"[SkillStore] installed '{skill_id}' v{manifest.get('version', '?')}",
                      flush=True)
                return manifest

    # ── Secrets 管理 ─────────────────────────────────────────────────

    def get_secrets_schema(self, name: str) -> Optional[dict]:
        """读取 secrets.schema.json，返回字段定义（若不存在则返回 None）。"""
        schema_file = LIBRARY_DIR / name / "secrets.schema.json"
        if schema_file.exists():
            try:
                return json.loads(schema_file.read_text(encoding="utf-8"))
            except Exception:
                return None
        return None

    def get_secrets(self, name: str) -> dict:
        """从本地安全存储读取 skill 凭据（永不传给大模型）。"""
        path = SECRETS_DIR / f"{name}.json"
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def set_secrets(self, name: str, secrets: dict) -> None:
        """持久化 skill 凭据到本地（chmod 600，仅 owner 可读）。"""
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
        path = SECRETS_DIR / f"{name}.json"
        path.write_text(json.dumps(secrets, ensure_ascii=False), encoding="utf-8")
        try:
            path.chmod(0o600)
        except Exception:
            pass

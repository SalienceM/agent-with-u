"""
PromptStore: 管理可复用的 Prompt 模板库。

Prompts stored in ~/.agent-with-u/prompt-library/<name>.md
Index at ~/.agent-with-u/prompt-library/index.json
"""

import json
import time
from pathlib import Path
from typing import Optional


class PromptStore:
    def __init__(self):
        self._dir = Path.home() / ".agent-with-u" / "prompt-library"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self._dir / "index.json"
        self._index: dict[str, dict] = {}
        self._load_index()

    def _load_index(self):
        if self._index_path.exists():
            try:
                data = json.loads(self._index_path.read_text(encoding="utf-8"))
                # Migration: convert old list format to dict with ID
                if isinstance(data, list):
                    self._index = {item.get("name", item.get("id")): item for item in data}
                else:
                    self._index = {item.get("name", item.get("id")): item for item in data.values()}
            except Exception:
                self._index = {}

    def _save_index(self):
        entries = sorted(self._index.values(), key=lambda x: x.get("updatedAt", 0), reverse=True)
        self._index_path.write_text(
            json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def list_prompts(self) -> list[dict]:
        result = []
        for meta in sorted(self._index.values(), key=lambda x: x.get("updatedAt", 0), reverse=True):
            path = self._dir / f"{meta['name']}.md"
            content = path.read_text(encoding="utf-8") if path.exists() else ""
            # Ensure ID exists (migrates from name-based to ID-based)
            entry = {**meta, "content": content}
            if "id" not in entry:
                entry["id"] = entry.get("name", "")
            entry["isDefault"] = bool(meta.get("isDefault", False))
            result.append(entry)
        return result

    def get_prompt(self, name: str) -> Optional[dict]:
        meta = self._index.get(name)
        if not meta:
            return None
        path = self._dir / f"{name}.md"
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return {**meta, "content": content, "isDefault": bool(meta.get("isDefault", False))}

    def save_prompt(self, name: str, content: str, icon: str = "📝"):
        now = time.time()
        existing = self._index.get(name)
        meta = {
            "name": name,
            "icon": icon or (existing or {}).get("icon", "📝"),
            "createdAt": (existing or {}).get("createdAt", now),
            "updatedAt": now,
            "isDefault": bool((existing or {}).get("isDefault", False)),
        }
        self._index[name] = meta
        (self._dir / f"{name}.md").write_text(content, encoding="utf-8")
        self._save_index()

    def delete_prompt(self, name: str):
        self._index.pop(name, None)
        path = self._dir / f"{name}.md"
        if path.exists():
            path.unlink()
        self._save_index()

    def rename_prompt(self, old_name: str, new_name: str, content: Optional[str] = None):
        meta = self._index.pop(old_name, None)
        if not meta:
            return
        old_path = self._dir / f"{old_name}.md"
        new_path = self._dir / f"{new_name}.md"
        if content is not None:
            new_path.write_text(content, encoding="utf-8")
        elif old_path.exists():
            new_path.write_text(old_path.read_text(encoding="utf-8"), encoding="utf-8")
        if old_path.exists() and old_path != new_path:
            old_path.unlink()
        meta["name"] = new_name
        meta["updatedAt"] = time.time()
        self._index[new_name] = meta
        self._save_index()

    def update_icon(self, name: str, icon: str):
        meta = self._index.get(name)
        if meta:
            meta["icon"] = icon
            meta["updatedAt"] = time.time()
            self._save_index()

    def set_default(self, name: str, is_default: bool) -> bool:
        """标记/取消某个 Prompt 为默认档。默认档会在新建 session 时自动绑定。"""
        meta = self._index.get(name)
        if not meta:
            return False
        meta["isDefault"] = bool(is_default)
        meta["updatedAt"] = time.time()
        self._save_index()
        return True

    def list_default_names(self) -> list[str]:
        """返回所有被标记为默认档的 Prompt 名称列表。"""
        return [name for name, meta in self._index.items() if meta.get("isDefault")]

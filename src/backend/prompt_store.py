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
                self._index = {item["name"]: item for item in data}
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
            result.append({**meta, "content": content})
        return result

    def get_prompt(self, name: str) -> Optional[dict]:
        meta = self._index.get(name)
        if not meta:
            return None
        path = self._dir / f"{name}.md"
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return {**meta, "content": content}

    def save_prompt(self, name: str, content: str, icon: str = "📝"):
        now = time.time()
        existing = self._index.get(name)
        meta = {
            "name": name,
            "icon": icon or (existing or {}).get("icon", "📝"),
            "createdAt": (existing or {}).get("createdAt", now),
            "updatedAt": now,
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

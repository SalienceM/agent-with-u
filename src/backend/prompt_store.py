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

    # ── 导出 / 导入 ─────────────────────────────────────────────────
    def export_library(self, target_path: str) -> bool:
        """把整个 prompt-library 目录打包成 tar.gz。"""
        import tarfile
        try:
            if not self._dir.exists():
                return True
            with tarfile.open(target_path, "w:gz") as tar:
                for item in sorted(self._dir.iterdir()):
                    tar.add(item, arcname=item.name)
            return True
        except Exception as e:
            print(f"[PromptStore] export failed: {e}")
            return False

    def import_library(self, source_path: str) -> int:
        """从 tar.gz 恢复 prompt-library。返回新增/合并的 prompt 数量。
        策略：文件名冲突时新包覆盖旧包；index.json 做字段级合并（保留本地已有项）。
        """
        import tarfile
        import tempfile
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with tarfile.open(source_path, "r:gz") as tar:
                    tar.extractall(tmpdir)
                src_dir = Path(tmpdir)
                # 先合并 index.json
                imported_index: dict[str, dict] = {}
                src_index = src_dir / "index.json"
                if src_index.exists():
                    try:
                        data = json.loads(src_index.read_text(encoding="utf-8"))
                        if isinstance(data, list):
                            imported_index = {
                                (item.get("name") or item.get("id") or ""): item
                                for item in data if isinstance(item, dict)
                            }
                        elif isinstance(data, dict):
                            imported_index = {
                                (v.get("name") or k): v
                                for k, v in data.items() if isinstance(v, dict)
                            }
                    except Exception:
                        pass
                # 拷贝所有 .md
                count = 0
                for md in src_dir.glob("*.md"):
                    dest = self._dir / md.name
                    existed = dest.exists()
                    dest.write_text(md.read_text(encoding="utf-8"), encoding="utf-8")
                    if not existed:
                        count += 1
                # 合并 index 到内存
                for name, meta in imported_index.items():
                    if not name:
                        continue
                    existing = self._index.get(name, {})
                    merged = {**existing, **meta, "name": name}
                    # 保留 updatedAt 较新的
                    if existing.get("updatedAt", 0) > meta.get("updatedAt", 0):
                        merged["updatedAt"] = existing["updatedAt"]
                    self._index[name] = merged
                self._save_index()
            return count
        except Exception as e:
            print(f"[PromptStore] import failed: {e}")
            return 0

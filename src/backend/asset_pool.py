"""
AssetPool: 素材中转池。

窗口 / 客户端传入的图片及其它非文本素材，在交给 Agent 之前先落到这里，
形成一个可寻址、可滚动淘汰的中转区。Agent / Skill 通过 asset_id 或
HTTP URL 引用素材，便于做后续处理（OCR、合成、格式转换等）。

存储布局（<data_root> 由 paths.data_root() 决定）：
  <data_root>/asset-pool/
    index.json          顺序列表（最新在尾），保存每条元数据
    <id>.<ext>          原始字节
    <id>.meta.json      单条元数据副本（index 损坏时可据此重建）

滚动淘汰（rolling buffer）：
  - 条数上限 MAX_ITEMS（默认 50）
  - 总字节上限 MAX_BYTES（默认 200 MB）
  - 超限时按 FIFO（最旧的先淘汰）
  - pinned=True 的条目不参与淘汰，也不计入上限
  - 带 ttl 的条目过期后由 purge_expired() 清理

线程安全：所有公开方法持 self._lock。
"""

from __future__ import annotations

import io
import json
import threading
import time
from pathlib import Path
from typing import Optional

from . import paths
from ..types import new_id

# 滚动缓冲上限
MAX_ITEMS = 50
MAX_BYTES = 200 * 1024 * 1024  # 200 MB

# MIME → 扩展名
_MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/json": "json",
    "application/octet-stream": "bin",
}


def _ext_for_mime(mime: str) -> str:
    return _MIME_EXT.get((mime or "").split(";")[0].strip().lower(), "bin")


class AssetPool:
    def __init__(self) -> None:
        self._dir = paths.sub("asset-pool")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self._dir / "index.json"
        self._lock = threading.RLock()
        self._index: list[dict] = []
        self._load_index()

    # ── 索引持久化 ────────────────────────────────────────────────────

    def _load_index(self) -> None:
        if not self._index_path.exists():
            self._index = []
            return
        try:
            data = json.loads(self._index_path.read_text(encoding="utf-8"))
            self._index = data if isinstance(data, list) else []
        except Exception:
            # 索引损坏 → 从 *.meta.json 重建
            self._index = self._rebuild_index_from_meta()
        # 丢弃磁盘上已不存在原始文件的条目
        self._index = [m for m in self._index if (self._dir / m["filename"]).exists()]

    def _rebuild_index_from_meta(self) -> list[dict]:
        items: list[dict] = []
        for meta_file in self._dir.glob("*.meta.json"):
            try:
                items.append(json.loads(meta_file.read_text(encoding="utf-8")))
            except Exception:
                continue
        items.sort(key=lambda m: m.get("created_at", 0))
        return items

    def _save_index(self) -> None:
        tmp = self._index_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._index, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._index_path)

    # ── 内部工具 ──────────────────────────────────────────────────────

    def _meta_path(self, asset_id: str) -> Path:
        return self._dir / f"{asset_id}.meta.json"

    @staticmethod
    def _probe_image(data: bytes) -> tuple[Optional[int], Optional[int]]:
        try:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as im:
                return im.width, im.height
        except Exception:
            return None, None

    def _evict_if_needed(self) -> list[str]:
        """按 FIFO 淘汰未 pin 的条目直到回到上限内。返回被删 id 列表。"""
        removed: list[str] = []
        unpinned = [m for m in self._index if not m.get("pinned")]
        total_bytes = sum(m.get("size", 0) for m in unpinned)

        # 先按条数，再按总字节
        while unpinned and (len(unpinned) > MAX_ITEMS or total_bytes > MAX_BYTES):
            victim = unpinned.pop(0)  # 最旧
            total_bytes -= victim.get("size", 0)
            self._delete_files(victim)
            self._index = [m for m in self._index if m["id"] != victim["id"]]
            removed.append(victim["id"])
        return removed

    def _delete_files(self, meta: dict) -> None:
        for p in (self._dir / meta.get("filename", ""), self._meta_path(meta["id"])):
            try:
                if p.name and p.exists():
                    p.unlink()
            except Exception:
                pass

    # ── 公开 API ──────────────────────────────────────────────────────

    def push(
        self,
        data: bytes,
        mime: str = "application/octet-stream",
        source: str = "",
        tags: Optional[list[str]] = None,
        desc: str = "",
        ttl: Optional[int] = None,
    ) -> dict:
        """写入一个素材，返回其元数据 dict。触发滚动淘汰。"""
        if not data:
            raise ValueError("asset_pool.push: empty data")
        asset_id = new_id()
        ext = _ext_for_mime(mime)
        filename = f"{asset_id}.{ext}"
        width, height = (None, None)
        if (mime or "").startswith("image/"):
            width, height = self._probe_image(data)

        meta = {
            "id": asset_id,
            "filename": filename,
            "ext": ext,
            "mime": mime,
            "size": len(data),
            "width": width,
            "height": height,
            "source": source,
            "tags": list(tags or []),
            "desc": desc,
            "pinned": False,
            "ttl": ttl,
            "created_at": time.time(),
        }
        with self._lock:
            (self._dir / filename).write_bytes(data)
            self._meta_path(asset_id).write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            self._index.append(meta)
            evicted = self._evict_if_needed()
            self._save_index()
        if evicted:
            print(f"[asset_pool] pushed {asset_id}, evicted {len(evicted)} old asset(s)")
        return dict(meta)

    def list(
        self,
        limit: int = 50,
        offset: int = 0,
        tag: Optional[str] = None,
    ) -> list[dict]:
        """返回元数据列表，最新在前。"""
        with self._lock:
            items = list(reversed(self._index))
        if tag:
            items = [m for m in items if tag in m.get("tags", [])]
        return [dict(m) for m in items[offset:offset + limit]]

    def get(self, asset_id: str) -> Optional[tuple[bytes, dict]]:
        """返回 (原始字节, 元数据)，不存在则 None。"""
        with self._lock:
            meta = next((m for m in self._index if m["id"] == asset_id), None)
            if meta is None:
                return None
            fpath = self._dir / meta["filename"]
            if not fpath.exists():
                return None
            return fpath.read_bytes(), dict(meta)

    def get_meta(self, asset_id: str) -> Optional[dict]:
        with self._lock:
            meta = next((m for m in self._index if m["id"] == asset_id), None)
            return dict(meta) if meta else None

    def pin(self, asset_id: str, pinned: bool = True) -> Optional[dict]:
        """pin / unpin 一个素材。pinned 条目不被滚动淘汰。"""
        with self._lock:
            meta = next((m for m in self._index if m["id"] == asset_id), None)
            if meta is None:
                return None
            meta["pinned"] = bool(pinned)
            self._meta_path(asset_id).write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            self._save_index()
            return dict(meta)

    def update_meta(
        self,
        asset_id: str,
        desc: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> Optional[dict]:
        with self._lock:
            meta = next((m for m in self._index if m["id"] == asset_id), None)
            if meta is None:
                return None
            if desc is not None:
                meta["desc"] = desc
            if tags is not None:
                meta["tags"] = list(tags)
            self._meta_path(asset_id).write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            self._save_index()
            return dict(meta)

    def delete(self, asset_id: str) -> bool:
        with self._lock:
            meta = next((m for m in self._index if m["id"] == asset_id), None)
            if meta is None:
                return False
            self._delete_files(meta)
            self._index = [m for m in self._index if m["id"] != asset_id]
            self._save_index()
            return True

    def purge_expired(self) -> list[str]:
        """清理 ttl 过期条目（pinned 不豁免 ttl）。返回被删 id 列表。"""
        now = time.time()
        removed: list[str] = []
        with self._lock:
            survivors: list[dict] = []
            for m in self._index:
                ttl = m.get("ttl")
                if ttl and (now - m.get("created_at", now)) > ttl:
                    self._delete_files(m)
                    removed.append(m["id"])
                else:
                    survivors.append(m)
            if removed:
                self._index = survivors
                self._save_index()
        if removed:
            print(f"[asset_pool] purged {len(removed)} expired asset(s)")
        return removed

    def stats(self) -> dict:
        with self._lock:
            total = len(self._index)
            pinned = sum(1 for m in self._index if m.get("pinned"))
            total_bytes = sum(m.get("size", 0) for m in self._index)
        return {
            "count": total,
            "pinned": pinned,
            "bytes": total_bytes,
            "max_items": MAX_ITEMS,
            "max_bytes": MAX_BYTES,
        }

"""
ClipboardHandler: Reads images from system clipboard via Qt.

This is the core bridge solving the Snipaste pain point:
Snipaste → system clipboard → QClipboard.image() → QImage → PNG bytes → base64

PySide6's QClipboard.image() works reliably across platforms,
including with Snipaste, ShareX, and other screenshot tools.

★ 临时文件策略：
  捕获到图片后同步落盘到 ~/.agent-with-u/tmp/<id>.png，
  ImageAttachment.file_path 记录路径。
  应用启动时调用 cleanup_old_temp_files() 清理过期文件（默认 24 小时）。
"""

import base64
import sys
import time
from pathlib import Path
from typing import Optional

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QClipboard, QGuiApplication, QImage

from ..types import ImageAttachment, new_id


# ★ 临时目录：与 session 存储同级
TEMP_DIR = Path.home() / ".agent-with-u" / "tmp"


def _ensure_temp_dir() -> Path:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    return TEMP_DIR


class ClipboardHandler:
    def read_image(self) -> Optional[ImageAttachment]:
        """Read current clipboard image. Returns None if no image."""
        clipboard = QGuiApplication.clipboard()
        image: QImage = clipboard.image()

        if image.isNull():
            return None

        # Convert QImage to PNG bytes
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        image.save(buf, "PNG")
        buf.close()

        png_bytes = bytes(ba.data())
        b64 = base64.b64encode(png_bytes).decode("ascii")
        img_id = new_id()

        # ★ 落盘到临时目录
        file_path: Optional[str] = None
        try:
            tmp_dir = _ensure_temp_dir()
            file_path = str(tmp_dir / f"{img_id}.png")
            with open(file_path, "wb") as f:
                f.write(png_bytes)
        except Exception as e:
            print(f"[Clipboard] 临时文件写入失败: {e}", file=sys.stderr, flush=True)
            file_path = None

        return ImageAttachment(
            id=img_id,
            base64=b64,
            mime_type="image/png",
            size=len(png_bytes),
            width=image.width(),
            height=image.height(),
            file_path=file_path,
        )

    def has_image(self) -> bool:
        """Check if clipboard currently contains an image."""
        clipboard = QGuiApplication.clipboard()
        mime = clipboard.mimeData()
        return mime.hasImage() if mime else False

    @staticmethod
    def cleanup_old_temp_files(max_age_seconds: int = 86400) -> int:
        """清理超过 max_age_seconds 的临时图片文件，返回删除数量。"""
        if not TEMP_DIR.exists():
            return 0
        now = time.time()
        deleted = 0
        for f in TEMP_DIR.glob("*.png"):
            try:
                if now - f.stat().st_mtime > max_age_seconds:
                    f.unlink()
                    deleted += 1
            except Exception:
                pass
        if deleted:
            print(f"[Clipboard] 清理过期临时图片 {deleted} 个", file=sys.stderr, flush=True)
        return deleted

"""
ClipboardHandler: Reads images from system clipboard via Qt.

This is the core bridge solving the Snipaste pain point:
Snipaste → system clipboard → QClipboard.image() → QImage → PNG bytes → base64

PySide6's QClipboard.image() works reliably across platforms,
including with Snipaste, ShareX, and other screenshot tools.
"""

import base64
import io
from typing import Optional

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QClipboard, QGuiApplication, QImage
from PySide6.QtWidgets import QApplication

from ..types import ImageAttachment, new_id


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

        return ImageAttachment(
            id=new_id(),
            base64=b64,
            mime_type="image/png",
            size=len(png_bytes),
            width=image.width(),
            height=image.height(),
        )

    def has_image(self) -> bool:
        """Check if clipboard currently contains an image."""
        clipboard = QGuiApplication.clipboard()
        mime = clipboard.mimeData()
        return mime.hasImage() if mime else False

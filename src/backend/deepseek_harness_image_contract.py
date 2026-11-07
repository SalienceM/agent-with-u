"""图片资源契约；只含静态预算，不代表任何模型的能力或准入结果。"""
from __future__ import annotations

from typing import Any

from .deepseek_harness_config import COMMIT, RUNTIME_VERSION

IMAGE_ADMISSION_VERSION = 1
IMAGE_BRIDGE_VERSION = 1
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
MAX_EDGE = 8192
MAX_IMAGE_PIXELS = 16_000_000
MAX_TOTAL_IMAGE_PIXELS = 32_000_000
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_PENDING_BYTES = 32 * 1024 * 1024
FORMAT_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
LIMITS = {"maxImages": MAX_IMAGES, "maxImageBytes": MAX_IMAGE_BYTES,
    "maxTotalImageBytes": MAX_TOTAL_IMAGE_BYTES, "maxEdge": MAX_EDGE,
    "maxImagePixels": MAX_IMAGE_PIXELS, "maxTotalImagePixels": MAX_TOTAL_IMAGE_PIXELS,
    "maxRequestBytes": MAX_REQUEST_BYTES, "maxFrameBytes": MAX_FRAME_BYTES,
    "maxPendingBytes": MAX_PENDING_BYTES}


def image_resource_contract() -> dict[str, Any]:
    return {"version": IMAGE_ADMISSION_VERSION, "bridgeVersion": IMAGE_BRIDGE_VERSION,
        "runtimeVersion": RUNTIME_VERSION, "sourceCommit": COMMIT,
        "formats": list(FORMAT_MIME.values()), "limits": dict(LIMITS)}

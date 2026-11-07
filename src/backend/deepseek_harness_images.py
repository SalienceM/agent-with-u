"""Harness 图片预算与整笔校验；只使用请求中的字节，不跟随路径或 URL。"""
from __future__ import annotations

import asyncio
import base64
import binascii
from dataclasses import dataclass
import hashlib
import io
import json
import re
import warnings
from typing import Any, Mapping, Sequence

from PIL import Image, UnidentifiedImageError

from ..types import ImageAttachment
from .deepseek_harness_image_contract import (
    IMAGE_ADMISSION_VERSION, IMAGE_BRIDGE_VERSION, MAX_IMAGES, MAX_IMAGE_BYTES,
    MAX_TOTAL_IMAGE_BYTES, MAX_EDGE, MAX_IMAGE_PIXELS, MAX_TOTAL_IMAGE_PIXELS,
    MAX_REQUEST_BYTES, MAX_FRAME_BYTES, MAX_PENDING_BYTES, FORMAT_MIME, LIMITS,
)

_REASONS = {
    "invalid_container": "图片附件列表或字段无效，整笔请求未提交",
    "too_many_images": "一次最多提交 4 张图片（包括模型专用图片）",
    "invalid_base64": "图片编码无效，请重新添加图片",
    "image_bytes": "单张图片不能超过 4 MiB，请减少或替换附件",
    "total_bytes": "全部图片合计不能超过 8 MiB",
    "unsupported_format": "仅支持静态 PNG、JPEG 和 WebP 图片",
    "animated_image": "不支持动画或多帧图片，请选择静态图片",
    "image_dimensions": "图片边长不能超过 8192，单图不能超过 1600 万像素",
    "total_pixels": "全部图片合计不能超过 3200 万像素",
    "corrupt_image": "图片数据损坏或未完整解码，请重新添加图片",
    "mime_mismatch": "图片声明格式与实际内容不一致",
    "request_bytes": "完整图片请求不能超过 12 MiB，请减少文字或附件",
    "extension_missing": "当前 Harness 桥缺少图片准入扩展，已保留图片",
    "extension_mismatch": "Harness 图片扩展或运行时版本不一致，禁止提交图片",
    "limits_mismatch": "Harness 图片与传输限额不一致，禁止提交图片",
    "identity_mismatch": "Harness 图片调用身份或路线不一致，禁止提交图片",
    "text_only": "此次 Harness 调用明确限于纯文本，不能携带图片",
    "capability_unknown": "当前路由的图片能力未确认，已保留附件；请核对该连接的模型目录声明",
    "endpoint_text_only": "当前连接声明该模型仅支持文本，已保留图片，不会删图重发",
    "runtime_text_only": "当前原生运行时不支持该模型的图片输入，已保留图片",
    "safety_guard_unavailable": "无法确认远端文件删除防护有效，禁止提交图片",
    "connection_changed": "图片调用路线或配置已变化，已拒绝本次提交并保留附件",
    "admission_invalid": "Harness 图片准入回执缺失或不匹配，禁止提交图片",
    "admission_required": "Harness 图片一次准入已失效，原生输入未接收",
    "digest_mismatch": "图片内容与本次准入不一致，原生输入未接收",
}

IMAGE_POLICY_REASONS = frozenset(_REASONS)


class ImagePolicyError(ValueError):
    """仅稳定类别与受控文案可以进入聊天、RPC 和诊断，原始异常不得向外传播。"""
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(_REASONS[reason])


@dataclass(frozen=True)
class ValidatedImage:
    data: str
    mime_type: str
    byte_count: int
    width: int
    height: int
    sha256: str

    def content_block(self) -> dict[str, str]:
        return {"type": "image", "data": self.data, "mimeType": self.mime_type}


def parse_images(value: Any) -> list[ImageAttachment] | None:
    """仅严格解析形状，不静默丢项；完整解码由异步发送/入队准入负责。"""
    if value is None:
        return None
    if not isinstance(value, list):
        raise ImagePolicyError("invalid_container")
    if len(value) > MAX_IMAGES:
        raise ImagePolicyError("too_many_images")
    result = []
    for item in value:
        _fields(item)
        if isinstance(item, ImageAttachment):
            result.append(item)
        else:
            if not isinstance(item.get("id"), str) or not item["id"] or len(item["id"]) > 200:
                raise ImagePolicyError("invalid_container")
            result.append(ImageAttachment(**{key: val for key, val in item.items()
                if key in {"id", "base64", "mime_type", "size", "width", "height", "file_path"}}))
    return result or None


def parse_images_json(value: str) -> list[ImageAttachment] | None:
    if not value:
        return None
    if not isinstance(value, str) or len(value.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise ImagePolicyError("request_bytes")
    try:
        decoded = json.loads(value)
    except (ValueError, TypeError):
        raise ImagePolicyError("invalid_container") from None
    return parse_images(decoded)


def _fields(value: Any) -> tuple[str, str]:
    if isinstance(value, ImageAttachment):
        data, mime = value.base64, value.mime_type
    elif isinstance(value, Mapping):
        data, mime = value.get("base64"), value.get("mime_type")
    else:
        raise ImagePolicyError("invalid_container")
    if not isinstance(data, str) or not data or not isinstance(mime, str):
        raise ImagePolicyError("invalid_container")
    if mime not in FORMAT_MIME.values():
        raise ImagePolicyError("unsupported_format")
    return data, mime


def _decode_image(raw: bytes, mime: str, remaining_pixels: int) -> tuple[int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in FORMAT_MIME:
                    raise ImagePolicyError("unsupported_format")
                if FORMAT_MIME[image.format] != mime:
                    raise ImagePolicyError("mime_mismatch")
                if getattr(image, "n_frames", 1) != 1 or getattr(image, "is_animated", False):
                    raise ImagePolicyError("animated_image")
                width, height = image.size
                if width <= 0 or height <= 0 or max(width, height) > MAX_EDGE or width * height > MAX_IMAGE_PIXELS:
                    raise ImagePolicyError("image_dimensions")
                if width * height > remaining_pixels:
                    raise ImagePolicyError("total_pixels")
                # Pillow 的 JPEG load / PNG verify 对某些缺尾文件较宽容；先核对容器尾部。
                if ((image.format == "JPEG" and not raw.endswith(b"\xff\xd9"))
                        or (image.format == "PNG" and not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"))
                        or (image.format == "WEBP" and int.from_bytes(raw[4:8], "little") + 8 != len(raw))):
                    raise ImagePolicyError("corrupt_image")
                image.verify()
            # verify 不等于完整解码；重新打开并读取全部受像素预算约束的图像。
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
            return width, height
    except ImagePolicyError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise ImagePolicyError("image_dimensions") from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError, OverflowError):
        raise ImagePolicyError("corrupt_image") from None


def validate_images_sync(images: Any) -> tuple[ValidatedImage, ...]:
    """在 owned worker/asyncio.to_thread 内调用；任何错误整笔拒绝，不返回部分结果。"""
    if images is None:
        return ()
    if not isinstance(images, (list, tuple)):
        raise ImagePolicyError("invalid_container")
    if len(images) > MAX_IMAGES:
        raise ImagePolicyError("too_many_images")
    fields = [_fields(image) for image in images]
    for data, _mime in fields:
        if len(data) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise ImagePolicyError("image_bytes")
    # 每张各自最多 2 个 padding；编码长度先行防止解码时过量分配。
    if sum(len(data) for data, _mime in fields) > 4 * ((MAX_TOTAL_IMAGE_BYTES + 2) // 3) + 4 * len(fields):
        raise ImagePolicyError("total_bytes")
    decoded: list[tuple[str, str, bytes]] = []
    total_bytes = 0
    for data, mime in fields:
        try:
            raw = base64.b64decode(data, validate=True)
            if base64.b64encode(raw).decode("ascii") != data:
                raise ValueError("noncanonical")
        except (binascii.Error, ValueError, UnicodeError):
            raise ImagePolicyError("invalid_base64") from None
        if len(raw) > MAX_IMAGE_BYTES:
            raise ImagePolicyError("image_bytes")
        total_bytes += len(raw)
        if total_bytes > MAX_TOTAL_IMAGE_BYTES:
            raise ImagePolicyError("total_bytes")
        decoded.append((data, mime, raw))
    validated: list[ValidatedImage] = []
    total_pixels = 0
    for data, mime, raw in decoded:
        width, height = _decode_image(raw, mime, MAX_TOTAL_IMAGE_PIXELS - total_pixels)
        total_pixels += width * height
        validated.append(ValidatedImage(data, mime, len(raw), width, height, hashlib.sha256(raw).hexdigest()))
    return tuple(validated)


async def validate_images(images: Any) -> tuple[ValidatedImage, ...]:
    return await asyncio.to_thread(validate_images_sync, images)


def image_digest(images: Sequence[ValidatedImage]) -> str:
    # 原文件 hash 已绑定尺寸与全部编码。桥可直接复核，无需重复解码或采用 EXIF 旋转后的尺寸。
    metadata = [[image.mime_type, image.byte_count, image.sha256] for image in images]
    return hashlib.sha256(json.dumps(metadata, separators=(",", ":")).encode("utf-8")).hexdigest()


def admission_request(capabilities: Mapping[str, Any], identity: Mapping[str, str],
                      images: Sequence[ValidatedImage]) -> dict[str, Any]:
    """仅供实际发送使用；核心文字握手不能代替版本化图片扩展，既不探测也不启动 worker。"""
    from .deepseek_harness_config import COMMIT, RUNTIME_VERSION
    extension = capabilities.get("imageAdmission")
    if not isinstance(extension, Mapping):
        raise ImagePolicyError("extension_missing")
    if (type(extension.get("version")) is not int or extension["version"] != IMAGE_ADMISSION_VERSION
            or type(extension.get("bridgeVersion")) is not int or extension["bridgeVersion"] != IMAGE_BRIDGE_VERSION
            or capabilities.get("runtimeVersion") != RUNTIME_VERSION or capabilities.get("sourceCommit") != COMMIT):
        raise ImagePolicyError("extension_mismatch")
    limits = extension.get("limits")
    if (not isinstance(limits, Mapping) or set(limits) != set(LIMITS)
            or any(type(limits[key]) is not int or limits[key] != value for key, value in LIMITS.items())):
        raise ImagePolicyError("limits_mismatch")
    keys = ("ownerId", "executorId", "awuSessionId", "backendId", "sessionId", "generation",
            "configFingerprint", "provider", "model")
    if (set(identity) != set(keys) or any(not isinstance(identity[key], str) or not identity[key]
            or len(identity[key]) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in identity[key]) for key in keys)
            or any(identity[key] != capabilities.get(key) for key in ("sessionId", "generation", "configFingerprint"))):
        raise ImagePolicyError("identity_mismatch")
    return {**identity, "version": IMAGE_ADMISSION_VERSION, "bridgeVersion": IMAGE_BRIDGE_VERSION,
        "runtimeVersion": RUNTIME_VERSION, "sourceCommit": COMMIT, "limits": dict(LIMITS), "imageDigest": image_digest(images)}


def content_blocks(text: str, images: Sequence[ValidatedImage]) -> list[dict[str, str]]:
    if not isinstance(text, str):
        raise ImagePolicyError("invalid_container")
    return ([{"type": "text", "text": text}] if text else []) + [image.content_block() for image in images]


def image_admission_error(reason: Any) -> ImagePolicyError:
    """桥的原因也按封闭集合映射，未知正文／地址不能进入错误出口。"""
    aliases = {"runtime_model_unsupported": "runtime_text_only", "runtime_version_required": "runtime_text_only",
               "route_changed": "connection_changed", "catalog_guard_unavailable": "safety_guard_unavailable",
               "identity_unavailable": "identity_mismatch", "admission_used": "admission_required"}
    allowed = {"endpoint_text_only", "runtime_text_only", "safety_guard_unavailable", "connection_changed",
               "identity_mismatch", "extension_mismatch", "limits_mismatch", "admission_required", "digest_mismatch"}
    code = aliases.get(reason, reason) if isinstance(reason, str) else None
    return ImagePolicyError(code if code in allowed else "capability_unknown")


def admitted_image_token(reply: Mapping[str, Any], request: Mapping[str, Any]) -> str:
    """只接受当前 worker／身份的完整准入，不把 supported 或 truthy 值当许可。"""
    if type(reply.get("version")) is not int or reply["version"] != IMAGE_ADMISSION_VERSION:
        raise ImagePolicyError("admission_invalid")
    if reply.get("admitted") is False:
        raise image_admission_error(reply.get("reason"))
    route = reply.get("route")
    expected = {key: value for key, value in request.items() if key not in {"version", "limits", "imageDigest"}}
    if (reply.get("admitted") is not True or reply.get("capability") != "supported"
            or reply.get("source") != "endpoint-and-native" or reply.get("reason") != "route_declares_image"
            or not isinstance(route, Mapping)
            or any(type(route.get(key)) is not type(value) or route[key] != value for key, value in expected.items())
            or not isinstance(reply.get("limits"), Mapping) or set(reply["limits"]) != set(LIMITS)
            or any(type(reply["limits"][key]) is not int or reply["limits"][key] != value for key, value in LIMITS.items())
            or not isinstance(reply.get("admissionId"), str)
            or not re.fullmatch(r"[a-f0-9-]{36}", reply["admissionId"])):
        raise ImagePolicyError("admission_invalid")
    return reply["admissionId"]


def is_image_prompt_rejection(reply: Mapping[str, Any]) -> bool:
    return (type(reply.get("version")) is int and reply["version"] == IMAGE_ADMISSION_VERSION
            and reply.get("admitted") is False and reply.get("status") == "rejected"
            and reply.get("boundary") == "before-native-handler" and "messageId" not in reply)


def encode_frame(message: dict[str, Any]) -> bytes:
    """唯一 UTF-8 JSONL 形式；预算包含完整 envelope 和 LF，不使用 ASCII 膨胀形式。"""
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def check_request_budget(message: dict[str, Any]) -> int:
    size = len(encode_frame(message))
    if size > MAX_REQUEST_BYTES:
        raise ImagePolicyError("request_bytes")
    return size

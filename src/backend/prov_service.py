"""AgentWithU Prov 审阅协议。

``.prov`` 是位于工作目录中的 JSON sidecar：它不改写、也不内嵌源文件，
只保存源文件身份、稳定锚点、分层意见和审批结论。本模块是执行端的权威边界：

* 所有路径都限制在 Session working_dir 内；
* 保存采用 revision compare-and-swap + 原子替换；
* Agent 消费前把协议确定性地转换为工作单；
* 图片审阅会生成烘焙了“框1/圈1”等标签的临时视觉证据。

前端只负责交互，不负责宣布源文件仍然匹配，也不负责解释协议语义。
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Iterable


PROV_FORMAT = "agentwithu.prov"
SCHEMA_VERSION = 1
MAX_PROV_BYTES = 4 * 1024 * 1024
MAX_ANNOTATIONS = 2_000
MAX_COMMENT_CHARS = 40_000
MAX_SOURCE_PREVIEW_BYTES = 32 * 1024 * 1024
MAX_TEXT_PREVIEW_CHARS = 600_000
MAX_WORK_ORDER_CHARS = 240_000
MAX_EVIDENCE_BYTES = 8 * 1024 * 1024

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
TEXT_EXTENSIONS = {".md", ".markdown", ".mdx", ".txt"}

REVIEW_STATES = {
    "draft", "changes_requested", "conditionally_approved", "approved", "rejected",
}
ANNOTATION_STATES = {"open", "addressed", "verified", "dismissed"}
ANNOTATION_KINDS = {"change_request", "comment", "question", "approval"}
SEVERITIES = {"minor", "normal", "major", "critical"}
SELECTOR_TYPES = {"document", "image-region", "text-block", "text-range"}
IMAGE_SHAPES = {"rectangle", "ellipse", "arrow", "polygon", "point"}


class ProvError(ValueError):
    """可直接展示给用户的协议错误。"""


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _safe_path(root: str | Path, rel: str) -> tuple[Path, Path, str]:
    """Resolve a portable relative path below ``root`` and return normalized rel."""
    root_path = Path(root).resolve()
    raw = str(rel or "").strip().replace("\\", "/")
    if not raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise ProvError("审阅文件路径必须是工作目录内的相对路径")
    parts = [part for part in raw.split("/") if part and part != "."]
    if not parts or any(part == ".." for part in parts):
        raise ProvError("审阅文件路径非法")
    target = root_path.joinpath(*parts).resolve()
    try:
        target.relative_to(root_path)
    except ValueError as exc:
        raise ProvError("审阅文件路径越过了工作目录") from exc
    normalized = "/".join(parts)
    return root_path, target, normalized


def prov_path_for_source(source_rel: str) -> str:
    normalized = str(source_rel or "").replace("\\", "/").strip("/")
    if not normalized:
        raise ProvError("源文件路径为空")
    return f"{normalized}.prov"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _image_size(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as image:
            normalized = ImageOps.exif_transpose(image)
            return int(normalized.width), int(normalized.height)
    except Exception as exc:
        raise ProvError(f"无法读取图片尺寸：{exc}") from exc


def _source_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in TEXT_EXTENSIONS:
        return "markdown" if suffix in {".md", ".markdown", ".mdx"} else "text"
    raise ProvError("首期审阅支持 Markdown、纯文本、PNG、JPG、WebP、BMP 和 GIF")


def source_metadata(path: Path, rel: str) -> dict[str, Any]:
    if not path.is_file():
        raise ProvError("源文件不存在")
    kind = _source_kind(path)
    stat = path.stat()
    result: dict[str, Any] = {
        "path": rel.replace("\\", "/"),
        "mediaType": mimetypes.guess_type(path.name)[0] or (
            "text/plain" if kind in {"markdown", "text"} else "application/octet-stream"
        ),
        "kind": kind,
        "sha256": _sha256_file(path),
        "size": int(stat.st_size),
    }
    if kind == "image":
        result["width"], result["height"] = _image_size(path)
    return result


def _source_preview(path: Path, meta: dict[str, Any]) -> dict[str, Any]:
    size = int(meta.get("size", 0) or 0)
    if size > MAX_SOURCE_PREVIEW_BYTES:
        raise ProvError(
            f"源文件过大，审阅预览上限为 {MAX_SOURCE_PREVIEW_BYTES // 1024 // 1024} MiB"
        )
    kind = str(meta.get("kind") or "")
    if kind == "image":
        raw = path.read_bytes()
        return {
            "kind": "image",
            "mimeType": meta.get("mediaType") or "image/png",
            "dataBase64": base64.b64encode(raw).decode("ascii"),
            "width": meta.get("width", 0),
            "height": meta.get("height", 0),
        }
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    truncated = len(text) > MAX_TEXT_PREVIEW_CHARS
    if truncated:
        text = text[:MAX_TEXT_PREVIEW_CHARS]
    return {"kind": kind, "text": text, "truncated": truncated}


def new_document(source: dict[str, Any]) -> dict[str, Any]:
    now = _now_iso()
    return {
        "format": PROV_FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "source": dict(source),
        "review": {
            "id": f"prov_{uuid.uuid4().hex}",
            "revision": 0,
            "state": "draft",
            "createdAt": now,
            "updatedAt": now,
        },
        "counters": {
            "rectangle": 0, "ellipse": 0, "arrow": 0,
            "polygon": 0, "point": 0, "block": 0, "text": 0, "document": 0,
        },
        "annotations": [],
    }


def _read_document(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ProvError("Prov 文件不存在")
    if path.stat().st_size > MAX_PROV_BYTES:
        raise ProvError("Prov 文件过大，可能已损坏")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProvError(f"Prov 文件不是有效 UTF-8 JSON：{exc}") from exc
    validate_document(payload)
    return payload


def _require_string(value: Any, label: str, *, max_chars: int = MAX_COMMENT_CHARS) -> str:
    if not isinstance(value, str):
        raise ProvError(f"{label} 必须是文本")
    if len(value) > max_chars:
        raise ProvError(f"{label}过长")
    return value


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProvError(f"{label} 必须是有限数字")
    return float(value)


def _unit(value: Any, label: str) -> float:
    result = _number(value, label)
    if result < 0 or result > 1:
        raise ProvError(f"{label} 必须位于 0 到 1 之间")
    return result


def _validate_selector(selector: Any) -> None:
    if not isinstance(selector, dict):
        raise ProvError("annotation.target.selector 必须是对象")
    selector_type = selector.get("type")
    if selector_type not in SELECTOR_TYPES:
        raise ProvError(f"不支持的锚点类型：{selector_type}")
    if selector_type == "image-region":
        shape = selector.get("shape")
        if shape not in IMAGE_SHAPES:
            raise ProvError(f"不支持的图片标记：{shape}")
        geometry = selector.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("unit", "normalized") != "normalized":
            raise ProvError("图片坐标必须使用 normalized 单位")
        if shape in {"rectangle", "ellipse"}:
            x = _unit(geometry.get("x"), "x")
            y = _unit(geometry.get("y"), "y")
            width = _unit(geometry.get("width"), "width")
            height = _unit(geometry.get("height"), "height")
            if width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
                raise ProvError("图片区域越界或尺寸为空")
        elif shape == "arrow":
            for key in ("x1", "y1", "x2", "y2"):
                _unit(geometry.get(key), key)
        elif shape == "point":
            _unit(geometry.get("x"), "x")
            _unit(geometry.get("y"), "y")
        else:
            points = geometry.get("points")
            if not isinstance(points, list) or len(points) < 3 or len(points) > 200:
                raise ProvError("多边形至少需要 3 个点，且不能超过 200 个点")
            for index, point in enumerate(points):
                if not isinstance(point, dict):
                    raise ProvError(f"多边形第 {index + 1} 个点无效")
                _unit(point.get("x"), "x")
                _unit(point.get("y"), "y")
    elif selector_type in {"text-block", "text-range"}:
        _require_string(selector.get("exactQuote", ""), "exactQuote")
        heading_path = selector.get("headingPath", [])
        if not isinstance(heading_path, list) or any(not isinstance(item, str) for item in heading_path):
            raise ProvError("headingPath 必须是文本数组")
        if selector_type == "text-range":
            start = int(_number(selector.get("startOffset", 0), "startOffset"))
            end = int(_number(selector.get("endOffset", 0), "endOffset"))
            if start < 0 or end <= start:
                raise ProvError("文本范围无效")


def validate_document(document: Any, *, final: bool = False) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ProvError("Prov 根节点必须是对象")
    if document.get("format") != PROV_FORMAT:
        raise ProvError("不是 AgentWithU Prov 文件")
    if int(document.get("schemaVersion", 0) or 0) != SCHEMA_VERSION:
        raise ProvError("暂不支持该 Prov schema 版本")
    source = document.get("source")
    if not isinstance(source, dict):
        raise ProvError("Prov 缺少 source")
    _require_string(source.get("path", ""), "source.path", max_chars=2_000)
    _require_string(source.get("sha256", ""), "source.sha256", max_chars=100)
    review = document.get("review")
    if not isinstance(review, dict):
        raise ProvError("Prov 缺少 review")
    state = review.get("state", "draft")
    if state not in REVIEW_STATES:
        raise ProvError(f"不支持的审批状态：{state}")
    annotations = document.get("annotations")
    if not isinstance(annotations, list) or len(annotations) > MAX_ANNOTATIONS:
        raise ProvError(f"annotations 必须是数组且不能超过 {MAX_ANNOTATIONS} 条")

    ids: set[str] = set()
    refs: set[str] = set()
    for index, annotation in enumerate(annotations):
        if not isinstance(annotation, dict):
            raise ProvError(f"第 {index + 1} 条 annotation 不是对象")
        annotation_id = _require_string(annotation.get("id", ""), "annotation.id", max_chars=160)
        ref = _require_string(annotation.get("ref", ""), "annotation.ref", max_chars=80)
        if not annotation_id or annotation_id in ids:
            raise ProvError("annotation.id 为空或重复")
        if not ref or ref in refs:
            raise ProvError("annotation.ref 为空或重复")
        ids.add(annotation_id)
        refs.add(ref)
        body = annotation.get("body")
        if not isinstance(body, dict):
            raise ProvError(f"{ref} 缺少 body")
        if body.get("kind", "change_request") not in ANNOTATION_KINDS:
            raise ProvError(f"{ref} 的意见类型无效")
        comment = _require_string(body.get("comment", ""), f"{ref}.comment")
        _require_string(body.get("expected", ""), f"{ref}.expected")
        if body.get("severity", "normal") not in SEVERITIES:
            raise ProvError(f"{ref} 的严重程度无效")
        if annotation.get("status", "open") not in ANNOTATION_STATES:
            raise ProvError(f"{ref} 的状态无效")
        target = annotation.get("target")
        if not isinstance(target, dict):
            raise ProvError(f"{ref} 缺少 target")
        _validate_selector(target.get("selector"))
        if final and annotation.get("status", "open") != "dismissed" and not comment.strip():
            raise ProvError(f"{ref} 尚未填写审阅意见")

    for annotation in annotations:
        parent_id = annotation.get("parentId")
        if parent_id is not None and parent_id not in ids:
            raise ProvError(f"{annotation.get('ref')} 引用了不存在的父意见")
        if parent_id == annotation.get("id"):
            raise ProvError(f"{annotation.get('ref')} 不能以自己为父意见")

    # 显式检测父链循环，避免 UI 和 Agent 递归失控。
    parents = {item["id"]: item.get("parentId") for item in annotations}
    for annotation_id in ids:
        seen: set[str] = set()
        current: str | None = annotation_id
        while current:
            if current in seen:
                raise ProvError("审阅意见的父子关系存在循环")
            seen.add(current)
            current = parents.get(current)
    if state == "approved" and any(
        bool(item.get("body", {}).get("blocking"))
        and item.get("status", "open") not in {"verified", "dismissed"}
        for item in annotations
    ):
        raise ProvError("仍有未验证的阻断意见，不能直接标记为通过")
    return document


def open_prov(root: str | Path, rel: str) -> dict[str, Any]:
    """Open an existing Prov or create an unsaved draft for a source file."""
    root_path, requested_path, requested_rel = _safe_path(root, rel)
    initial_source: dict[str, Any] | None = None
    is_prov = requested_rel.lower().endswith(".prov")
    if is_prov:
        prov_path = requested_path
        prov_rel = requested_rel
        document = _read_document(prov_path)
        source_rel = str(document["source"]["path"])
        _source_root, source_path, source_rel = _safe_path(root_path, source_rel)
        existing = True
    else:
        source_path = requested_path
        source_rel = requested_rel
        prov_rel = prov_path_for_source(source_rel)
        _prov_root, prov_path, _ = _safe_path(root_path, prov_rel)
        if prov_path.is_file():
            document = _read_document(prov_path)
            if str(document["source"].get("path")) != source_rel:
                raise ProvError("Prov 文件绑定的源文件与当前文件不一致")
            existing = True
        else:
            initial_source = source_metadata(source_path, source_rel)
            document = new_document(initial_source)
            existing = False

    if not source_path.is_file():
        return {
            "status": "ok", "document": document, "provPath": prov_rel,
            "existing": existing, "sourceStatus": "missing", "currentSource": None,
            "sourcePreview": None,
        }
    current_source = initial_source or source_metadata(source_path, source_rel)
    source_status = (
        "ok" if current_source.get("sha256") == document.get("source", {}).get("sha256")
        else "changed"
    )
    return {
        "status": "ok",
        "document": document,
        "provPath": prov_rel,
        "existing": existing,
        "sourceStatus": source_status,
        "currentSource": current_source,
        "sourcePreview": _source_preview(source_path, current_source),
    }


def save_prov(
    root: str | Path,
    prov_rel: str,
    document: dict[str, Any],
    expected_revision: int,
    *,
    rebind_source: bool = False,
) -> dict[str, Any]:
    root_path, prov_path, normalized_prov_rel = _safe_path(root, prov_rel)
    if not normalized_prov_rel.lower().endswith(".prov"):
        raise ProvError("审阅文件必须以 .prov 结尾")
    validate_document(document, final=document.get("review", {}).get("state") != "draft")
    source_rel = str(document["source"]["path"])
    _source_root, source_path, source_rel = _safe_path(root_path, source_rel)
    current_source = source_metadata(source_path, source_rel)

    expected = max(0, int(expected_revision or 0))
    existing_revision = 0
    if prov_path.is_file():
        existing = _read_document(prov_path)
        existing_revision = int(existing.get("review", {}).get("revision", 0) or 0)
        if str(existing.get("source", {}).get("path")) != source_rel:
            raise ProvError("不能用审阅稿覆盖绑定到其他源文件的 Prov")
    if existing_revision != expected:
        return {
            "status": "conflict",
            "message": "Prov 已被其他窗口修改，请重新载入后再保存",
            "currentRevision": existing_revision,
        }

    bound_hash = str(document.get("source", {}).get("sha256") or "")
    if bound_hash != current_source["sha256"] and not rebind_source:
        return {
            "status": "source_changed",
            "message": "源文件已变化。请检查标记位置后重新绑定，不能静默套用旧锚点",
            "currentSource": current_source,
        }

    saved = json.loads(json.dumps(document, ensure_ascii=False))
    if rebind_source or not bound_hash:
        saved["source"] = current_source
    review = saved.setdefault("review", {})
    review["revision"] = existing_revision + 1
    review["updatedAt"] = _now_iso()
    if not review.get("createdAt"):
        review["createdAt"] = review["updatedAt"]
    validate_document(saved, final=review.get("state") != "draft")

    encoded = (json.dumps(saved, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(encoded) > MAX_PROV_BYTES:
        raise ProvError("Prov 文件超过安全上限")
    prov_path.parent.mkdir(parents=True, exist_ok=True)
    temp = prov_path.with_name(f".{prov_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_bytes(encoded)
        os.replace(temp, prov_path)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
    return {
        "status": "ok", "document": saved, "provPath": normalized_prov_rel,
        "sourceStatus": "ok", "currentSource": current_source,
    }


def _selector_summary(selector: dict[str, Any]) -> str:
    selector_type = selector.get("type")
    if selector_type == "document":
        return "整个文件"
    if selector_type == "image-region":
        shape = selector.get("shape", "region")
        geometry = json.dumps(selector.get("geometry", {}), ensure_ascii=False, separators=(",", ":"))
        return f"图片 {shape}，归一化坐标 {geometry}"
    heading = " > ".join(str(item) for item in selector.get("headingPath", []) if item)
    quote = str(selector.get("exactQuote") or "").strip().replace("\n", " ")
    if len(quote) > 500:
        quote = quote[:500] + "…"
    prefix = f"标题路径：{heading}；" if heading else ""
    return f"{prefix}原文：{quote!r}"


def _visual_ref(ref: Any, fallback_index: int = 1) -> str:
    match = re.search(r"(\d+)$", str(ref or ""))
    return f"R{match.group(1) if match else fallback_index}"


def _ordered_annotations(annotations: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    items = list(annotations)
    by_parent: dict[str | None, list[dict[str, Any]]] = {}
    for item in items:
        by_parent.setdefault(item.get("parentId"), []).append(item)
    for children in by_parent.values():
        children.sort(key=lambda item: (int(item.get("order", 0) or 0), str(item.get("ref", ""))))
    result: list[dict[str, Any]] = []
    visited: set[str] = set()

    def visit(parent: str | None) -> None:
        for item in by_parent.get(parent, []):
            item_id = str(item.get("id"))
            if item_id in visited:
                continue
            visited.add(item_id)
            result.append(item)
            visit(item_id)

    visit(None)
    for item in items:
        if str(item.get("id")) not in visited:
            result.append(item)
    return result


def materialize_work_order(document: dict[str, Any], current_source: dict[str, Any] | None) -> str:
    validate_document(document)
    source = document["source"]
    review = document["review"]
    source_state = "missing" if current_source is None else (
        "matched" if current_source.get("sha256") == source.get("sha256") else "changed"
    )
    lines = [
        "【AgentWithU Prov 审阅工作单】",
        f"源文件：{source.get('path')}",
        f"源文件绑定 SHA-256：{source.get('sha256')}",
        f"当前源文件状态：{source_state}",
        f"审批状态：{review.get('state', 'draft')}；Prov revision：{review.get('revision', 0)}",
        "",
        "执行规则：",
        "1. 这是用户明确给出的审阅意见；按父子层级理解总体要求与局部要求。",
        "2. 修改源文件，不要擅自改写 .prov 审批结论。",
        "3. 只处理 status=open/addressed 的意见；verified/dismissed 仅作历史参考。",
        "4. 完成后逐条使用稳定 ref 汇报：已处理 / 未处理 / 需用户判断，并给出证据。",
        "5. Agent 不能自行宣布 verified；最终验证权属于用户。",
    ]
    if source_state != "matched":
        lines.extend([
            "",
            "⚠ 源文件与审阅时版本不一致或已缺失。不得假装坐标仍然准确；",
            "先核对 exactQuote/标题路径/视觉标签，无法唯一定位的意见必须明确报告。",
        ])
    lines.extend(["", "审阅意见："])
    annotations = _ordered_annotations(document.get("annotations", []))
    depth_by_id: dict[str, int] = {}
    for annotation_index, annotation in enumerate(annotations, start=1):
        parent_id = annotation.get("parentId")
        depth = depth_by_id.get(str(parent_id), -1) + 1 if parent_id else 0
        depth_by_id[str(annotation.get("id"))] = depth
        body = annotation.get("body", {})
        selector = annotation.get("target", {}).get("selector", {})
        indent = "  " * depth
        parent_ref = next((
            item.get("ref") for item in annotations if item.get("id") == parent_id
        ), None)
        lines.append(
            f"{indent}- [{annotation.get('ref')}]"
            f"{f'（父级 {parent_ref}）' if parent_ref else ''} "
            f"状态={annotation.get('status', 'open')}，"
            f"级别={body.get('severity', 'normal')}，"
            f"阻断={'是' if body.get('blocking') else '否'}"
        )
        if selector.get("type") == "image-region":
            lines.append(f"{indent}  视觉别名：{_visual_ref(annotation.get('ref'), annotation_index)}")
        title = str(annotation.get("title") or "").strip()
        if title:
            lines.append(f"{indent}  标题：{title}")
        lines.append(f"{indent}  定位：{_selector_summary(selector)}")
        lines.append(f"{indent}  意见：{str(body.get('comment') or '').strip() or '（未填写）'}")
        expected = str(body.get("expected") or "").strip()
        if expected:
            lines.append(f"{indent}  期望：{expected}")
    if not annotations:
        lines.append("- （没有局部意见；仅按文件级审批结论处理）")
    result = "\n".join(lines)
    if len(result) > MAX_WORK_ORDER_CHARS:
        raise ProvError("审阅工作单过大，请拆分 Prov 审阅批次后再交给 Agent")
    return result


def _load_label_font(size: int):
    from PIL import ImageFont
    candidates = [
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "simhei.ttf",
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def _pixel_point(point: dict[str, Any], width: int, height: int) -> tuple[int, int]:
    return int(float(point.get("x", 0)) * width), int(float(point.get("y", 0)) * height)


def render_image_evidence(source_path: Path, document: dict[str, Any]) -> dict[str, Any] | None:
    image_annotations = [
        item for item in document.get("annotations", [])
        if item.get("target", {}).get("selector", {}).get("type") == "image-region"
        and item.get("status", "open") != "dismissed"
    ]
    if not image_annotations:
        return None
    try:
        from PIL import Image, ImageDraw, ImageOps
        with Image.open(source_path) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGBA")
        image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
        width, height = image.size
        draw = ImageDraw.Draw(image, "RGBA")
        stroke = max(3, min(width, height) // 260)
        font = _load_label_font(max(15, min(34, min(width, height) // 32)))
        color = (244, 63, 94, 255)
        fill = (244, 63, 94, 28)

        for annotation_index, annotation in enumerate(image_annotations, start=1):
            selector = annotation["target"]["selector"]
            geometry = selector.get("geometry", {})
            shape = selector.get("shape")
            anchor = (0, 0)
            if shape in {"rectangle", "ellipse"}:
                x1 = int(float(geometry.get("x", 0)) * width)
                y1 = int(float(geometry.get("y", 0)) * height)
                x2 = int((float(geometry.get("x", 0)) + float(geometry.get("width", 0))) * width)
                y2 = int((float(geometry.get("y", 0)) + float(geometry.get("height", 0))) * height)
                anchor = (x1, y1)
                if shape == "rectangle":
                    draw.rectangle((x1, y1, x2, y2), outline=color, fill=fill, width=stroke)
                else:
                    draw.ellipse((x1, y1, x2, y2), outline=color, fill=fill, width=stroke)
            elif shape == "arrow":
                start = (int(float(geometry.get("x1", 0)) * width), int(float(geometry.get("y1", 0)) * height))
                end = (int(float(geometry.get("x2", 0)) * width), int(float(geometry.get("y2", 0)) * height))
                anchor = start
                draw.line((start, end), fill=color, width=stroke * 2)
                angle = math.atan2(end[1] - start[1], end[0] - start[0])
                head = max(12, stroke * 5)
                p1 = (int(end[0] - head * math.cos(angle - 0.55)), int(end[1] - head * math.sin(angle - 0.55)))
                p2 = (int(end[0] - head * math.cos(angle + 0.55)), int(end[1] - head * math.sin(angle + 0.55)))
                draw.polygon((end, p1, p2), fill=color)
            elif shape == "point":
                anchor = (int(float(geometry.get("x", 0)) * width), int(float(geometry.get("y", 0)) * height))
                radius = max(8, stroke * 3)
                draw.ellipse((anchor[0] - radius, anchor[1] - radius, anchor[0] + radius, anchor[1] + radius), fill=color)
            elif shape == "polygon":
                points = [_pixel_point(point, width, height) for point in geometry.get("points", [])]
                if len(points) >= 3:
                    anchor = min(points, key=lambda point: (point[1], point[0]))
                    draw.polygon(points, outline=color, fill=fill)
                    draw.line(points + [points[0]], fill=color, width=stroke, joint="curve")

            visual_ref = _visual_ref(annotation.get("ref"), annotation_index)
            label = f"{str(annotation.get('ref') or '标记')} · {visual_ref}"
            try:
                box = draw.textbbox((0, 0), label, font=font, stroke_width=0)
                label_w, label_h = box[2] - box[0], box[3] - box[1]
                lx = max(0, min(width - label_w - 12, anchor[0]))
                ly = max(0, min(height - label_h - 10, anchor[1] - label_h - 10))
                draw.rounded_rectangle(
                    (lx, ly, lx + label_w + 12, ly + label_h + 8),
                    radius=4, fill=(190, 18, 60, 245),
                )
                draw.text((lx + 6, ly + 3), label, fill=(255, 255, 255, 255), font=font)
            except UnicodeEncodeError:
                draw.text(anchor, visual_ref, fill=color, font=font)

        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        raw = output.getvalue()
        mime = "image/png"
        if len(raw) > 6 * 1024 * 1024:
            output = io.BytesIO()
            image.convert("RGB").save(output, format="JPEG", quality=90, optimize=True)
            raw = output.getvalue()
            mime = "image/jpeg"
        if len(raw) > MAX_EVIDENCE_BYTES:
            raise ProvError("图片审阅证据过大，请先缩小源图或拆分审阅区域")
        return {
            "id": f"prov-evidence-{uuid.uuid4().hex}",
            "base64": base64.b64encode(raw).decode("ascii"),
            "mime_type": mime,
            "size": len(raw),
            "width": width,
            "height": height,
        }
    except Exception as exc:
        raise ProvError(f"生成图片审阅证据失败：{exc}") from exc


_QUOTED_PROV_PATTERNS = [
    re.compile(r"`([^`\r\n]+?\.prov)`", re.IGNORECASE),
    re.compile(r'"([^"\r\n]+?\.prov)"', re.IGNORECASE),
    re.compile(r"'([^'\r\n]+?\.prov)'", re.IGNORECASE),
]
_BARE_PROV_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_./\\-])((?:[\w\-\u3400-\u9fff.]+[/\\])*[\w\-\u3400-\u9fff.]+\.prov)(?![A-Za-z0-9_.-])",
    re.IGNORECASE,
)


def extract_prov_references(content: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    quoted_spans: list[tuple[int, int]] = []
    for pattern in _QUOTED_PROV_PATTERNS:
        for match in pattern.finditer(content or ""):
            quoted_spans.append(match.span())
            value = match.group(1).strip()
            key = value.replace("\\", "/").lower()
            if key not in seen:
                seen.add(key)
                result.append(value)
    for match in _BARE_PROV_PATTERN.finditer(content or ""):
        if any(start <= match.start() and match.end() <= end for start, end in quoted_spans):
            continue
        value = match.group(1).strip()
        key = value.replace("\\", "/").lower()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result[:5]


def resolve_prompt(root: str | Path, content: str) -> dict[str, Any]:
    """Resolve referenced Prov files into backend-neutral model context/evidence."""
    root_path = Path(root).resolve()
    orders: list[str] = []
    attachments: list[dict[str, Any]] = []
    resolved: list[str] = []
    errors: list[str] = []
    for rel in extract_prov_references(content):
        try:
            _root, prov_path, normalized = _safe_path(root_path, rel)
            if not normalized.lower().endswith(".prov") or not prov_path.is_file():
                continue
            document = _read_document(prov_path)
            _source_root, source_path, source_rel = _safe_path(root_path, document["source"]["path"])
            current_source = source_metadata(source_path, source_rel) if source_path.is_file() else None
            orders.append(materialize_work_order(document, current_source))
            if current_source and current_source.get("kind") == "image":
                evidence = render_image_evidence(source_path, document)
                if evidence:
                    attachments.append(evidence)
                    orders[-1] += "\n\n视觉证据：已附加一张烘焙了稳定 ref 标签的审阅图；以标签和工作单坐标共同核对。"
            resolved.append(normalized)
        except Exception as exc:
            errors.append(f"{rel}: {exc}")
    return {
        "resolved": resolved,
        "workOrder": "\n\n---\n\n".join(orders),
        "attachments": attachments,
        "errors": errors,
    }

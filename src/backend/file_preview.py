"""工作目录文件的离线预览器。

目标不是复刻 Office/diagrams.net 的完整排版引擎，而是在不依赖外网、
本机 Office 或 LibreOffice 的前提下，稳定提供可读、可检索的结构化预览。
所有解析都有尺寸和条目上限，避免损坏文件/zip bomb 卡住后端。
"""
from __future__ import annotations

import base64
import datetime as dt
import html
import io
import mimetypes
import posixpath
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path
from typing import Any, Iterable


# 本机副本经 JSON-RPC 传入时会 Base64 膨胀约 1/3；32 MiB 可稳定留在
# 当前 50 MiB WebSocket 帧上限内。远端直读也使用同一上限，行为保持一致。
MAX_INPUT = 32 * 1024 * 1024
MAX_ZIP_TOTAL = 96 * 1024 * 1024
MAX_ZIP_ENTRY = 16 * 1024 * 1024
MAX_IMAGES = 12
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 600_000

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


class PreviewError(ValueError):
    """可展示给用户的预览错误。"""


def _xml(data: bytes) -> ET.Element:
    if len(data) > MAX_ZIP_ENTRY:
        raise PreviewError("文档内部 XML 过大，已停止预览")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise PreviewError(f"文档结构损坏：{exc}") from exc


def _open_zip(data: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise PreviewError("不是有效的 Office Open XML 文件") from exc
    total = 0
    for info in archive.infolist():
        if info.flag_bits & 0x1:
            archive.close()
            raise PreviewError("暂不预览加密文档")
        if info.file_size > MAX_ZIP_ENTRY:
            archive.close()
            raise PreviewError(f"文档内部条目过大：{info.filename}")
        total += info.file_size
        if total > MAX_ZIP_TOTAL:
            archive.close()
            raise PreviewError("文档解压后体积过大，已停止预览")
    return archive


def _read(zf: zipfile.ZipFile, name: str, required: bool = True) -> bytes:
    try:
        return zf.read(name)
    except KeyError:
        if required:
            raise PreviewError(f"文档缺少必要条目：{name}")
        return b""


def _texts(node: ET.Element, tag: str) -> str:
    return "".join((n.text or "") for n in node.findall(f".//{tag}", NS)).strip()


def _data_url(name: str, data: bytes) -> str:
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _media(zf: zipfile.ZipFile, prefix: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    used = 0
    for info in sorted(zf.infolist(), key=lambda item: item.filename):
        if not info.filename.startswith(prefix) or info.is_dir():
            continue
        mime = mimetypes.guess_type(info.filename)[0] or ""
        if not mime.startswith("image/") or len(result) >= MAX_IMAGES:
            continue
        if used + info.file_size > MAX_IMAGE_BYTES:
            break
        raw = zf.read(info)
        used += len(raw)
        result.append({"name": Path(info.filename).name, "dataUrl": _data_url(info.filename, raw)})
    return result


def _preview_docx(data: bytes) -> dict[str, Any]:
    with _open_zip(data) as zf:
        root = _xml(_read(zf, "word/document.xml"))
        body = root.find("w:body", NS)
        if body is None:
            raise PreviewError("Word 文档没有正文")
        blocks: list[dict[str, Any]] = []
        chars = 0
        truncated = False
        for child in body:
            local = child.tag.rsplit("}", 1)[-1]
            if local == "p":
                text = _texts(child, "w:t")
                if not text:
                    continue
                style_node = child.find("./w:pPr/w:pStyle", NS)
                style = style_node.get(f"{{{NS['w']}}}val", "") if style_node is not None else ""
                blocks.append({"type": "paragraph", "text": text, "style": style})
                chars += len(text)
            elif local == "tbl":
                rows: list[list[str]] = []
                for tr in child.findall("./w:tr", NS)[:80]:
                    row = [_texts(tc, "w:t") for tc in tr.findall("./w:tc", NS)[:30]]
                    rows.append(row)
                    chars += sum(map(len, row))
                blocks.append({"type": "table", "rows": rows})
            if chars >= MAX_TEXT_CHARS or len(blocks) >= 1000:
                truncated = True
                break
        return {
            "status": "ok", "kind": "word", "blocks": blocks,
            "images": _media(zf, "word/media/"), "truncated": truncated,
        }


def _column_index(ref: str) -> int:
    letters = re.match(r"[A-Za-z]+", ref or "")
    if not letters:
        return 0
    value = 0
    for char in letters.group(0).upper():
        value = value * 26 + ord(char) - 64
    return max(0, value - 1)


def _relationship_map(zf: zipfile.ZipFile, rel_path: str, base_dir: str) -> dict[str, str]:
    raw = _read(zf, rel_path, required=False)
    if not raw:
        return {}
    root = _xml(raw)
    result: dict[str, str] = {}
    for rel in root.findall("rel:Relationship", NS):
        rid = rel.get("Id", "")
        target = rel.get("Target", "")
        if rid and target and not target.startswith(("http:", "https:", "file:")):
            result[rid] = posixpath.normpath(posixpath.join(base_dir, target)).lstrip("/")
    return result


_INDEXED_COLORS = (
    "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
    "#000000", "#ffffff", "#9c0006", "#006100", "#00009c", "#9c6500", "#800080", "#008080",
    "#c0c0c0", "#808080", "#9999ff", "#993366", "#ffffcc", "#ccffff", "#660066", "#ff8080",
    "#0066cc", "#ccccff", "#000080", "#ff00ff", "#ffff00", "#00ffff", "#800080", "#800000",
    "#008080", "#0000ff", "#00ccff", "#ccffff", "#ccffcc", "#ffff99", "#99ccff", "#ff99cc",
    "#cc99ff", "#ffcc99", "#3366ff", "#33cccc", "#99cc00", "#ffcc00", "#ff9900", "#ff6600",
    "#666699", "#969696", "#003366", "#339966", "#003300", "#333300", "#993300", "#993366",
    "#333399", "#333333",
)

_BUILTIN_DATE_FORMAT_IDS = {
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
}

_BUILTIN_NUMBER_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
    9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
    14: "m/d/yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
    18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "m/d/yy h:mm",
}


def _xlsx_theme_colors(zf: zipfile.ZipFile) -> list[str]:
    raw = _read(zf, "xl/theme/theme1.xml", required=False)
    if not raw:
        return []
    root = _xml(raw)
    scheme = root.find(".//a:clrScheme", NS)
    colors: list[str] = []
    for entry in list(scheme or []):
        source = next(iter(entry), None)
        value = "" if source is None else (source.get("val") or source.get("lastClr") or "")
        colors.append(f"#{value[-6:]}" if re.fullmatch(r"[0-9A-Fa-f]{6,8}", value) else "")
    return colors


def _xlsx_tint(color: str, tint: float) -> str:
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color) or not tint:
        return color
    channels = [int(color[index:index + 2], 16) for index in (1, 3, 5)]
    adjusted = [
        round(channel * (1 + tint)) if tint < 0 else round(channel + (255 - channel) * tint)
        for channel in channels
    ]
    return "#" + "".join(f"{max(0, min(255, value)):02x}" for value in adjusted)


def _xlsx_color(node: ET.Element | None, theme: list[str]) -> str:
    if node is None:
        return ""
    raw = node.get("rgb", "")
    color = f"#{raw[-6:]}" if re.fullmatch(r"[0-9A-Fa-f]{6,8}", raw) else ""
    if not color and node.get("theme", "").isdigit():
        index = int(node.get("theme", "0"))
        color = theme[index] if index < len(theme) else ""
    if not color and node.get("indexed", "").isdigit():
        index = int(node.get("indexed", "0"))
        color = _INDEXED_COLORS[index] if index < len(_INDEXED_COLORS) else ""
    try:
        tint = float(node.get("tint", "0") or 0)
    except ValueError:
        tint = 0
    return _xlsx_tint(color, tint)


def _xlsx_styles(zf: zipfile.ZipFile) -> tuple[list[dict[str, Any]], dict[int, str]]:
    raw = _read(zf, "xl/styles.xml", required=False)
    if not raw:
        return [{}], dict(_BUILTIN_NUMBER_FORMATS)
    root = _xml(raw)
    theme = _xlsx_theme_colors(zf)
    formats = dict(_BUILTIN_NUMBER_FORMATS)
    for node in root.findall("./x:numFmts/x:numFmt", NS):
        try:
            formats[int(node.get("numFmtId", "0"))] = node.get("formatCode", "")
        except ValueError:
            continue

    fonts: list[dict[str, Any]] = []
    for node in root.findall("./x:fonts/x:font", NS):
        size = node.find("x:sz", NS)
        font: dict[str, Any] = {
            "bold": node.find("x:b", NS) is not None,
            "italic": node.find("x:i", NS) is not None,
            "underline": node.find("x:u", NS) is not None,
        }
        color = _xlsx_color(node.find("x:color", NS), theme)
        if color:
            font["color"] = color
        if size is not None:
            try:
                font["fontSize"] = max(7.0, min(36.0, float(size.get("val", "11"))))
            except ValueError:
                pass
        fonts.append(font)

    fills: list[str] = []
    for node in root.findall("./x:fills/x:fill", NS):
        pattern = node.find("x:patternFill", NS)
        color = ""
        if pattern is not None and pattern.get("patternType") not in {"none", "gray125"}:
            color = _xlsx_color(pattern.find("x:fgColor", NS), theme)
            if not color:
                color = _xlsx_color(pattern.find("x:bgColor", NS), theme)
        fills.append(color)

    borders: list[dict[str, Any]] = []
    for node in root.findall("./x:borders/x:border", NS):
        border: dict[str, Any] = {}
        for side in ("left", "right", "top", "bottom"):
            edge = node.find(f"x:{side}", NS)
            if edge is None or not edge.get("style"):
                continue
            border[side] = {
                "style": edge.get("style", "thin"),
                "color": _xlsx_color(edge.find("x:color", NS), theme) or "#9aa0a6",
            }
        borders.append(border)

    styles: list[dict[str, Any]] = []
    cell_xfs = root.find("./x:cellXfs", NS)
    for xf in list(cell_xfs or []):
        try:
            font_id = int(xf.get("fontId", "0"))
            fill_id = int(xf.get("fillId", "0"))
            border_id = int(xf.get("borderId", "0"))
            number_id = int(xf.get("numFmtId", "0"))
        except ValueError:
            font_id = fill_id = border_id = number_id = 0
        style = dict(fonts[font_id]) if font_id < len(fonts) else {}
        if fill_id < len(fills) and fills[fill_id]:
            style["fill"] = fills[fill_id]
        if border_id < len(borders) and borders[border_id]:
            style["borders"] = borders[border_id]
        number_format = formats.get(number_id, "")
        if number_format:
            style["numberFormat"] = number_format
        alignment = xf.find("x:alignment", NS)
        if alignment is not None:
            for source, target in (("horizontal", "horizontal"), ("vertical", "vertical")):
                if alignment.get(source):
                    style[target] = alignment.get(source)
            if alignment.get("wrapText") in {"1", "true"}:
                style["wrap"] = True
            if alignment.get("textRotation", "0") not in {"", "0"}:
                try:
                    style["rotation"] = int(alignment.get("textRotation", "0"))
                except ValueError:
                    pass
        styles.append(style)
    return styles or [{}], formats


def _xlsx_is_date_format(number_id: int, number_format: str) -> bool:
    if number_id in _BUILTIN_DATE_FORMAT_IDS:
        return True
    cleaned = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", number_format.lower())
    return bool(re.search(r"(?:^|[^a-z])[ymdhis]+", cleaned)) and not "e+" in cleaned


def _xlsx_number(raw: str, number_id: int, number_format: str, date_1904: bool) -> str:
    try:
        value = float(raw)
    except ValueError:
        return raw
    if _xlsx_is_date_format(number_id, number_format):
        base = dt.datetime(1904, 1, 1) if date_1904 else dt.datetime(1899, 12, 30)
        try:
            value_at = base + dt.timedelta(days=value)
            lowered = number_format.lower()
            has_date = any(token in lowered for token in ("y", "d"))
            has_time = any(token in lowered for token in ("h", "s"))
            if has_date and has_time:
                return value_at.strftime("%Y-%m-%d %H:%M:%S").rstrip("0").rstrip(":")
            if has_time and not has_date:
                return value_at.strftime("%H:%M:%S").rstrip("0").rstrip(":")
            return value_at.strftime("%Y-%m-%d")
        except (OverflowError, ValueError):
            return raw
    if "%" in number_format:
        decimal = re.search(r"\.([0#]+)%", number_format)
        places = len(decimal.group(1)) if decimal else 0
        return f"{value * 100:.{places}f}%"
    if "E+" in number_format.upper():
        decimal = re.search(r"\.([0#]+)", number_format)
        return f"{value:.{len(decimal.group(1)) if decimal else 2}E}"
    decimal = re.search(r"\.([0#]+)", number_format.split(";")[0])
    places = len(decimal.group(1)) if decimal else 0
    use_grouping = "," in number_format.split(".")[0]
    prefix = next((symbol for symbol in ("¥", "$", "€", "£") if symbol in number_format), "")
    if number_format and number_format != "General":
        return prefix + format(value, f",.{places}f" if use_grouping else f".{places}f")
    return str(int(value)) if value.is_integer() else format(value, ".15g")


def _xlsx_bounds(ref: str) -> tuple[int, int, int, int] | None:
    match = re.fullmatch(r"([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)", ref or "")
    if not match:
        return None
    return (
        int(match.group(2)), _column_index(match.group(1)),
        int(match.group(4)), _column_index(match.group(3)),
    )


def _preview_xlsx(data: bytes) -> dict[str, Any]:
    with _open_zip(data) as zf:
        shared: list[str] = []
        shared_raw = _read(zf, "xl/sharedStrings.xml", required=False)
        if shared_raw:
            shared_root = _xml(shared_raw)
            shared = [_texts(si, "x:t") for si in shared_root.findall("x:si", NS)]

        workbook = _xml(_read(zf, "xl/workbook.xml"))
        rels = _relationship_map(zf, "xl/_rels/workbook.xml.rels", "xl")
        styles, number_formats = _xlsx_styles(zf)
        workbook_pr = workbook.find("x:workbookPr", NS)
        date_1904 = workbook_pr is not None and workbook_pr.get("date1904") in {"1", "true"}
        calc_pr = workbook.find("x:calcPr", NS)
        calc_mode = calc_pr.get("calcMode", "auto") if calc_pr is not None else "auto"
        sheets: list[dict[str, Any]] = []
        truncated = False
        for sheet in workbook.findall(".//x:sheet", NS)[:12]:
            name = sheet.get("name", f"Sheet {len(sheets) + 1}")
            rid = sheet.get(f"{{{NS['r']}}}id", "")
            target = rels.get(rid)
            if not target:
                continue
            root = _xml(_read(zf, target))
            sheet_format = root.find("x:sheetFormatPr", NS)
            try:
                default_row_height = float(sheet_format.get("defaultRowHeight", "20")) if sheet_format is not None else 20
            except ValueError:
                default_row_height = 20
            try:
                default_col_width = float(sheet_format.get("defaultColWidth", "9")) if sheet_format is not None else 9
            except ValueError:
                default_col_width = 9

            columns: dict[int, dict[str, Any]] = {}
            for col in root.findall("./x:cols/x:col", NS):
                try:
                    first = max(1, int(col.get("min", "1")))
                    last = min(60, int(col.get("max", str(first))))
                    width = max(2.0, min(80.0, float(col.get("width", str(default_col_width)))))
                except ValueError:
                    continue
                for one_based in range(first, last + 1):
                    columns[one_based - 1] = {
                        "index": one_based - 1,
                        "width": width,
                        "hidden": col.get("hidden") in {"1", "true"},
                    }

            rows: list[dict[str, Any]] = []
            formula_count = 0
            cached_formula_count = 0
            max_column = 0
            all_row_nodes = root.findall(".//x:sheetData/x:row", NS)
            for position, row_node in enumerate(all_row_nodes[:300]):
                try:
                    row_index = max(1, int(row_node.get("r", str(position + 1))))
                except ValueError:
                    row_index = position + 1
                cells: list[dict[str, Any]] = []
                for cell in row_node.findall("x:c", NS):
                    idx = _column_index(cell.get("r", ""))
                    if idx >= 60:
                        truncated = True
                        continue
                    max_column = max(max_column, idx + 1)
                    kind = cell.get("t", "")
                    style_id = int(cell.get("s", "0")) if cell.get("s", "0").isdigit() else 0
                    number_id = 0
                    # style_id 对应的 numFmt 已经折叠在公开 style 中；从格式码判断
                    # 日期/百分比等显示即可覆盖常见预览，缺失时保持原始数值。
                    number_format = str((styles[style_id] if style_id < len(styles) else {}).get("numberFormat") or "")
                    value_node = cell.find("x:v", NS)
                    if kind == "inlineStr":
                        value = _texts(cell, "x:t")
                        raw_value = value
                    else:
                        raw_value = ((value_node.text or "") if value_node is not None else "").strip()
                        value = raw_value
                        if kind == "s" and raw_value.isdigit() and int(raw_value) < len(shared):
                            value = shared[int(raw_value)]
                        elif kind == "b":
                            value = "TRUE" if raw_value == "1" else "FALSE"
                        elif kind not in {"str", "e", "d"} and raw_value:
                            value = _xlsx_number(raw_value, number_id, number_format, date_1904)
                    formula_node = cell.find("x:f", NS)
                    formula = (formula_node.text or "").strip() if formula_node is not None else ""
                    if formula_node is not None:
                        formula_count += 1
                        if value_node is not None:
                            cached_formula_count += 1
                        if not formula and formula_node.get("t") == "shared":
                            formula = f"[共享公式 {formula_node.get('si', '')}]"
                    cells.append({
                        "address": cell.get("r", "") or f"R{row_index}C{idx + 1}",
                        "row": row_index,
                        "column": idx,
                        "value": value,
                        "rawValue": raw_value,
                        "formula": formula,
                        "formulaCached": formula_node is None or value_node is not None,
                        "type": kind or "number",
                        "style": style_id if style_id < len(styles) else 0,
                    })
                row: dict[str, Any] = {"index": row_index, "cells": cells}
                if row_node.get("ht"):
                    try:
                        row["height"] = max(8.0, min(180.0, float(row_node.get("ht", "20"))))
                    except ValueError:
                        pass
                if row_node.get("hidden") in {"1", "true"}:
                    row["hidden"] = True
                rows.append(row)
            if len(all_row_nodes) > len(rows):
                truncated = True

            merges: list[dict[str, Any]] = []
            for merge in root.findall("./x:mergeCells/x:mergeCell", NS)[:500]:
                ref = merge.get("ref", "")
                bounds = _xlsx_bounds(ref)
                if not bounds:
                    continue
                start_row, start_col, end_row, end_col = bounds
                if start_col >= 60 or start_row > 300:
                    continue
                merges.append({
                    "ref": ref, "startRow": start_row, "startColumn": start_col,
                    "endRow": min(300, end_row), "endColumn": min(59, end_col),
                })
                max_column = max(max_column, min(60, end_col + 1))

            pane = root.find("./x:sheetViews/x:sheetView/x:pane", NS)
            frozen: dict[str, Any] = {}
            if pane is not None and pane.get("state") in {"frozen", "frozenSplit"}:
                try:
                    frozen["rows"] = max(0, int(float(pane.get("ySplit", "0"))))
                    frozen["columns"] = max(0, int(float(pane.get("xSplit", "0"))))
                except ValueError:
                    frozen = {}
                if pane.get("topLeftCell"):
                    frozen["topLeftCell"] = pane.get("topLeftCell")

            auto_filter = root.find("x:autoFilter", NS)
            sheets.append({
                "name": name,
                "rows": rows,
                "columns": [columns[index] for index in sorted(columns)],
                "merges": merges,
                "rowCount": max((row["index"] for row in rows), default=0),
                "columnCount": max(max_column, max(columns, default=-1) + 1),
                "defaultRowHeight": default_row_height,
                "defaultColumnWidth": default_col_width,
                "formulaCount": formula_count,
                "cachedFormulaCount": cached_formula_count,
                "frozen": frozen,
                "autoFilter": auto_filter.get("ref", "") if auto_filter is not None else "",
            })
        if len(workbook.findall(".//x:sheet", NS)) > len(sheets):
            truncated = True
        return {
            "status": "ok", "kind": "excel", "sheets": sheets, "styles": styles,
            "calculation": {"mode": calc_mode, "date1904": date_1904},
            "truncated": truncated,
        }


def _slide_number(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def _preview_pptx(data: bytes) -> dict[str, Any]:
    with _open_zip(data) as zf:
        slide_names = sorted(
            (n for n in zf.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=_slide_number,
        )
        slides: list[dict[str, Any]] = []
        image_bytes = 0
        image_count = 0
        truncated = False
        for slide_name in slide_names[:60]:
            root = _xml(_read(zf, slide_name))
            paragraphs: list[str] = []
            for paragraph in root.findall(".//a:p", NS):
                value = _texts(paragraph, "a:t")
                if value:
                    paragraphs.append(value)
            rel_name = posixpath.join(
                posixpath.dirname(slide_name), "_rels", posixpath.basename(slide_name) + ".rels"
            )
            rels = _relationship_map(zf, rel_name, posixpath.dirname(slide_name))
            images: list[dict[str, str]] = []
            seen: set[str] = set()
            for blip in root.findall(".//a:blip", NS):
                rid = blip.get(f"{{{NS['r']}}}embed", "")
                target = rels.get(rid, "")
                if not target or target in seen or target not in zf.namelist():
                    continue
                seen.add(target)
                info = zf.getinfo(target)
                mime = mimetypes.guess_type(target)[0] or ""
                if (not mime.startswith("image/") or image_count >= MAX_IMAGES
                        or image_bytes + info.file_size > MAX_IMAGE_BYTES):
                    truncated = True
                    continue
                raw = zf.read(target)
                image_bytes += len(raw)
                image_count += 1
                images.append({"name": Path(target).name, "dataUrl": _data_url(target, raw)})
            slides.append({
                "number": _slide_number(slide_name),
                "title": paragraphs[0] if paragraphs else f"幻灯片 {_slide_number(slide_name)}",
                "texts": paragraphs,
                "images": images,
            })
        if len(slide_names) > len(slides):
            truncated = True
        return {"status": "ok", "kind": "powerpoint", "slides": slides, "truncated": truncated}


def _style_map(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in (raw or "").split(";"):
        if "=" in part:
            key, value = part.split("=", 1)
            result[key] = value
        elif part:
            result[part] = "1"
    return result


def _plain_label(raw: str) -> str:
    value = html.unescape(re.sub(r"<[^>]+>", " ", raw or ""))
    return re.sub(r"\s+", " ", value).strip()


def _drawio_model(diagram: ET.Element) -> ET.Element:
    direct = next((child for child in diagram if child.tag.rsplit("}", 1)[-1] == "mxGraphModel"), None)
    if direct is not None:
        return direct
    encoded = (diagram.text or "").strip()
    if not encoded:
        raise PreviewError("Draw.io 页面没有画布数据")
    try:
        compressed = base64.b64decode(encoded)
        xml_text = urllib.parse.unquote(zlib.decompress(compressed, -15).decode("utf-8"))
        return _xml(xml_text.encode("utf-8"))
    except Exception as exc:
        raise PreviewError("无法解码 Draw.io 页面") from exc


def _drawio_svg(model: ET.Element) -> str:
    cells = {c.get("id", ""): c for c in model.findall(".//mxCell") if c.get("id")}
    positions: dict[str, tuple[float, float, float, float]] = {}

    def position(cell_id: str, seen: set[str] | None = None) -> tuple[float, float, float, float]:
        if cell_id in positions:
            return positions[cell_id]
        cell = cells.get(cell_id)
        if cell is None:
            return (0, 0, 0, 0)
        geom = cell.find("mxGeometry")
        if geom is None:
            result = (0, 0, 0, 0)
        else:
            def number(key: str) -> float:
                try:
                    return float(geom.get(key, "0"))
                except ValueError:
                    return 0.0
            x, y, width, height = number("x"), number("y"), number("width"), number("height")
            parent = cell.get("parent", "")
            chain = set(seen or ())
            if parent and parent not in chain:
                chain.add(cell_id)
                px, py, _, _ = position(parent, chain)
                x += px
                y += py
            result = (x, y, width, height)
        positions[cell_id] = result
        return result

    vertices: list[tuple[ET.Element, tuple[float, float, float, float]]] = []
    edges: list[ET.Element] = []
    for cell in cells.values():
        if cell.get("vertex") == "1":
            vertices.append((cell, position(cell.get("id", ""))))
        elif cell.get("edge") == "1":
            edges.append(cell)
    if not vertices:
        raise PreviewError("Draw.io 页面没有可渲染的图形节点")

    min_x = min(p[0] for _, p in vertices) - 30
    min_y = min(p[1] for _, p in vertices) - 30
    max_x = max(p[0] + max(p[2], 40) for _, p in vertices) + 30
    max_y = max(p[1] + max(p[3], 30) for _, p in vertices) + 30
    width, height = max(160.0, max_x - min_x), max(100.0, max_y - min_y)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x:g} {min_y:g} {width:g} {height:g}" '
        f'width="{width:g}" height="{height:g}">',
        '<defs><marker id="awuArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" '
        'markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker></defs>',
        '<rect x="-100000" y="-100000" width="200000" height="200000" fill="#ffffff"/>',
    ]
    for edge in edges:
        src = position(edge.get("source", ""))
        dst = position(edge.get("target", ""))
        if not src[2] or not dst[2]:
            continue
        x1, y1 = src[0] + src[2] / 2, src[1] + src[3] / 2
        x2, y2 = dst[0] + dst[2] / 2, dst[1] + dst[3] / 2
        styles = _style_map(edge.get("style", ""))
        stroke = styles.get("strokeColor", "#64748b")
        dashed = ' stroke-dasharray="6 4"' if styles.get("dashed") == "1" else ""
        arrow = "" if styles.get("endArrow") == "none" else ' marker-end="url(#awuArrow)"'
        out.append(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" '
                   f'stroke="{html.escape(stroke)}" stroke-width="2"{dashed}{arrow}/>')
    for cell, (x, y, w, h) in vertices:
        styles = _style_map(cell.get("style", ""))
        fill = styles.get("fillColor", "#ffffff")
        stroke = styles.get("strokeColor", "#64748b")
        shape = styles.get("shape", "")
        if "ellipse" in styles or shape == "ellipse":
            out.append(f'<ellipse cx="{x + w / 2:g}" cy="{y + h / 2:g}" rx="{w / 2:g}" ry="{h / 2:g}" '
                       f'fill="{html.escape(fill)}" stroke="{html.escape(stroke)}" stroke-width="2"/>')
        elif "rhombus" in styles or shape == "rhombus":
            points = f"{x + w / 2:g},{y:g} {x + w:g},{y + h / 2:g} {x + w / 2:g},{y + h:g} {x:g},{y + h / 2:g}"
            out.append(f'<polygon points="{points}" fill="{html.escape(fill)}" stroke="{html.escape(stroke)}" stroke-width="2"/>')
        else:
            radius = 10 if styles.get("rounded") == "1" else 2
            out.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{radius}" '
                       f'fill="{html.escape(fill)}" stroke="{html.escape(stroke)}" stroke-width="2"/>')
        label = _plain_label(cell.get("value", ""))
        if label:
            chunks = [label[i:i + 22] for i in range(0, min(len(label), 88), 22)]
            start_y = y + h / 2 - (len(chunks) - 1) * 8
            out.append(f'<text x="{x + w / 2:g}" y="{start_y:g}" text-anchor="middle" '
                       'font-family="system-ui, sans-serif" font-size="13" fill="#0f172a">')
            for idx, line in enumerate(chunks):
                dy = 0 if idx == 0 else 16
                out.append(f'<tspan x="{x + w / 2:g}" dy="{dy}">{html.escape(line)}</tspan>')
            out.append("</text>")
    out.append("</svg>")
    return "".join(out)


def _preview_drawio(data: bytes) -> dict[str, Any]:
    root = _xml(data)
    diagrams: Iterable[ET.Element]
    if root.tag.rsplit("}", 1)[-1] == "mxGraphModel":
        wrapper = ET.Element("diagram", {"name": "Page 1"})
        wrapper.append(root)
        diagrams = [wrapper]
    else:
        diagrams = root.findall(".//diagram")
    pages: list[dict[str, str]] = []
    for idx, diagram in enumerate(diagrams):
        if idx >= 20:
            break
        pages.append({
            "name": diagram.get("name", f"Page {idx + 1}"),
            "svg": _drawio_svg(_drawio_model(diagram)),
        })
    if not pages:
        raise PreviewError("Draw.io 文件中没有页面")
    return {"status": "ok", "kind": "drawio", "pages": pages, "truncated": len(pages) >= 20}


def preview_bytes(name: str, data: bytes) -> dict[str, Any]:
    """解析受支持的文档，返回可直接 JSON 序列化的结构。"""
    if len(data) > MAX_INPUT:
        return {"status": "error", "message": "文件过大，预览上限为 32 MB"}
    ext = Path(name).suffix.lower()
    try:
        if ext == ".docx":
            return _preview_docx(data)
        if ext in {".xlsx", ".xlsm"}:
            return _preview_xlsx(data)
        if ext == ".pptx":
            return _preview_pptx(data)
        if ext in {".drawio", ".dio"}:
            return _preview_drawio(data)
        if ext in {".doc", ".xls", ".ppt"}:
            return {
                "status": "unsupported", "kind": "legacy-office",
                "message": "这是旧版 Office 二进制格式，离线安全预览不可靠；请用系统应用打开或另存为 DOCX/XLSX/PPTX。",
            }
        return {"status": "unsupported", "message": f"暂不支持预览 {ext or '此类'} 文件"}
    except PreviewError as exc:
        return {"status": "error", "message": str(exc)}
    except Exception as exc:  # 边界层兜底，损坏文档不能拖垮 WS 服务
        return {"status": "error", "message": f"预览解析失败：{exc}"}


def preview_path(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"status": "error", "message": "文件不存在"}
    try:
        size = path.stat().st_size
        if size > MAX_INPUT:
            return {"status": "error", "message": "文件过大，预览上限为 32 MB"}
        return preview_bytes(path.name, path.read_bytes())
    except OSError as exc:
        return {"status": "error", "message": f"读取文件失败：{exc}"}

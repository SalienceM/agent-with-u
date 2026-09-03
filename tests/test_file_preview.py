from __future__ import annotations

import io
import unittest
import zipfile

from src.backend.file_preview import preview_bytes


def _zip(entries: dict[str, str | bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return out.getvalue()


def test_docx_semantic_preview() -> None:
    data = _zip({
        "word/document.xml": """<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目报告</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          </w:body>
        </w:document>""",
        "word/media/image1.png": b"\x89PNG\r\n\x1a\n",
    })
    result = preview_bytes("report.docx", data)
    assert result["status"] == "ok", result
    assert result["kind"] == "word"
    assert result["blocks"][0]["text"] == "项目报告"
    assert result["blocks"][1]["rows"] == [["A1", "B1"]]
    assert result["images"][0]["dataUrl"].startswith("data:image/png;base64,")


def test_xlsx_sheet_and_shared_strings_preview() -> None:
    data = _zip({
        "xl/workbook.xml": """<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>""",
        "xl/_rels/workbook.xml.rels": """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>""",
        "xl/sharedStrings.xml": """<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <si><t>姓名</t></si><si><t>Alice</t></si><si><t>合计</t></si></sst>""",
        "xl/styles.xml": """<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <fonts count="2"><font><sz val="11"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/></font></fonts>
          <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
            <fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill></fills>
          <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
          <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
            <xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center" wrapText="1"/></xf></cellXfs>
        </styleSheet>""",
        "xl/worksheets/sheet1.xml": """<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>
          <cols><col min="1" max="1" width="18" customWidth="1"/></cols>
          <sheetData><row r="1" ht="24"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1"><v>42</v></c>
            <c r="C1" t="s" s="1"><v>2</v></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>B1*2</f><v>84</v></c></row>
          <row r="3"><c r="B3"><f>SUM(B1:B2)</f></c></row></sheetData>
          <mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>
          <autoFilter ref="A1:D3"/></worksheet>""",
    })
    result = preview_bytes("data.xlsx", data)
    assert result["status"] == "ok", result
    sheet = result["sheets"][0]
    assert sheet["name"] == "数据"
    assert sheet["rows"][0]["cells"][0]["value"] == "姓名"
    assert sheet["rows"][1]["cells"][1]["formula"] == "B1*2"
    assert sheet["rows"][1]["cells"][1]["value"] == "84"
    assert sheet["rows"][2]["cells"][0]["value"] == ""
    assert sheet["rows"][2]["cells"][0]["formulaCached"] is False
    assert sheet["columns"][0]["width"] == 18
    assert sheet["rows"][0]["height"] == 24
    assert sheet["merges"][0]["ref"] == "C1:D1"
    assert sheet["frozen"]["rows"] == 1
    assert sheet["autoFilter"] == "A1:D3"
    assert sheet["formulaCount"] == 2
    assert sheet["cachedFormulaCount"] == 1
    assert result["styles"][1]["fill"] == "#4472C4"
    assert result["styles"][1]["bold"] is True


def test_pptx_text_and_slide_image_preview() -> None:
    data = _zip({
        "ppt/slides/slide1.xml": """<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>季度复盘</a:t></a:r></a:p>
          <a:p><a:r><a:t>增长 25%</a:t></a:r></a:p></p:txBody></p:sp>
          <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>""",
        "ppt/slides/_rels/slide1.xml.rels": """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId2" Target="../media/image1.png"/></Relationships>""",
        "ppt/media/image1.png": b"\x89PNG\r\n\x1a\n",
    })
    result = preview_bytes("deck.pptx", data)
    assert result["status"] == "ok", result
    assert result["slides"][0]["title"] == "季度复盘"
    assert result["slides"][0]["texts"] == ["季度复盘", "增长 25%"]
    assert len(result["slides"][0]["images"]) == 1


def test_drawio_common_shapes_and_edge_render_to_svg() -> None:
    data = b"""<mxfile><diagram name="Flow"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" value="Start" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="50"/></mxCell>
      <mxCell id="3" value="Done" style="rounded=1;fillColor=#dcfce7" vertex="1" parent="1"><mxGeometry x="220" y="20" width="100" height="50"/></mxCell>
      <mxCell id="4" edge="1" source="2" target="3" parent="1"><mxGeometry relative="1"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>"""
    result = preview_bytes("flow.drawio", data)
    assert result["status"] == "ok"
    svg = result["pages"][0]["svg"]
    assert "Start" in svg and "Done" in svg
    assert "marker-end" in svg


def test_legacy_office_and_broken_zip_degrade_cleanly() -> None:
    legacy = preview_bytes("old.doc", b"binary")
    assert legacy["status"] == "unsupported"
    assert legacy["kind"] == "legacy-office"

    broken = preview_bytes("broken.docx", b"not-a-zip")
    assert broken["status"] == "error"
    assert "Office Open XML" in broken["message"]


class FilePreviewTests(unittest.TestCase):
    def test_docx(self) -> None:
        test_docx_semantic_preview()

    def test_xlsx(self) -> None:
        test_xlsx_sheet_and_shared_strings_preview()

    def test_pptx(self) -> None:
        test_pptx_text_and_slide_image_preview()

    def test_drawio(self) -> None:
        test_drawio_common_shapes_and_edge_render_to_svg()

    def test_safe_degradation(self) -> None:
        test_legacy_office_and_broken_zip_degrade_cleanly()


if __name__ == "__main__":
    unittest.main()

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from src.backend.prov_service import (
    ProvError,
    extract_prov_references,
    open_prov,
    resolve_prompt,
    save_prov,
    validate_document,
)


def annotation(annotation_id: str, ref: str, selector: dict, parent_id=None) -> dict:
    return {
        "id": annotation_id,
        "ref": ref,
        "title": "",
        "parentId": parent_id,
        "order": 0,
        "target": {"selector": selector},
        "body": {
            "kind": "change_request",
            "comment": "请修改这里",
            "expected": "修改后更清楚",
            "severity": "normal",
            "blocking": True,
        },
        "status": "open",
        "createdAt": "2026-08-11T00:00:00+08:00",
        "updatedAt": "2026-08-11T00:00:00+08:00",
    }


class ProvServiceTests(unittest.TestCase):
    def test_markdown_round_trip_conflict_and_rebind(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "docs" / "requirements.md"
            source.parent.mkdir()
            source.write_text("# 目标\n\n第一段内容。", encoding="utf-8")

            opened = open_prov(root, "docs/requirements.md")
            self.assertEqual(opened["status"], "ok")
            self.assertFalse(opened["existing"])
            self.assertEqual(opened["document"]["review"]["revision"], 0)
            document = opened["document"]
            document["annotations"].append(annotation(
                "ann_1", "段1", {
                    "type": "text-block",
                    "headingPath": ["目标"],
                    "blockFingerprint": "sha256:test",
                    "exactQuote": "第一段内容。",
                    "startOffset": 0,
                    "endOffset": 6,
                    "blockIndex": 1,
                },
            ))

            saved = save_prov(root, opened["provPath"], document, 0)
            self.assertEqual(saved["status"], "ok")
            self.assertEqual(saved["document"]["review"]["revision"], 1)
            self.assertTrue((root / "docs" / "requirements.md.prov").is_file())

            stale = save_prov(root, opened["provPath"], document, 0)
            self.assertEqual(stale["status"], "conflict")

            source.write_text("# 目标\n\n第一段已经变化。", encoding="utf-8")
            changed = save_prov(root, opened["provPath"], saved["document"], 1)
            self.assertEqual(changed["status"], "source_changed")
            rebound = save_prov(
                root, opened["provPath"], saved["document"], 1, rebind_source=True,
            )
            self.assertEqual(rebound["status"], "ok")
            self.assertEqual(rebound["document"]["review"]["revision"], 2)

    def test_image_work_order_has_baked_visual_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_path = root / "screen.png"
            Image.new("RGB", (320, 180), "white").save(image_path)
            opened = open_prov(root, "screen.png")
            document = opened["document"]
            document["annotations"].append(annotation(
                "ann_box", "框1", {
                    "type": "image-region",
                    "shape": "rectangle",
                    "geometry": {
                        "unit": "normalized", "x": 0.1, "y": 0.2,
                        "width": 0.4, "height": 0.3,
                    },
                },
            ))
            saved = save_prov(root, opened["provPath"], document, 0)
            self.assertEqual(saved["status"], "ok")

            resolved = resolve_prompt(root, "请针对 `screen.png.prov` 进行优化")
            self.assertEqual(resolved["resolved"], ["screen.png.prov"])
            self.assertIn("[框1]", resolved["workOrder"])
            self.assertIn("最终验证权属于用户", resolved["workOrder"])
            self.assertEqual(len(resolved["attachments"]), 1)
            self.assertGreater(resolved["attachments"][0]["size"], 0)

    def test_parent_cycle_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "a.md"
            source.write_text("hello", encoding="utf-8")
            document = open_prov(root, "a.md")["document"]
            document["annotations"] = [
                annotation("a", "段1", {"type": "document"}, "b"),
                annotation("b", "文1", {"type": "document"}, "a"),
            ]
            with self.assertRaises(ProvError):
                validate_document(document)

    def test_approved_review_cannot_keep_unverified_blocker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.md").write_text("hello", encoding="utf-8")
            document = open_prov(root, "a.md")["document"]
            document["review"]["state"] = "approved"
            document["annotations"] = [
                annotation("a", "总1", {"type": "document"}),
            ]
            with self.assertRaises(ProvError):
                validate_document(document, final=True)
            document["annotations"][0]["status"] = "verified"
            validate_document(document, final=True)

    def test_reference_parser_handles_quotes_and_bare_paths(self):
        refs = extract_prov_references(
            "处理 `docs/有 空格.md.prov`，再看 assets/screen.png.prov 和 assets/screen.png.prov文件；"
            "最后针对 docs/第二份.md.prov 优化"
        )
        self.assertEqual(refs, [
            "docs/有 空格.md.prov", "assets/screen.png.prov", "docs/第二份.md.prov",
        ])


if __name__ == "__main__":
    unittest.main()

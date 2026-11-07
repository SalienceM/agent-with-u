from __future__ import annotations

import asyncio
import base64
import io
import threading
import unittest
from unittest.mock import patch

from PIL import Image, PngImagePlugin

from src.backend import deepseek_harness_images as policy
from tests.fixtures.harness_images import image_bytes, image_samples


def attachment(raw: bytes | None = None, mime: str = "image/png", **extra: object) -> dict:
    return {"base64": base64.b64encode(image_bytes() if raw is None else raw).decode(), "mime_type": mime, **extra}


def sized_png(size: int) -> bytes:
    """有效 PNG ancillary chunk 精确填充文件预算，不使用解码器忽略的尾部垃圾。"""
    def make(padding: int) -> bytes:
        with Image.new("RGB", (1, 1), "red") as image, io.BytesIO() as output:
            info = PngImagePlugin.PngInfo()
            info.add(b"raNd", b"x" * padding)
            image.save(output, format="PNG", pnginfo=info)
            return output.getvalue()
    return make(size - len(make(0)))


class HarnessImagePolicyTests(unittest.TestCase):
    def assert_reason(self, reason: str, images: object) -> None:
        with self.assertRaises(policy.ImagePolicyError) as caught:
            policy.validate_images_sync(images)
        self.assertEqual(caught.exception.reason, reason)

    def test_formats_real_counts_ignore_claimed_metadata(self) -> None:
        for fmt, mime in policy.FORMAT_MIME.items():
            raw = image_bytes(fmt)
            result, = policy.validate_images_sync([attachment(raw, mime, size=-1, width=1, height=1,
                file_path="must-not-read", url="https://must-not-fetch.invalid/")])
            self.assertEqual(result.byte_count, len(raw))
            self.assertEqual((result.width, result.height), (32, 24))
            self.assertEqual(result.content_block()["mimeType"], mime)
        self.assertEqual(policy.validate_images_sync([]), ())
        self.assertEqual(len(policy.validate_images_sync([attachment()] * 4)), 4)
        self.assert_reason("too_many_images", [attachment()] * 5)

    def test_strict_encoding_container_and_whole_batch_rejection(self) -> None:
        for bad in ("!", "é", "dGVzdA===", "dGVzdA==\n", "Zg=", "Zh==", "data:image/png;base64,eA=="):
            self.assert_reason("invalid_base64", [attachment(), {"base64": bad, "mime_type": "image/png"}])
        for bad in ({}, "[]", [None], [{"base64": 5, "mime_type": "image/png"}], [{"file_path": "x"}]):
            self.assert_reason("invalid_container", bad)
        self.assert_reason("mime_mismatch", [attachment(image_bytes(), "image/jpeg")])
        self.assert_reason("unsupported_format", [attachment(b"<svg/>", "image/svg+xml")])
        with patch("builtins.open", side_effect=AssertionError("Must not read attachment path")):
            self.assert_reason("invalid_container", [{"file_path": "sensitive", "url": "https://invalid/"}])

    def test_animation_corruption_and_full_decode(self) -> None:
        samples = image_samples()
        self.assert_reason("animated_image", [attachment(samples["animated"], "image/webp")])
        for raw in (samples["truncated"], samples["fake_mime"], samples["png"][:-1], image_bytes("JPEG")[:-2]):
            self.assert_reason("corrupt_image", [attachment(raw, "image/jpeg" if raw.startswith(b"\xff\xd8") else "image/png")])
        with patch.object(policy.Image, "open", side_effect=Image.DecompressionBombWarning()):
            self.assert_reason("image_dimensions", [attachment()])

    def test_exact_single_and_total_byte_boundaries(self) -> None:
        for size in (policy.MAX_IMAGE_BYTES - 1, policy.MAX_IMAGE_BYTES):
            raw = sized_png(size)
            self.assertEqual(len(raw), size)
            self.assertEqual(policy.validate_images_sync([attachment(raw)])[0].byte_count, size)
        self.assert_reason("image_bytes", [attachment(sized_png(policy.MAX_IMAGE_BYTES + 1))])
        large = attachment(sized_png(policy.MAX_IMAGE_BYTES))
        self.assertEqual(sum(i.byte_count for i in policy.validate_images_sync([large, large])), policy.MAX_TOTAL_IMAGE_BYTES)
        self.assert_reason("total_bytes", [large, large, attachment()])

    def test_edges_and_pixel_boundaries(self) -> None:
        for size in ((8192, 1), (1, 8192), (4000, 4000), (3999, 4000)):
            self.assertEqual(policy.validate_images_sync([attachment(image_bytes(size=size))])[0].width, size[0])
        for size in ((8193, 1), (1, 8193), (4001, 4000)):
            self.assert_reason("image_dimensions", [attachment(image_bytes(size=size))])
        large = attachment(image_bytes(size=(4000, 4000)))
        self.assertEqual(len(policy.validate_images_sync([large, large])), 2)
        self.assert_reason("total_pixels", [large, large, attachment(image_bytes(size=(1, 1)))])

    def test_native_blocks_are_ordered_and_pure_images_have_no_forged_text(self) -> None:
        images = policy.validate_images_sync([attachment(), attachment(image_bytes("WEBP"), "image/webp")])
        self.assertEqual([b["type"] for b in policy.content_blocks("", images)], ["image", "image"])
        self.assertEqual([b["type"] for b in policy.content_blocks("你好", images)], ["text", "image", "image"])
        self.assertEqual(policy.content_blocks("", images)[0]["data"], images[0].data)
        self.assertNotEqual(policy.image_digest(images), policy.image_digest(list(reversed(images))))
        message = {"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {
            "sessionId": "fixture", "contentBlocks": policy.content_blocks("中", images)}}
        self.assertEqual(policy.check_request_budget(message), len(policy.encode_frame(message)))
        self.assertGreater(policy.check_request_budget(message), sum(len(image.data) for image in images))

    def test_budget_uses_full_utf8_envelope_and_newline(self) -> None:
        message = {"jsonrpc": "2.0", "id": 123, "method": "session/prompt", "params": {
            "sessionId": "test", "contentBlocks": [{"type": "text", "text": ""}]}}
        overhead = len(policy.encode_frame(message))
        text = "中" * ((policy.MAX_REQUEST_BYTES - overhead) // 3)
        message["params"]["contentBlocks"][0]["text"] = text + "x" * ((policy.MAX_REQUEST_BYTES - overhead) % 3)
        self.assertEqual(policy.check_request_budget(message), policy.MAX_REQUEST_BYTES)
        message["params"]["contentBlocks"][0]["text"] += "x"
        with self.assertRaises(policy.ImagePolicyError) as caught:
            policy.check_request_budget(message)
        self.assertEqual(caught.exception.reason, "request_bytes")


class HarnessImageAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_decode_runs_off_main_event_loop(self) -> None:
        main = threading.get_ident()
        workers: list[int] = []
        started, release = threading.Event(), threading.Event()
        real = policy._decode_image
        def slow_decode(raw: bytes, mime: str, remaining_pixels: int) -> tuple[int, int]:
            workers.append(threading.get_ident())
            started.set()
            if not release.wait(2):
                raise AssertionError("Event loop did not release decoder")
            return real(raw, mime, remaining_pixels)
        with patch.object(policy, "_decode_image", slow_decode):
            task = asyncio.create_task(policy.validate_images([attachment()]))
            try:
                for _ in range(100):
                    await asyncio.sleep(.01)
                    if started.is_set():
                        break
                self.assertTrue(started.is_set())
            finally:
                release.set()
            await task
        self.assertTrue(all(worker != main for worker in workers))


if __name__ == "__main__":
    unittest.main()

"""图片夹具自身的隔离/资源验证，不把假服务成功当作生产模型验收。"""
from __future__ import annotations

import io
import json
import os
from types import SimpleNamespace
import unittest
from urllib.request import ProxyHandler, Request, build_opener

from PIL import Image

from tests.fixtures.harness_images import FIXTURE_KEY, ImageWorkspace, LocalImageModel, image_samples, run_prompt


class ImageFixtureTests(unittest.TestCase):
    def test_unconfirmed_cleanup_retains_fixture_instead_of_implicit_finalizer_delete(self) -> None:
        fixture = ImageWorkspace()
        fixture.__enter__()
        # 只模拟缺证据，不创建实际进程。
        fixture.owners.append(SimpleNamespace(confirmed=False))
        try:
            with self.assertRaisesRegex(AssertionError, "retained"):
                fixture.__exit__(None, None, None)
            self.assertTrue(fixture.root.exists())
            self.assertFalse(fixture._temporary._finalizer.alive)
        finally:
            fixture.owners.clear()
            fixture._temporary.cleanup()
        self.assertFalse(fixture.root.exists())

    def test_synthetic_samples_include_formats_corruption_animation_and_budgets(self) -> None:
        samples = image_samples()
        for name, fmt in (("png", "PNG"), ("jpeg", "JPEG"), ("webp", "WEBP")):
            with Image.open(io.BytesIO(samples[name])) as image:
                image.load()
                self.assertEqual(image.format, fmt)
                self.assertEqual(getattr(image, "n_frames", 1), 1)
        with self.assertRaises(OSError), Image.open(io.BytesIO(samples["truncated"])) as image:
            image.load()
        with Image.open(io.BytesIO(samples["animated"])) as image:
            self.assertGreater(image.n_frames, 1)
        self.assertGreater(len(samples["oversized_bytes"]), 4 * 1024 * 1024)
        with Image.open(io.BytesIO(samples["oversized_edge"])) as image:
            self.assertEqual(image.width, 8193)

    def test_temp_workspace_and_catalog_cleanup(self) -> None:
        previous = os.environ.get("AGENT_WITH_U_DATA_ROOT")
        with ImageWorkspace() as fixture, LocalImageModel() as model:
            root = fixture.root
            from src.backend.paths import data_root
            self.assertEqual(data_root(), fixture.data)
            self.assertEqual(os.environ["DSH_HOME"], str(fixture.home))
            request = Request(model.url + "/models", headers={"x-api-key": FIXTURE_KEY})
            opener = build_opener(ProxyHandler({}))  # Windows 注册表代理也不能接触夹具请求。
            with opener.open(request, timeout=2) as response:
                self.assertEqual(json.load(response)["data"][0]["input_modalities"], ["text", "image"])
            model.catalog_status = 404
            from urllib.error import HTTPError
            with self.assertRaises(HTTPError):
                opener.open(request, timeout=2)
            self.assertEqual(model.posts, [])
            self.assertEqual(model.errors, [])
        self.assertFalse(model.thread.is_alive())
        self.assertFalse(root.exists())
        self.assertEqual(os.environ.get("AGENT_WITH_U_DATA_ROOT"), previous)

    @unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
    def test_native_fixture_uses_only_local_fake_credentials_and_confirms_tree_exit(self) -> None:
        with ImageWorkspace() as fixture, LocalImageModel() as model:
            with fixture.client(model, route="smoke-model") as client:
                notes = run_prompt(client, [{"type": "text", "text": "fixture only"}])
                reasons = [n.payload["event"]["data"]["reason"]["kind"] for n in notes
                           if n.payload.get("event", {}).get("type") == "turn/end"]
                self.assertEqual(reasons, ["completed"])
            self.assertEqual(len(model.posts), 1)
            self.assertEqual(model.errors, [])
            self.assertTrue(all(owner.confirmed for owner in fixture.owners))
            evidence = [json.loads(line) for line in (fixture.root / "probe.jsonl").read_text().splitlines()]
            self.assertFalse(any(item["type"] == "blocked-network" for item in evidence))
            self.assertTrue(list(fixture.home.rglob("*.jsonl*")))


if __name__ == "__main__":
    unittest.main()

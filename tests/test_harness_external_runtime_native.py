"""显式启用的真实 npm CLI 兼容检查；模型与用户目录均使用隔离夹具。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from src.backend.deepseek_harness_sdk import create_client
from tests.fixtures.harness_images import ImageWorkspace, LocalImageModel, image_block
from tests import test_harness_image_turn as image_checks
from tests.test_harness_image_native_contract import image_sources


@unittest.skipUnless(os.environ.get("AWU_TEST_DSH_NPM_ROOT") and os.environ.get("AWU_TEST_DSH_NODE"),
                     "External npm Harness check is opt-in")
class ExternalHarnessNativeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.install = Path(os.environ["AWU_TEST_DSH_NPM_ROOT"]).resolve(strict=True)
        self.node = Path(os.environ["AWU_TEST_DSH_NODE"]).resolve(strict=True)
        self.package = self.install / "node_modules/@deepseek-ai/dsh"
        metadata = json.loads((self.package / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["version"], "0.2.1-rc.3")
        self.assertEqual(metadata["bin"]["dsh"], "lib/bin.js")
        self.assertEqual(subprocess.check_output([str(self.node), "--version"], text=True).strip(), "v24.10.0")
        self.stderr: list[str] = []

        def external_client(**kwargs):
            config = kwargs["config"]
            config.dsh_bin = str(self.package / "lib/bin.js")
            config.env = {**(config.env or {}), "PATH": str(self.node.parent) + os.pathsep + os.environ.get("PATH", "")}
            client = create_client(**kwargs)
            # 仅用于隔离假模型检查，生产实现仍不保留未经脱敏的原始 stderr。
            def read_diagnostics():
                while client._proc and client._proc.stderr:
                    line = client._proc.stderr.readline(4096)
                    if not line:
                        break
                    if sum(map(len, self.stderr)) < 16000:
                        self.stderr.append(line)
            client._stderr_loop = read_diagnostics
            return client

        shim = patch("tests.test_harness_image_turn.create_client", external_client)
        shim.start()
        self.addCleanup(shim.stop)
        self.checks = image_checks.HarnessImageTurnTests()

    def run_case(self, action) -> None:
        try:
            asyncio.run(action())
        except Exception as exc:
            # 本测试仅使用假凭据/合成图片；只输出必要的启动错误类别。
            markers = ("Error", "not found", "not ready", "Cannot", "unsupported", "missing", "failed")
            detail = "".join(line for line in self.stderr if any(word in line for word in markers))[:2500]
            raise AssertionError(f"External npm compatibility failed: {type(exc).__name__}; {detail}") from exc

    def test_text_initialization_and_native_resume(self) -> None:
        async def check():
            with ImageWorkspace() as workspace, LocalImageModel() as model:
                first, deltas, _ = await self.checks.send(workspace, model, [], content="first local input")
                self.assertTrue(first.get("success"), [item.to_dict() for item in deltas])
                second, deltas, _ = await self.checks.send(workspace, model, [], content="second local input",
                                                         native=first["agentSessionId"])
                self.assertTrue(second.get("success"), [item.to_dict() for item in deltas])
                self.assertEqual(second["agentSessionId"], first["agentSessionId"])
                self.assertEqual(len(model.posts), 2)
                self.assertIn("first local input", json.dumps(model.posts[1]))
                self.assertEqual(model.errors, [])
        self.run_case(check)

    def test_image_admission_resume_and_no_remote_delete(self) -> None:
        async def check():
            with ImageWorkspace() as workspace, LocalImageModel(files_mode="quota") as model:
                first, deltas, _ = await self.checks.send(workspace, model, [image_block()], content="synthetic image")
                self.assertTrue(first.get("success"), [item.to_dict() for item in deltas])
                second, deltas, _ = await self.checks.send(workspace, model, [], content="resume image history",
                                                         native=first["agentSessionId"])
                self.assertTrue(second.get("success"), [item.to_dict() for item in deltas])
                self.assertEqual([len(image_sources(post)) for post in model.posts], [1, 1])
                self.assertEqual(model.deleted, [])
                self.assertFalse(any(method == "DELETE" for method, _ in model.paths))
                self.assertEqual(model.errors, [])
        self.run_case(check)


if __name__ == "__main__":
    unittest.main()

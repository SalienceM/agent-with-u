"""准入/传输行为红线；使用正式生成桥验证，不等于 Python 入口已启用图片。"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import time
import unittest

from tests.fixtures.harness_images import ImageWorkspace, LocalImageModel, image_block, run_prompt
from tests.test_harness_image_admission import admit_images, ExtensionReply

BRIDGE = Path(__file__).resolve().parents[1] / "build/deepseek-harness/bridge/lib/index.mjs"


class CheckedFixtureTests(unittest.TestCase):
    def workspace(self) -> ImageWorkspace:
        workspace = ImageWorkspace()
        # unittest 的 expectedFailure 只包围用例主体，不包围 cleanup；
        # 所以原生清理失败绝不能被当作预期的能力/帧缺口隐藏。
        def assert_cleanup() -> None:
            self.assertTrue(all(owner.confirmed for owner in workspace.owners), "Owned cleanup failed")
            self.assertFalse(workspace.root.exists(), "Fixture workspace cleanup failed")
        self.addCleanup(assert_cleanup)
        return workspace


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
class HarnessImageAdmissionBaselines(CheckedFixtureTests):
    def test_no_directory_evidence_rejects_before_model_post(self) -> None:
        with self.workspace() as workspace, LocalImageModel(catalog_status=404) as model:
            with workspace.client(model, bridge=BRIDGE) as client:
                self.assertFalse(admit_images(client, [image_block()])["admitted"])
                result = client.request("session/prompt", {"sessionId": "image-fixture", "contentBlocks": [image_block()]},
                                        response_model=ExtensionReply).model_dump()
                self.assertEqual(result["boundary"], "before-native-handler")
            self.assertEqual(len(model.posts), 0, "Missing endpoint evidence must fail closed")

    def test_changed_route_rejects_before_model_post(self) -> None:
        with self.workspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=BRIDGE, probe="route-change") as client:
                blocks = [image_block()]
                admitted = admit_images(client, blocks)
                run_prompt(client, blocks, admission=admitted["admissionId"])
            self.assertEqual(len(model.posts), 0, "Changed route must not project images to text")

    def test_restored_historical_image_rejects_text_route(self) -> None:
        with self.workspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=BRIDGE) as client:
                blocks = [image_block()]
                admitted = admit_images(client, blocks)
                run_prompt(client, blocks, admission=admitted["admissionId"])
            with workspace.client(model, bridge=BRIDGE, route="unlisted-model") as client:
                client.resume_session("image-fixture")
                run_prompt(client, [{"type": "text", "text": "new text, old image"}])
            self.assertEqual(len(model.posts), 1, "Historical image must remain guarded on text-only follow-up")


class HarnessImageFrameBaselines(CheckedFixtureTests):
    def _exercise(self, scenario: str, check: object) -> None:
        from src.backend.deepseek_harness_sdk import SyncOwner, create_client, create_harness_config
        with self.workspace() as workspace:
            owner = SyncOwner(generation="frame-baseline", receipt=workspace.root / "exit.json")
            workspace.owners.append(owner)
            client = create_client(config=create_harness_config(cwd=str(workspace.project), dsh_home=str(workspace.home),
                initialize_timeout_seconds=3, request_timeout_seconds=2), owner=owner,
                launch_args=(sys.executable, "-u", str(Path(__file__).parent / "fixtures/deepseek_harness_runtime.py"),
                    "--state", str(workspace.root / "state.json"), "--scenario", scenario))
            try:
                client.start()
                client.initialize(cwd=str(workspace.project), provider="fixture", model="fixture")
                check(client)
            finally:
                client.close()

    def test_valid_two_mib_frame_is_supported(self) -> None:
        def check(client: object) -> None:
            note = client.next_owned_notification(timeout=3)
            self.assertEqual(len(note.payload["value"]), 2 * 1024 * 1024)
        self._exercise("large-frame", check)

    def test_unterminated_overlong_frame_fails_and_owned_tree_exits(self) -> None:
        def check(client: object) -> None:
            deadline = time.monotonic() + 4
            while not client.fatal and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIsNotNone(client.fatal)
        self._exercise("unterminated", check)


if __name__ == "__main__":
    unittest.main()

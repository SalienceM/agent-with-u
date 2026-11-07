"""实际配套分发桥的扩展契约：已核对 manifest 的生成资源 + 原生运行时 + loopback。"""
from __future__ import annotations

import os
import json
import unittest

from pydantic import BaseModel, ConfigDict

from src.backend.deepseek_harness_config import COMMIT, RUNTIME_VERSION
from src.backend.deepseek_harness_distribution import verify_bundle, verify_image_bridge
from src.backend.deepseek_harness_image_contract import image_resource_contract
from src.backend.deepseek_harness_images import LIMITS, admission_request, validate_images_sync
from tests.fixtures.harness_images import ImageWorkspace, LocalImageModel, image_block, run_prompt
from tests.test_harness_image_native_contract import terminal_reasons


class ExtensionReply(BaseModel):
    model_config = ConfigDict(extra="allow")


def admit_images(client, blocks: list[dict], *, model: str = "deepseek-flash") -> dict:
    cap = client.request("awu/capabilities", {}, response_model=ExtensionReply).model_dump()
    identity = {key: cap[key] for key in ("sessionId", "generation", "configFingerprint")}
    identity.update(ownerId="fixture-owner", executorId="fixture-executor", awuSessionId="fixture-awu-session",
                    backendId="fixture-backend", provider="deepseek-official", model=model)
    images = validate_images_sync([{"base64": block["data"], "mime_type": block["mimeType"]}
                                  for block in blocks if block.get("type") == "image"])
    return client.request("awu/imageAdmission", admission_request(cap, identity, images), response_model=ExtensionReply).model_dump()


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
class HarnessImageAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        resources = verify_bundle(require_images=True)
        cls.bridge = resources["deepseek-harness/bridge/lib/index.mjs"]

    def test_actual_bridge_negotiates_separately_and_refuses_image_before_handler(self) -> None:
        bridge = self.bridge
        self.assertTrue(bridge.is_file(), "Build and verify paired image bridge before this opt-in test")
        self.assertEqual(verify_image_bridge(bridge), image_resource_contract())
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=bridge) as client:
                cap = client.request("awu/capabilities", {}, response_model=ExtensionReply).model_dump()
                self.assertEqual(cap["protocolVersion"], 1)
                self.assertEqual(cap["imageAdmission"]["version"], 1)
                request = {key: cap[key] for key in ("sessionId", "generation", "configFingerprint")}
                request.update(ownerId="fixture-owner", executorId="fixture-executor", awuSessionId="fixture-awu-session",
                    backendId="fixture-backend", provider="deepseek-official", model="deepseek-flash",
                    version=1, bridgeVersion=1, runtimeVersion=RUNTIME_VERSION, sourceCommit=COMMIT,
                    limits=LIMITS, imageDigest="a" * 64)
                self.assertEqual(cap["imageAdmission"]["limits"], LIMITS)
                result = client.request("awu/imageAdmission", request, response_model=ExtensionReply).model_dump()
                self.assertTrue(result["admitted"])
                self.assertEqual(result["reason"], "route_declares_image")
                self.assertEqual(result["capability"], "supported")
                result = client.request("session/prompt", {"sessionId": "image-fixture", "contentBlocks": [image_block()]},
                    response_model=ExtensionReply).model_dump()
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["boundary"], "before-native-handler")
                self.assertEqual(model.paths, [("GET", "/models")])
                self.assertEqual(list((workspace.home / "sessions").rglob("*.jsonl*")), [])
            # 能力查询不授予降级资格。另一个未请求图片准入的 worker 保持核心文字兼容。
            with workspace.client(model, bridge=bridge) as client:
                self.assertEqual(terminal_reasons(run_prompt(client, [{"type": "text", "text": "legacy text remains usable"}])), ["completed"])
            self.assertEqual(len(model.posts), 1)
            self.assertTrue(all(owner.confirmed for owner in workspace.owners))

    def test_actual_bridge_round_trips_valid_two_mib_text_with_one_native_reader(self) -> None:
        bridge = self.bridge
        self.assertTrue(bridge.is_file())
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            text = "字" * (700 * 1024)
            with workspace.client(model, bridge=bridge) as client:
                notes = run_prompt(client, [{"type": "text", "text": text}])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(len(model.posts), 1)
            self.assertIn(text, str(model.posts[0]))

    def test_actual_bridge_rejects_invalid_stream_and_confirms_owned_exit(self) -> None:
        bridge = self.bridge
        self.assertTrue(bridge.is_file())
        for sample in (b"x" * (LIMITS["maxFrameBytes"] + 1), b"\xff\n", b'{"id":1'):
            with self.subTest(size=len(sample)), ImageWorkspace() as workspace, LocalImageModel() as model:
                with workspace.client(model, bridge=bridge) as client:
                    # 故意绕过 Python 的发送校验，仅注入隔离 worker 的协议故障。
                    process = client._proc
                    try:
                        process.stdin.buffer.write(sample)
                        process.stdin.buffer.flush()
                        process.stdin.close()
                    except (BrokenPipeError, OSError):
                        pass  # Node 可在完整写完非法输入前主动退出。
                    self.assertNotEqual(process.wait(timeout=5), 0)
                self.assertEqual(model.paths, [])
                self.assertTrue(all(owner.confirmed for owner in workspace.owners))

    def test_actual_bridge_submits_once_with_native_prepared_handle_and_delete_guard(self) -> None:
        from tests.test_harness_image_native_contract import image_sources, evidence
        bridge = self.bridge
        for files, quota in (("success", "quota_exceeded"), ("quota", "quota_exceeded"),
                             ("quota", "storage_limit_exceeded"), ("missing", "not_found"), ("error", "ordinary_error")):
            with self.subTest(files=files, quota=quota), ImageWorkspace() as workspace, LocalImageModel(files_mode=files, quota_detail=quota) as model:
                blocks = [{"type": "text", "text": "two synthetic pictures"}, image_block(), image_block("WEBP")]
                with workspace.client(model, bridge=bridge) as client:
                    admitted = admit_images(client, blocks)
                    self.assertTrue(admitted["admitted"], admitted["reason"])
                    self.assertEqual(terminal_reasons(run_prompt(client, blocks, admission=admitted["admissionId"])), ["completed"])
                    repeated = client.request("session/prompt", {"sessionId": "image-fixture", "contentBlocks": blocks,
                        "awuImageAdmission": {"admissionId": admitted["admissionId"]}}, response_model=ExtensionReply).model_dump()
                    self.assertEqual(repeated["boundary"], "before-native-handler")
                self.assertEqual(len(model.posts), 1)
                self.assertEqual(len(image_sources(model.posts[0])), 2)
                self.assertEqual(model.deleted, [])
                self.assertEqual(model.errors, [])
                self.assertEqual(sum(row["type"] == "middleware" for row in evidence(workspace)), 1)

    def test_actual_bridge_digest_tamper_refuses_before_native_session(self) -> None:
        bridge = self.bridge
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=bridge) as client:
                admitted = admit_images(client, [image_block()])
                result = client.request("session/prompt", {"sessionId": "image-fixture",
                    "contentBlocks": [image_block(color=(0, 0, 0))],
                    "awuImageAdmission": {"admissionId": admitted["admissionId"]}}, response_model=ExtensionReply).model_dump()
                self.assertEqual(result["reason"], "digest_mismatch")
                self.assertEqual(result["boundary"], "before-native-handler")
                self.assertEqual(list((workspace.home / "sessions").rglob("*.jsonl*")), [])
            self.assertEqual(model.paths, [("GET", "/models")])

    def test_actual_bridge_refuses_changed_and_historical_text_routes_without_model_post(self) -> None:
        bridge = self.bridge
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=bridge, probe="route-change") as client:
                blocks = [image_block()]
                admitted = admit_images(client, blocks)
                self.assertEqual(terminal_reasons(run_prompt(client, blocks, admission=admitted["admissionId"])), ["error"])
            self.assertEqual(model.posts, [])
            with workspace.client(model, bridge=bridge, route="unlisted-model") as client:
                client.resume_session("image-fixture")
                notes = run_prompt(client, [{"type": "text", "text": "new text, historical image"}])
                self.assertEqual(terminal_reasons(notes), ["error"])
            self.assertEqual(model.posts, [])

    def test_actual_bridge_upload_record_does_not_authorize_delete_on_resume(self) -> None:
        from tests.test_harness_image_native_contract import image_sources
        bridge = self.bridge
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            with workspace.client(model, bridge=bridge) as client:
                blocks = [image_block()]
                admitted = admit_images(client, blocks)
                self.assertEqual(terminal_reasons(run_prompt(client, blocks, admission=admitted["admissionId"])), ["completed"])
            model.files_quota = True
            model.quota_foreign = False
            with workspace.client(model, bridge=bridge) as client:
                client.resume_session("image-fixture")
                blocks = [image_block(color=(10, 50, 100))]
                admitted = admit_images(client, blocks)
                self.assertEqual(terminal_reasons(run_prompt(client, blocks, admission=admitted["admissionId"])), ["completed"])
            self.assertEqual(len(model.posts), 2)
            self.assertEqual(len(image_sources(model.posts[-1])), 2)
            with workspace.client(model, bridge=bridge) as client:
                client.resume_session("image-fixture")
                self.assertEqual(terminal_reasons(run_prompt(client, [{"type": "text", "text": "only new text"}])), ["completed"])
            self.assertEqual(len(model.posts), 3)
            self.assertEqual(len(image_sources(model.posts[-1])), 2)
            self.assertEqual(len(model.uploads), 1)
            self.assertEqual(model.deleted, [])
            self.assertEqual(model.errors, [])

    def test_actual_bridge_failure_or_stop_after_upload_never_deletes(self) -> None:
        bridge = self.bridge
        for mode in ("model-error", "shutdown", "owned-stop"):
            with self.subTest(mode=mode), ImageWorkspace() as workspace, LocalImageModel(files_mode="success",
                    message_status=400 if mode == "model-error" else 200, hold_messages=mode != "model-error") as model:
                with workspace.client(model, bridge=bridge) as client:
                    blocks = [image_block()]
                    admitted = admit_images(client, blocks)
                    if mode == "model-error":
                        self.assertEqual(terminal_reasons(run_prompt(client, blocks, admission=admitted["admissionId"])), ["error"])
                    else:
                        receipt = client.request("session/prompt", {"sessionId": "image-fixture", "contentBlocks": blocks,
                            "awuImageAdmission": {"admissionId": admitted["admissionId"]}}, response_model=ExtensionReply).model_dump()
                        self.assertTrue(receipt["messageId"])
                        self.assertTrue(model.message_received.wait(timeout=10))
                        if mode == "owned-stop":
                            workspace.owners[-1].terminate()
                        client.close()
                        self.assertTrue(workspace.owners[-1].confirmed)
                self.assertEqual(len(model.uploads), 1)
                self.assertEqual(len(model.posts), 1)
                self.assertEqual(model.deleted, [])
                self.assertEqual(model.errors, [])
                self.assertTrue(list((workspace.home / "sessions").rglob("*.jsonl*")))

    def test_actual_bridge_offload_request_fails_without_silent_image_removal(self) -> None:
        bridge = self.bridge
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=bridge,
                    provider_options={"maxImagesPerRequest": 1, "imageOffloadCountQuantum": 1}) as client:
                blocks = [image_block(), image_block(color=(10, 50, 100))]
                admitted = admit_images(client, blocks)
                notes = run_prompt(client, blocks, admission=admitted["admissionId"])
                self.assertEqual(terminal_reasons(notes), ["error"])
                end = next(note.payload["event"] for note in notes if note.payload.get("event", {}).get("type") == "turn/end")
                self.assertIn("image_offload_forbidden", str(end))
            self.assertEqual(model.posts, [])
            self.assertEqual(model.uploads, {})
            self.assertEqual(model.deleted, [])

    def test_actual_bridge_unavailable_transport_guard_never_admits(self) -> None:
        bridge = self.bridge
        for egress in ("guarded", "revoked"):
            with self.subTest(egress=egress), ImageWorkspace() as workspace, LocalImageModel() as model:
                with workspace.client(model, bridge=bridge, egress=egress) as client:
                    admission = admit_images(client, [image_block()])
                    self.assertFalse(admission["admitted"])
                    self.assertEqual(admission["reason"], "safety_guard_unavailable")
                self.assertEqual(model.paths, [])

    def test_actual_bridge_supported_route_revoked_after_receipt_cannot_submit(self) -> None:
        bridge = self.bridge
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, bridge=bridge, probe="invalidate-route") as client:
                blocks = [image_block()]
                admission = admit_images(client, blocks)
                self.assertTrue(admission["admitted"])
                notes = run_prompt(client, blocks, admission=admission["admissionId"])
                self.assertEqual(terminal_reasons(notes), ["error"])
                self.assertIn('"attachmentId"', json.dumps([note.payload for note in notes]))
            self.assertEqual(model.paths, [("GET", "/models")])
            self.assertEqual(model.deleted, [])


if __name__ == "__main__":
    unittest.main()

"""锁定 rc.3 原生契约；只走现有单 SDK transport + 原生 provider。"""
from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import unittest

from PIL import Image

from tests.fixtures.harness_images import RawNativeImageWorkspace as ImageWorkspace
from tests.fixtures.harness_images import LocalImageModel, image_block, model_catalog, run_prompt


def evidence(workspace: ImageWorkspace) -> list[dict]:
    return [json.loads(line) for line in (workspace.root / "probe.jsonl").read_text().splitlines()]


def image_sources(body: dict) -> list[dict]:
    return [block["source"] for message in body["messages"] for block in message["content"] if block["type"] == "image"]


def terminal_reasons(notes: list) -> list[str]:
    return [note.payload["event"]["data"]["reason"]["kind"] for note in notes
            if note.payload.get("event", {}).get("type") == "turn/end"]


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
class HarnessImageNativeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.installed_files: dict[Path, str] = {}
        for package in ("deepseek-harness-sdk", "deepseek-harness-runtime-bin"):
            self.assertEqual(importlib.metadata.version(package), "0.2.1rc3")
            distribution = importlib.metadata.distribution(package)
            for entry in distribution.files or []:
                path = Path(distribution.locate_file(entry))
                if path.suffix in {".py", ".mjs", ".js", ".json", ".exe"} and path.is_file():
                    self.installed_files[path] = hashlib.sha256(path.read_bytes()).hexdigest()

    def tearDown(self) -> None:
        for path, original in self.installed_files.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), original, "Installed runtime/SDK was modified")

    def test_native_connection_identity_uses_loaded_resolvers(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, probe="identity") as client:
                notes = run_prompt(client, [{"type": "text", "text": "identity contract"}])
            events = evidence(workspace)
            self.assertEqual([row for row in events if row["type"].startswith("identity")], [
                {"type": "identity", "endpointMatches": True, "listingMatches": True, "source": "process", "stable": True}])
            self.assertEqual(terminal_reasons(notes), ["completed"])

    def test_native_connection_config_overrides_launch_environment(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel() as model, LocalImageModel() as unused:
            with workspace.client(model, probe="identity", provider_options={"baseURL": model.url},
                                  environment_url=unused.url) as client:
                notes = run_prompt(client, [{"type": "text", "text": "configuration priority"}])
            self.assertEqual([row for row in evidence(workspace) if row["type"].startswith("identity")], [
                {"type": "identity", "endpointMatches": True, "listingMatches": True, "source": "native-config", "stable": True}])
            self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(len(model.posts), 1)
            self.assertEqual(unused.paths, [])

    def test_native_catalog_requires_explicit_endpoint_and_native_evidence(self) -> None:
        base = model_catalog()["data"][0]
        cases = [
            ("supported", [base], None, 200, "supported", "route_declares_image"),
            ("text", [{**base, "input_modalities": ["text"]}], None, 200, "unsupported", "endpoint_text_only"),
            ("missing", [{key: value for key, value in base.items() if key != "input_modalities"}], None, 200, "unknown", "catalog_incomplete"),
            ("missing-messages", [{**base, "api_capabilities": {"anthropic_messages": True}}], None, 200, "unknown", "catalog_incomplete"),
            ("unlisted", [{**base, "id": "other-model"}], None, 200, "unknown", "model_unlisted"),
            ("duplicate", [base, base], None, 200, "unknown", "catalog_ambiguous"),
            ("unavailable", [base], None, 404, "unknown", "catalog_unavailable"),
            ("native-text", [base], {"models": [{"id": "deepseek-flash", "inputModalities": ["text"]}]},
             200, "unsupported", "runtime_text_only"),
            ("version", [{**base, "client_requirements": {"deepseek-harness": {"min_version": "99.0.0"}}}],
             None, 200, "unsupported", "runtime_version_required"),
            ("bad-version", [{**base, "client_requirements": {"deepseek-harness": {"min_version": "not-semver"}}}],
             None, 200, "unknown", "catalog_invalid"),
        ]
        for name, rows, options, status, capability, reason in cases:
            with self.subTest(case=name), ImageWorkspace() as workspace, LocalImageModel(catalog={"data": rows}, catalog_status=status) as model:
                with workspace.client(model, probe="catalog", provider_options=options) as client:
                    notes = run_prompt(client, [{"type": "text", "text": "catalog contract only"}])
                observations = [row for row in evidence(workspace) if row["type"] == "catalog"]
                self.assertEqual(len(observations), 1)
                self.assertEqual((observations[0]["capability"], observations[0]["reason"]), (capability, reason))
                self.assertTrue(observations[0]["coalesced"])
                self.assertEqual(model.paths, [("GET", "/models")])
                self.assertEqual(model.posts, [])
                self.assertEqual(terminal_reasons(notes), ["error"], "Fixture must stop after metadata, never probe inference")

    def test_native_images_become_durable_refs_resume_and_dispatch_prepared_once(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            blocks = [{"type": "text", "text": "two synthetic pictures"},
                      image_block("PNG", color=(210, 40, 30)), image_block("WEBP", color=(30, 60, 210))]
            with workspace.client(model, probe="prepared") as client:
                notes = run_prompt(client, blocks)
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(len(model.posts), 1, "One native turn must have exactly one Messages POST")
            sources = image_sources(model.posts[0])
            self.assertEqual(len(sources), 2)
            for source, expected in zip(sources, ((210, 40, 30), (30, 60, 210))):
                self.assertEqual(source["type"], "base64")
                with Image.open(io.BytesIO(base64.b64decode(source["data"], validate=True))) as image:
                    image.load()
                    self.assertEqual(image.size, (32, 24))
                    # 原生允许 JPEG 等受控转码，比较像素而非宣称原始 hash 相同。
                    pixel = image.convert("RGB").getpixel((16, 12))
                    self.assertTrue(all(abs(a - b) <= 5 for a, b in zip(pixel, expected)))
            logs = list((workspace.home / "sessions").rglob("*.jsonl*"))
            self.assertEqual(len(logs), 1)
            # 原生日志可能是 .jsonl.zst；从原生 committed 事件核对持久协议形状，
            # 再用下一进程的真实 resume 验证磁盘历史，而不依赖压缩文件格式。
            original = json.dumps([note.payload for note in notes if note.method == "session.event"])
            self.assertIn('"attachmentId"', original)
            self.assertNotIn(blocks[1]["data"], original)
            with workspace.client(model, probe="prepared") as client:
                client.resume_session("image-fixture")
                notes = run_prompt(client, [{"type": "text", "text": "new input only"}])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(len(model.posts), 2)
            self.assertEqual(len(image_sources(model.posts[1])), 2)
            events = evidence(workspace)
            for kind in ("stream", "prepared", "prepared-reentry", "middleware", "reuse-rejected"):
                self.assertEqual(sum(item["type"] == kind for item in events), 2, kind)
            self.assertTrue(all(item["frozen"] for item in events if item["type"] == "prepared"))
            self.assertEqual(model.errors, [])

    def test_missing_directory_is_not_proven_by_builtin_image_metadata(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(catalog_status=404) as model:
            with workspace.client(model, probe="prepared") as client:
                notes = run_prompt(client, [image_block()])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            infos = [item for item in evidence(workspace) if item["type"] == "metadata"]
            self.assertEqual(infos[0]["modalities"], ["text", "image"])
            # rc.3 自定义 origin 未读 /models，内置名称的 image 声明不能证明目录来源。
            self.assertFalse(any(method == "GET" for method, _path in model.paths))
            self.assertEqual(len(image_sources(model.posts[0])), 1)

    def test_text_only_projection_and_request_scoped_guard_before_provider(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            with workspace.client(model, route="unlisted-model") as client:
                notes = run_prompt(client, [image_block()])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(image_sources(model.posts[0]), [])
            infos = [item for item in evidence(workspace) if item["type"] == "metadata"]
            self.assertEqual(infos[0]["modalities"], ["text"])
            self.assertTrue(any(item["images"] == 1 for item in evidence(workspace) if item["type"] == "stream"))
            with workspace.client(model, route="unlisted-model", probe="prepared") as client:
                client.resume_session("image-fixture")
                notes = run_prompt(client, [{"type": "text", "text": "history still contains an image"}])
                self.assertEqual(terminal_reasons(notes), ["error"])
            self.assertEqual(len(model.posts), 1, "Guard must prevent provider submission of projected historical images")
            self.assertTrue(any(item["type"] == "rejected-text-route" for item in evidence(workspace)))

    def test_native_quota_recovery_deletes_prefix_file_not_owned_by_this_session(self) -> None:
        """设计阻塞证据：检查原生副作用，不把这项删除行为作为产品可接受的成功。"""
        with ImageWorkspace() as workspace, LocalImageModel(files_quota=True) as model:
            self.assertEqual(list(workspace.home.iterdir()), [])
            with workspace.client(model, probe="prepared") as client:
                notes = run_prompt(client, [image_block()])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(model.deleted, ["fixture-other-session"])
            self.assertNotIn("fixture-user-file", model.deleted)
            self.assertEqual(sum(method == "POST" and path == "/v1/files" for method, path in model.paths), 2)
            self.assertEqual(len(model.posts), 1)
            self.assertEqual(len(image_sources(model.posts[0])), 1)
            self.assertEqual(model.errors, [])

    def test_egress_guard_normal_upload_and_durable_file_reference_resume(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            with workspace.client(model, probe="prepared", egress="guarded") as client:
                notes = run_prompt(client, [image_block()])
                self.assertEqual(terminal_reasons(notes), ["completed"])
            self.assertEqual(len(model.posts), 1)
            sources = image_sources(model.posts[0])
            self.assertEqual(len(sources), 1)
            self.assertEqual(sources[0]["type"], "file")
            self.assertIn(sources[0]["file_id"], model.uploads)
            with Image.open(io.BytesIO(model.uploads[sources[0]["file_id"]])) as image:
                image.load()
                self.assertEqual(image.size, (32, 24))
            with workspace.client(model, probe="prepared", egress="guarded") as client:
                client.resume_session("image-fixture")
                self.assertEqual(terminal_reasons(run_prompt(client, [{"type": "text", "text": "resume only"}])), ["completed"])
            self.assertEqual(len(model.posts), 2)
            self.assertEqual(image_sources(model.posts[1]), sources)
            self.assertEqual(len(model.uploads), 1, "Native durable upload index is reused")
            self.assertEqual(model.deleted, [])
            self.assertEqual(model.errors, [])
            self.assertTrue(all(row["activeCalls"] == 0 for row in evidence(workspace) if row["type"] == "egress"))

    def test_egress_guard_quota_storage_and_plain_errors_keep_inline_images_without_delete(self) -> None:
        for mode, detail in (("quota", "quota_exceeded"), ("quota", "storage_limit_exceeded"),
                             ("error", "ordinary_error"), ("missing", "not_found")):
            with self.subTest(mode=mode, detail=detail), ImageWorkspace() as workspace, LocalImageModel(
                    files_mode=mode, quota_detail=detail) as model:
                self.assertEqual(list(workspace.home.iterdir()), [])
                with workspace.client(model, probe="prepared", egress="guarded") as client:
                    self.assertEqual(terminal_reasons(run_prompt(client, [image_block()])), ["completed"])
                self.assertEqual(model.deleted, [])
                self.assertFalse(any(method == "DELETE" for method, _ in model.paths))
                self.assertEqual(len(model.posts), 1)
                sources = image_sources(model.posts[0])
                self.assertEqual(len(sources), 1)
                self.assertEqual(sources[0]["type"], "base64")
                self.assertTrue(base64.b64decode(sources[0]["data"], validate=True))
                self.assertEqual(sum(method == "POST" and path == "/v1/files" for method, path in model.paths), 1)
                guarded = [row for row in evidence(workspace) if row["type"] == "egress"]
                self.assertEqual(len(guarded), 1)
                self.assertEqual(guarded[0]["blockedDeletes"], int(mode == "quota"))
                self.assertEqual(model.errors, [])

    def test_egress_guard_does_not_authorize_deleting_own_uploaded_file_on_resume(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            with workspace.client(model, probe="prepared", egress="guarded") as client:
                self.assertEqual(terminal_reasons(run_prompt(client, [image_block()])), ["completed"])
            self.assertEqual(len(model.uploads), 1)
            model.files_quota = True
            model.quota_foreign = False  # 此次列表只含已由本 Session 上传并落盘的原生引用。
            with workspace.client(model, probe="prepared", egress="guarded") as client:
                client.resume_session("image-fixture")
                self.assertEqual(terminal_reasons(run_prompt(client, [image_block(color=(20, 50, 100))])), ["completed"])
            self.assertEqual(len(model.posts), 2)
            self.assertEqual(len(image_sources(model.posts[1])), 2)
            self.assertTrue(all(row["type"] == "base64" for row in image_sources(model.posts[1])))
            self.assertEqual(len(model.uploads), 1)
            self.assertEqual(model.deleted, [])
            self.assertEqual([row["blockedDeletes"] for row in evidence(workspace) if row["type"] == "egress"], [0, 1])
            self.assertEqual(model.errors, [])

    def test_egress_guard_absent_or_revoked_fails_before_files_or_model_submission(self) -> None:
        for state in ("missing", "revoked"):
            with self.subTest(state=state), ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
                with workspace.client(model, probe="prepared", egress=state) as client:
                    notes = run_prompt(client, [image_block()])
                    self.assertEqual(terminal_reasons(notes), ["error"])
                self.assertEqual(model.paths, [])
                self.assertEqual(model.posts, [])
                self.assertEqual(model.deleted, [])
                self.assertIn('"attachmentId"', json.dumps([note.payload for note in notes]))
                self.assertTrue(list((workspace.home / "sessions").rglob("*.jsonl*")))

    def test_egress_guard_model_failure_after_upload_retains_remote_file(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success", message_status=400) as model:
            with workspace.client(model, probe="prepared", egress="guarded") as client:
                notes = run_prompt(client, [image_block()])
                self.assertEqual(terminal_reasons(notes), ["error"])
            self.assertEqual(len(model.uploads), 1)
            self.assertEqual(len(model.posts), 1)
            self.assertEqual(model.deleted, [])
            self.assertEqual(model.errors, [])

    def test_egress_guard_stop_after_upload_never_compensates_with_delete(self) -> None:
        for termination in ("shutdown", "owned-stop"):
            with self.subTest(termination=termination), ImageWorkspace() as workspace, LocalImageModel(
                    files_mode="success", hold_messages=True) as model:
                with workspace.client(model, probe="prepared", egress="guarded") as client:
                    receipt = client.session_prompt("image-fixture", [image_block()])
                    self.assertTrue(receipt)
                    self.assertTrue(model.message_received.wait(timeout=10), "Native request did not reach local fixture")
                    self.assertEqual(len(model.uploads), 1)
                    if termination == "owned-stop":
                        workspace.owners[-1].terminate()
                    client.close()
                    self.assertTrue(workspace.owners[-1].confirmed)
                self.assertEqual(len(model.posts), 1)
                self.assertEqual(model.deleted, [])
                self.assertFalse(any(method == "DELETE" for method, _ in model.paths))
                self.assertEqual(model.errors, [])
                self.assertTrue(list((workspace.home / "sessions").rglob("*.jsonl*")))


if __name__ == "__main__":
    unittest.main()

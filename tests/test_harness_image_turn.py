"""真实 Backend → owned SDK → 正式配套桥 → loopback；不使用生产模型。"""
from __future__ import annotations

import asyncio
import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
from typing import Any
import unittest
import uuid
from unittest.mock import patch

from PIL import Image

from src.backend.deepseek_harness import DeepSeekHarnessBackend
from src.backend.deepseek_harness_sdk import create_client, bridge_path
from src.backend.deepseek_harness_state import HarnessLayout, make_profile_patch
from src.types import BackendType, ModelBackendConfig
from tests.fixtures.harness_images import FIXTURE_KEY, ImageWorkspace, LocalImageModel, image_block, model_catalog
from tests.fixtures.deepseek_harness_http import LocalModel
from tests.test_harness_image_native_contract import image_sources


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
class HarnessImageTurnTests(unittest.IsolatedAsyncioTestCase):
    async def send(self, workspace: ImageWorkspace, model: LocalImageModel | LocalModel, blocks: list[dict], *,
                   content: str = "", native: str | None = None, session: str = "image-turn",
                   egress: str = "", tamper: bool = False, backend_ready: Any = None,
                   client_ready: Any = None, lose_receipt: bool = False, **options: Any) -> tuple[dict, list, list]:
        backend = DeepSeekHarnessBackend(ModelBackendConfig(id="image-turn-backend", label="fixture",
            type=BackendType.DEEPSEEK_HARNESS, model="deepseek-flash", api_key=FIXTURE_KEY,
            base_url=model.url, allowed_tools=[], harness_permission_mode="read-only",
            env={"HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "127.0.0.1"}))
        calls, deltas = [], []
        trace = options.pop("test_trace", None)
        raw_request_error = options.pop("test_raw_request_error", "")
        if backend_ready:
            backend_ready(backend)

        def profile(**kwargs: Any) -> list[dict]:
            rows = make_profile_patch(**kwargs)
            rows.append({"insert": [{"id": "awu-image-contract-fixture", "name":
                (Path(__file__).parent / "fixtures/harness_image_probe.mjs").resolve().as_uri(),
                "inject": ["llm", "agents"], "config": {"origin": model.url,
                    "output": str(workspace.root / "probe.jsonl"), "mode": "observe", "egress": egress,
                    "identity": {"sessionId": kwargs["native_id"], "generation": kwargs["generation"],
                        "configFingerprint": kwargs["fingerprint"], "provider": "deepseek-official", "model": "deepseek-flash"}}}]})
            return rows

        def client(**kwargs: Any) -> Any:
            result = create_client(**kwargs)
            workspace.owners.append(kwargs["owner"])
            request = result.request
            def observe(method: str, params: Any = None, **request_options: Any) -> Any:
                # 请求仅在临时测试对象中用于断言；不输出／持久化图片或凭据。
                calls.append((method, params))
                if tamper and method == "session/prompt":
                    params = {**params, "awuImageAdmission": {"admissionId": "0" * 36}}
                response = request(method, params, **request_options)
                if raw_request_error and method == "session/prompt":
                    raise RuntimeError(raw_request_error)
                if lose_receipt and method == "session/prompt":
                    raise TimeoutError("fixture missing receipt")
                return response
            result.request = observe
            if client_ready:
                client_ready(backend)
            return result

        with patch("src.backend.deepseek_harness_turn.make_profile_patch", profile), \
                patch("src.backend.deepseek_harness_turn.create_client", client):
            from src.backend.call_trace import traced_send
            result = await traced_send(backend, dict(messages=[], content=content,
                images=[{"base64": block["data"], "mime_type": block["mimeType"]} for block in blocks] or None,
                session_id=session, message_id="fixture-message", on_delta=deltas.append, agent_session_id=native,
                working_dir=str(workspace.project), owner_id="image-owner", executor_id="image-executor", **options), trace)
        for worker in list(getattr(backend, "_harness_workers", {}).values()):
            settled = await asyncio.wait_for(asyncio.gather(asyncio.shield(worker.task), return_exceptions=True), timeout=12)
            if isinstance(settled[0], BaseException):
                self.assertFalse(result.get("success"), "worker 失败不能被成功结果吞掉")
            owner, client = worker.owner, worker.client
            tree = owner.tree
            cleanup_state = {
                "exit": owner.process.poll() if owner.process else None,
                "processExitConfirmed": owner._process_exit_confirmed,
                "jobHeld": bool(tree and tree.job),
                "treeComplete": tree.complete if tree else None,
                "heldHandles": len(tree.handles) if tree else 0,
                "readerAlive": bool(client and client._reader_thread and client._reader_thread.is_alive()),
                "stderrAlive": bool(client and client._stderr_thread and client._stderr_thread.is_alive()),
            }
            self.assertTrue(worker.confirmed,
                "真实 worker 退出必须确认，不能由预期失败吞掉；" + json.dumps(cleanup_state))
        self.assertTrue(all(owner.confirmed for owner in workspace.owners))
        return result, deltas, calls

    def layout(self, session: str = "image-turn") -> HarnessLayout:
        return HarnessLayout.for_session(owner="image-owner", executor="image-executor",
            backend="image-turn-backend", session=session)

    async def test_text_provider_404_is_visible_without_image_or_raw_response(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(
                message_status=404, error_message="PRIVATE_PROVIDER_BODY") as model:
            result, deltas, calls = await self.send(workspace, model, [], content="read the workspace")
            self.assertFalse(result["success"])
            self.assertIn("HTTP 404", result["error"])
            self.assertIn("Messages API", result["error"])
            self.assertNotIn("图片", result["error"])
            self.assertNotIn("PRIVATE_PROVIDER_BODY", json.dumps([d.to_dict() for d in deltas]))
            self.assertEqual(sum(method == "session/prompt" for method, _ in calls), 1)
            self.assertFalse(any(method == "awu/imageAdmission" for method, _ in calls))
            self.assertNotIn("done", [d.type for d in deltas])
            self.assertTrue(model.posts, "must exercise the real runtime and local Messages endpoint")

    async def test_text_file_read_still_executes_in_native_runtime(self) -> None:
        with ImageWorkspace() as workspace:
            target = workspace.project / "read-fixture.txt"
            target.write_text("AWU-NATIVE-READ-OK", encoding="utf-8")
            with LocalModel([("read", {"file_path": str(target)}), "read complete"]) as model:
                def enable_read(backend: DeepSeekHarnessBackend) -> None:
                    backend.config.allowed_tools = ["read"]
                result, deltas, calls = await self.send(workspace, model, [], content="read the fixture",
                                                       backend_ready=enable_read)
                self.assertTrue(result["success"], result.get("error"))
                results = [d.tool_call for d in deltas if d.type == "tool_result"]
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]["status"], "done")
                self.assertIn("AWU-NATIVE-READ-OK", results[0]["output"])
                self.assertIn("AWU-NATIVE-READ-OK", json.dumps(model.posts[-1]))
                self.assertEqual(sum(method == "session/prompt" for method, _ in calls), 1)

    async def test_provider_echo_and_wrapped_builtin_errors_never_escape_error_diagnostic_or_saved_trace(self) -> None:
        from src.backend.call_trace import CallTrace, read_trace
        block = image_block()
        marker = "PRIVATE_FIXTURE_KEY_NOT_REAL"
        leak = json.dumps({"request": {"contentBlocks": [block]}, "key": marker,
                           "url": "https://fixture.invalid/path?token=" + marker})
        for wrapped in (False, True):
            with self.subTest(wrapped=wrapped), ImageWorkspace() as workspace, LocalImageModel(
                    files_mode="success", message_status=400, error_message=leak) as model:
                trace = CallTrace("image-turn", "privacy-test")
                logs = io.StringIO()
                states = []
                with redirect_stdout(logs), redirect_stderr(logs):
                    result, deltas, _ = await self.send(workspace, model, [block], test_trace=trace,
                        test_raw_request_error=leak if wrapped else "",
                        on_submission=lambda state, **_: states.append(state))
                self.assertFalse(result["success"])
                self.assertEqual(states[-1], "unknown" if wrapped else "failed")
                stored_trace = read_trace("image-turn", "privacy-test")
                self.assertIsNotNone(stored_trace)
                outputs = json.dumps({"result": result, "deltas": [delta.to_dict() for delta in deltas],
                                      "trace": stored_trace, "logs": logs.getvalue()}, ensure_ascii=False)
                for private in (block["data"], marker, "fixture.invalid/path", "contentBlocks"):
                    self.assertFalse(private in outputs, "敏感测试内容不得出现在错误／诊断／trace／日志")
                self.assertEqual(model.deleted, [])
                metadata = self.layout().read_metadata(cwd=str(workspace.project), native_id=result["agentSessionId"])
                self.assertTrue(metadata["submitted"])
                self.assertTrue(metadata["imageInputs"])
                # 现有 profile patch 禁用原生遥测；无需读取任何真实用户配置。
                rows = make_profile_patch(native_id="fixture", generation="g", fingerprint="f",
                    bridge=bridge_path(), cwd=str(workspace.project), mode="read-only", skip_permissions=False)
                self.assertTrue(any(row.get("id") == "session-telemetry-otel" and row.get("disabled") is True for row in rows))

    async def test_durable_observer_tracks_native_boundaries_and_lost_receipt_is_unknown(self) -> None:
        from src.backend.chat_extras_store import ChatExtras, ChatExtrasStore
        from src.backend.harness_image_receipts import ImageSubmission, commit_record
        for case in ("success", "rejected", "failed", "lost"):
            with self.subTest(case=case), ImageWorkspace() as workspace, LocalImageModel(
                    files_mode="success", message_status=400 if case == "failed" else 200) as model:
                store = ChatExtrasStore()
                extras = ChatExtras(session_id="image-turn")
                record = ImageSubmission(request_id="request", digest="a" * 64, owner_id="image-owner",
                    executor_id="image-executor", session_id="image-turn", backend_id="image-turn-backend",
                    user_message_id="user", assistant_message_id="fixture-message", draft_revision=1)
                commit_record(extras, record, store.save)
                states = []
                def observer(state: str, *, reason: str, generation: str) -> None:
                    current = extras.harness_image_submissions["request"]
                    following = current.advance(state, reason=reason, generation=generation)
                    commit_record(extras, following, store.save, expected_revision=current.revision)
                    states.append(state)
                    if state == "submitting":
                        self.assertEqual(model.posts, [])
                        self.assertEqual(model.uploads, {})
                result, _deltas, calls = await self.send(workspace, model, [image_block()], on_submission=observer,
                    tamper=case == "rejected", lose_receipt=case == "lost")
                expected = {"success": ["submitting", "native_received", "succeeded"],
                            "rejected": ["submitting", "rejected"],
                            "failed": ["submitting", "native_received", "failed"],
                            "lost": ["submitting", "unknown"]}[case]
                self.assertEqual(states, expected)
                saved = store.load("image-turn").harness_image_submissions["request"]
                self.assertEqual(saved.state, expected[-1])
                self.assertEqual(result.get("success"), case == "success")
                self.assertEqual(sum(method == "session/prompt" for method, _ in calls), 1)
                self.assertEqual(model.deleted, [])
                if case == "lost":
                    meta = self.layout().read_metadata(cwd=str(workspace.project), native_id=result["agentSessionId"])
                    self.assertTrue(meta["submitted"])

    async def test_submitting_record_save_failure_never_calls_native_prompt(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            states = []
            def observer(state: str, **_metadata: Any) -> None:
                states.append(state)
                if state == "submitting":
                    raise OSError("fixture save failed")
            result, _deltas, calls = await self.send(workspace, model, [image_block()], on_submission=observer)
            self.assertFalse(result["success"])
            self.assertEqual(states, ["submitting"])
            self.assertFalse(any(method == "session/prompt" for method, _ in calls))
            self.assertEqual(model.posts, [])
            self.assertEqual(model.uploads, {})
            self.assertEqual(model.deleted, [])

    async def test_pure_image_and_text_multi_image_submit_native_bytes_in_order(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            for session, text, blocks in (("pure", "", [image_block()]),
                    ("multi", "two synthetic pictures", [image_block(), image_block("WEBP", color=(0, 20, 220))])):
                with self.subTest(session=session):
                    result, deltas, calls = await self.send(workspace, model, blocks, content=text, session=session)
                    self.assertTrue(result["success"], result)
                    submitted = [params for method, params in calls if method == "session/prompt"]
                    self.assertEqual(len(submitted), 1)
                    expected = ([{"type": "text", "text": text}] if text else []) + blocks
                    self.assertEqual(submitted[0]["contentBlocks"], expected)
                    self.assertEqual(len(image_sources(model.posts[-1])), len(blocks))
                    self.assertEqual(model.posts[-1].get("tools", []), [])
                    for source, block in zip(image_sources(model.posts[-1]), blocks):
                        raw = model.uploads[source["file_id"]] if source["type"] == "file" else base64.b64decode(source["data"])
                        with Image.open(io.BytesIO(raw)) as received, Image.open(io.BytesIO(base64.b64decode(block["data"]))) as original:
                            self.assertEqual(received.convert("RGB").tobytes(), original.convert("RGB").tobytes())
                    self.assertEqual([delta.type for delta in deltas].count("done"), 1)
            self.assertEqual(len(model.posts), 2)
            self.assertEqual(model.deleted, [])
            self.assertEqual(model.errors, [])

    async def test_unknown_and_text_only_routes_never_submit_partial_input(self) -> None:
        for catalog, status, expected in ((None, 404, "未确认"), (model_catalog(modalities=["text"]), 200, "仅支持文本")):
            with self.subTest(status=status), ImageWorkspace() as workspace, LocalImageModel(catalog=catalog, catalog_status=status) as model:
                result, deltas, calls = await self.send(workspace, model, [image_block()], content="keep both")
                self.assertFalse(result["success"])
                self.assertIsNone(result["agentSessionId"])
                self.assertIn(expected, result["error"])
                self.assertFalse(any(method == "session/prompt" for method, _ in calls))
                self.assertFalse((self.layout().root / "session.json").exists())
                self.assertEqual(model.posts, [])
                self.assertEqual(model.uploads, {})
                self.assertNotIn("done", [delta.type for delta in deltas])

    async def test_over_one_mib_valid_image_reaches_real_provider_once_without_truncation(self) -> None:
        block = image_block(size=(700, 700), noise=True)
        original = base64.b64decode(block["data"])
        self.assertGreater(len(original), 1024 * 1024)
        self.assertLess(len(original), 4 * 1024 * 1024)
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            result, _, calls = await self.send(workspace, model, [block], content="large synthetic image")
            self.assertTrue(result["success"], "大图片应通过真实准入与原生提交")
            self.assertEqual(len(model.posts), 1)
            prompts = [params for method, params in calls if method == "session/prompt"]
            self.assertEqual(len(prompts), 1)
            self.assertTrue(prompts[0]["contentBlocks"][1]["data"] == block["data"], "Python→原生图片字节不得截断")
            sources = image_sources(model.posts[0])
            self.assertEqual(len(sources), 1)
            source = sources[0]
            received = model.uploads[source["file_id"]] if source["type"] == "file" else base64.b64decode(source["data"])
            with Image.open(io.BytesIO(received)) as actual, Image.open(io.BytesIO(original)) as expected:
                self.assertEqual(actual.size, expected.size)
                self.assertTrue(actual.convert("RGB").tobytes() == expected.convert("RGB").tobytes(),
                                "此无 EXIF PNG 样本的解码像素应保持不变；不以文件哈希替代转码语义")
            self.assertEqual(model.deleted, [])

    async def test_guard_unavailable_rejects_supported_route_before_files_or_model(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            result, _, calls = await self.send(workspace, model, [image_block()], egress="guarded")
            self.assertFalse(result["success"])
            self.assertIn("删除防护", result["error"])
            self.assertFalse(any(method == "session/prompt" for method, _ in calls))
            self.assertEqual(model.paths, [])

    async def test_explicit_prompt_rejection_retains_metadata_without_false_native_acceptance(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            result, deltas, calls = await self.send(workspace, model, [image_block()], tamper=True)
            self.assertFalse(result["success"])
            self.assertIsNone(result["agentSessionId"])
            self.assertEqual(len([method for method, _ in calls if method == "session/prompt"]), 1)
            meta = json.loads((self.layout().root / "session.json").read_text(encoding="utf-8"))
            self.assertFalse(meta.get("submitted", False))
            self.assertFalse(meta.get("imageInputs", False))
            self.assertEqual(list(self.layout().home.rglob("*.jsonl*")), [])
            self.assertEqual(model.uploads, {})
            self.assertEqual(model.posts, [])
            self.assertNotIn("turn_accepted", [getattr(delta, "diagnostic", {}).get("phase")
                for delta in deltas if delta.type == "diagnostic"])

    async def test_explicit_text_only_and_missing_resources_never_spawn(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel() as model:
            result, _, calls = await self.send(workspace, model, [image_block()], text_only=True)
            self.assertFalse(result["success"])
            self.assertIn("纯文本", result["error"])
            self.assertEqual(calls, [])
            with patch("src.backend.deepseek_harness_turn.bridge_path", side_effect=RuntimeError("Harness 图片资源缺失")):
                result, _, calls = await self.send(workspace, model, [image_block()])
            self.assertFalse(result["success"])
            self.assertEqual(calls, [])
            self.assertEqual(workspace.owners, [])
            self.assertEqual(model.paths, [])

    async def test_cross_process_resume_only_submits_new_blocks_and_keeps_native_images(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            first, _, _ = await self.send(workspace, model, [image_block()], content="first image")
            self.assertTrue(first["success"], first)
            native = first["agentSessionId"]
            for text, blocks in (("new text only", []), ("one new image", [image_block("WEBP", color=(0, 20, 220))])):
                result, _, calls = await self.send(workspace, model, blocks, content=text, native=native)
                self.assertTrue(result["success"], result)
                self.assertEqual(result["agentSessionId"], native)
                resumes = [params for method, params in calls if method == "session/resume"]
                self.assertEqual(len(resumes), 1)
                self.assertEqual(resumes[0]["sessionId"], native)
                prompts = [params for method, params in calls if method == "session/prompt"]
                self.assertEqual(len(prompts), 1)
                self.assertEqual(prompts[0]["contentBlocks"], [{"type": "text", "text": text}] + blocks)
            self.assertEqual([len(image_sources(post)) for post in model.posts], [1, 1, 2])
            self.assertEqual(len(model.uploads), 2)
            meta = json.loads((self.layout().root / "session.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["nativeId"], native)
            self.assertTrue(meta["submitted"])
            self.assertTrue(meta["imageInputs"])
            self.assertEqual(len(list((self.layout().home / "sessions").rglob("*.jsonl*"))), 1)
            self.assertEqual(model.deleted, [])

    async def test_missing_history_keeps_binding_without_prompt_or_replacement(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            first, _, _ = await self.send(workspace, model, [image_block()])
            self.assertTrue(first["success"], first)
            layout = self.layout()
            previous = (layout.root / "session.json").read_bytes()
            history = layout.home / "sessions"
            self.assertTrue(history.resolve().is_relative_to(workspace.root))
            self.assertFalse(history.is_symlink())
            history.rename(workspace.root / "retained-native-history")
            result, _, calls = await self.send(workspace, model, [], content="must not replace", native=first["agentSessionId"])
            self.assertFalse(result["success"])
            self.assertEqual(result["agentSessionId"], first["agentSessionId"])
            self.assertEqual((layout.root / "session.json").read_bytes(), previous)
            self.assertFalse(any(method == "session/prompt" for method, _ in calls))
            self.assertEqual(len(model.posts), 1)
            self.assertEqual(model.deleted, [])

    async def test_missing_native_attachments_fail_even_with_known_remote_file(self) -> None:
        for files in ("success", "missing"):
            with self.subTest(files=files), ImageWorkspace() as workspace, LocalImageModel(files_mode=files) as model:
                first, _, _ = await self.send(workspace, model, [image_block()])
                self.assertTrue(first["success"], first)
                layout = self.layout()
                attachments = layout.home / "attachments"
                self.assertTrue(attachments.resolve().is_relative_to(workspace.root))
                self.assertFalse(attachments.is_symlink())
                attachments.rename(workspace.root / "retained-native-attachments")
                result, _, calls = await self.send(workspace, model, [], content="history image is missing", native=first["agentSessionId"])
                self.assertFalse(result["success"])
                self.assertEqual(result["agentSessionId"], first["agentSessionId"])
                self.assertEqual(len(model.posts), 1)
                self.assertEqual(len([method for method, _ in calls if method == "session/prompt"]), 1)
                self.assertEqual(model.deleted, [])
                self.assertTrue(list((workspace.root / "retained-native-attachments").rglob("*")))

    async def test_upload_failure_and_cancel_keep_association_and_never_delete(self) -> None:
        for stop in (False, True):
            with self.subTest(stop=stop), ImageWorkspace() as workspace, LocalImageModel(files_mode="success",
                    message_status=200 if stop else 400, hold_messages=stop) as model:
                backends = []
                task = asyncio.create_task(self.send(workspace, model, [image_block()], backend_ready=backends.append))
                try:
                    if stop:
                        self.assertTrue(await asyncio.to_thread(model.message_received.wait, 10))
                        self.assertEqual(len(model.uploads), 1)
                        backends[0].abort("image-turn")
                    result, deltas, calls = await asyncio.wait_for(asyncio.shield(task), 20)
                    self.assertFalse(result["success"])
                    self.assertTrue(result["agentSessionId"])
                    self.assertEqual(len([method for method, _ in calls if method == "session/prompt"]), 1)
                    self.assertNotIn("done", [delta.type for delta in deltas])
                    meta = json.loads((self.layout().root / "session.json").read_text(encoding="utf-8"))
                    self.assertTrue(meta["submitted"])
                    self.assertEqual(meta["nativeId"], result["agentSessionId"])
                    self.assertTrue(list((self.layout().home / "attachments").rglob("*")))
                    self.assertEqual(len(model.uploads), 1)
                    self.assertEqual(len(model.posts), 1)
                    self.assertEqual(model.deleted, [])
                finally:
                    if backends:
                        backends[0].abort("image-turn")
                    await asyncio.gather(task, return_exceptions=True)

    async def test_unknown_exit_blocks_same_session_images_but_not_another_session(self) -> None:
        from src.backend.deepseek_harness_worker import HarnessWorker, _ACTIVE, _REGISTRY_LOCK, session_has_activity
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            worker = HarnessWorker(self.layout(), uuid.uuid4().hex)
            def unknown_exit(owned, _publish):
                # 只模拟缺退出证明，夹具不创建实际进程。
                owned.owner.spawn_attempted = True
            worker.start(unknown_exit)
            try:
                with self.assertRaisesRegex(RuntimeError, "退出未确认"):
                    await worker.consume(lambda _event: None)
                result, _, calls = await self.send(workspace, model, [image_block()])
                self.assertFalse(result["success"])
                self.assertEqual(calls, [])
                self.assertTrue(session_has_activity(owner="image-owner", executor="image-executor", session="image-turn"))
                self.assertTrue(self.layout().activity_file.exists())
                other, _, _ = await self.send(workspace, model, [image_block()], session="other-session")
                self.assertTrue(other["success"], other)
                self.assertEqual(len(model.posts), 1)
                self.assertEqual(model.deleted, [])
            finally:
                self.assertIsNone(worker.owner.process)
                worker.reservation.release(confirmed=True)  # 仅这个从未启动进程的测试替身。
                with _REGISTRY_LOCK:
                    _ACTIVE.pop(worker.key, None)

    async def test_independent_image_context_preserves_main_binding_and_frozen_permissions(self) -> None:
        with ImageWorkspace() as workspace, LocalImageModel(files_mode="success") as model:
            first, _, _ = await self.send(workspace, model, [image_block()], content="main context")
            self.assertTrue(first["success"], first)
            main_meta = (self.layout().root / "session.json").read_bytes()
            def edit_later(backend):
                backend.config.allowed_tools = ["bash", "write"]
                backend.config.harness_permission_mode = "full-access"
            child, _, calls = await self.send(workspace, model, [image_block("WEBP")], content="independent context",
                isolated_context=True, execution_access="read-only", client_ready=edit_later)
            self.assertTrue(child["success"], child)
            self.assertNotEqual(child["agentSessionId"], first["agentSessionId"])
            self.assertEqual((self.layout().root / "session.json").read_bytes(), main_meta)
            self.assertFalse(any(method == "session/resume" for method, _ in calls))
            configure = next(params for method, params in calls if method == "awu/configure")
            self.assertEqual(configure["allowedTools"], [])
            self.assertEqual(model.posts[-1].get("tools", []), [])
            self.assertEqual(len(image_sources(model.posts[-1])), 1)
            self.assertEqual(model.deleted, [])


if __name__ == "__main__":
    unittest.main()

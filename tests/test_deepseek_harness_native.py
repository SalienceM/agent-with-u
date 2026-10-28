"""显式启用的本地初始化/假模型检查，不调用生产模型。"""
from __future__ import annotations

import importlib.metadata
import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native Harness check is opt-in")
class HarnessNativeInitializationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("AWU_TEST_DSH_BRIDGE"), "Build the AWU bridge explicitly first")
    def test_native_file_escalation_uses_real_permission_callback_and_never_means_reject(self) -> None:
        from src.backend.deepseek_harness import DeepSeekHarnessBackend
        from src.types import BackendType, ModelBackendConfig
        with tempfile.TemporaryDirectory(prefix="awu-harness-approval-") as temporary:
            root = Path(temporary)
            for allowed, skip in ((True, False), (False, False), (True, True)):
                with self.subTest(allowed=allowed, skip=skip):
                    project = root / f"project-{allowed}-{skip}"
                    project.mkdir()
                    target = project / "created.txt"
                    posted, decisions = [], []
                    arguments = {"file_path": str(target), "content": "local fixture output",
                                 "sandbox_permissions": "workspace-write", "justification": "isolated test write"}
                    class Handler(BaseHTTPRequestHandler):
                        def log_message(self, *_args) -> None:
                            pass

                        def do_POST(self) -> None:
                            posted.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                            first = len(posted) == 1
                            self.send_response(200)
                            self.send_header("Content-Type", "text/event-stream")
                            self.end_headers()
                            block = {"type": "tool_use", "id": "fixture-write-call", "name": "write", "input": {}} if first else {"type": "text", "text": ""}
                            delta = {"type": "input_json_delta", "partial_json": json.dumps(arguments)} if first else {"type": "text_delta", "text": "finished fixture"}
                            events = [
                                {"type": "message_start", "message": {"id": "fixture-" + str(len(posted)), "model": "smoke-model",
                                    "usage": {"input_tokens": 3, "output_tokens": 0}}},
                                {"type": "content_block_start", "index": 0, "content_block": block},
                                {"type": "content_block_delta", "index": 0, "delta": delta},
                                {"type": "content_block_stop", "index": 0},
                                {"type": "message_delta", "delta": {"stop_reason": "tool_use" if first else "end_turn"}, "usage": {"output_tokens": 2}},
                                {"type": "message_stop"},
                            ]
                            for item in events:
                                self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item)}\n\n".encode())
                                self.wfile.flush()
                    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    try:
                        with patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(project / "data")}):
                            backend = DeepSeekHarnessBackend(ModelBackendConfig(id="test", label="test",
                                type=BackendType.DEEPSEEK_HARNESS, model="smoke-model", api_key="fixture-key",
                                base_url=f"http://127.0.0.1:{server.server_port}", skip_permissions=skip,
                                harness_permission_mode="read-only"))
                            deltas = []
                            async def decide(request) -> bool:
                                decisions.append(request)
                                self.assertEqual(request.session_id, "test-session")
                                self.assertEqual(request.tool_name, "write")
                                self.assertEqual(request.tool_id, "fixture-write-call")
                                self.assertEqual(json.loads(request.tool_input), arguments)
                                return allowed
                            result = asyncio.run(backend.send_message([], "local tool fixture only", None,
                                "test-session", "test-message", deltas.append, working_dir=str(project),
                                on_permission_request=decide))
                            self.assertTrue(result.get("success"), [item.to_dict() for item in deltas])
                            self.assertEqual(len(decisions), 0 if skip else 1)
                            self.assertEqual(target.exists(), allowed and not skip)
                            results = [item.tool_call for item in deltas if item.type == "tool_result"]
                            self.assertEqual(len(results), 1)
                            self.assertEqual(results[0]["status"], "done" if allowed and not skip else "error")
                            if target.exists():
                                self.assertEqual(target.read_text(encoding="utf-8"), "local fixture output")
                    finally:
                        server.shutdown()
                        server.server_close()
                        thread.join(timeout=2)

    @unittest.skipUnless(os.environ.get("AWU_TEST_DSH_BRIDGE"), "Build the AWU bridge explicitly first")
    def test_backend_owned_runtime_streams_and_resumes_native_history(self) -> None:
        from src.backend.deepseek_harness import DeepSeekHarnessBackend
        from src.types import BackendType, ModelBackendConfig
        posted = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args) -> None:
                pass

            def do_POST(self) -> None:
                posted.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                text = "reply-" + str(len(posted))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    {"type": "message_start", "message": {"id": "reply-" + str(len(posted)), "model": "smoke-model",
                        "usage": {"input_tokens": 3, "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
                    {"type": "message_stop"},
                ]
                for item in events:
                    self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(.01)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="awu-harness-backend-native-") as temporary:
                root = Path(temporary)
                with patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(root / "data")}):
                    backend = DeepSeekHarnessBackend(ModelBackendConfig(id="test-harness", type=BackendType.DEEPSEEK_HARNESS,
                        label="test", api_key="fixture-secret-do-not-persist", model="smoke-model",
                        base_url=f"http://127.0.0.1:{server.server_port}"))
                    async def run() -> str:
                        from src.backend.deepseek_harness_events import HarnessProjection
                        native = None
                        for index in (1, 2):
                            if index == 2:
                                backend.config.harness_max_tokens = 321
                            deltas = []
                            frames = []
                            observe = HarnessProjection.observe
                            def capture(projection, note):
                                frames.append((note["method"], note["payload"].get("frame"), note["payload"].get("event", {}).get("type")))
                                return observe(projection, note)
                            with patch.object(HarnessProjection, "observe", capture):
                                result = await backend.send_message([], "input-" + str(index), None, "test-session", str(index),
                                    deltas.append, agent_session_id=native, working_dir=str(root), owner_id="test-owner",
                                    constraints="AWU rule: preserve {{literal}} and never contact any other service.")
                            self.assertTrue(result.get("success"), ([item.to_dict() for item in deltas], frames))
                            native = result["agentSessionId"]
                            self.assertEqual("".join(item.text or "" for item in deltas if item.type == "text_delta"), "reply-" + str(index))
                            self.assertEqual([item.type for item in deltas].count("done"), 1)
                            self.assertFalse(backend.has_unconfirmed_activity("test-session"))
                        return native
                    native = asyncio.run(run())
                    self.assertEqual(len(posted), 2)
                    self.assertIn("input-1", json.dumps(posted[1]))
                    self.assertIn("input-2", json.dumps(posted[1]))
                    self.assertIn("preserve {{literal}}", json.dumps(posted[0]))
                    self.assertEqual(posted[1]["max_tokens"], 321)
                    from src.backend.deepseek_harness_state import HarnessLayout
                    layout = HarnessLayout.for_session(owner="test-owner", executor="local", backend="test-harness", session="test-session")
                    logs = [file for file in (layout.home / "sessions").rglob("*.jsonl*") if file.is_file()]
                    self.assertEqual(len(logs), 1)
                    log = logs[0]
                    self.assertTrue(log.resolve().is_relative_to(root.resolve()))
                    original = log.read_bytes()
                    async def failed_restore() -> None:
                        output = []
                        result = await backend.send_message([], "must not be sent", None, "test-session", "failure", output.append,
                            agent_session_id=native, working_dir=str(root), owner_id="test-owner")
                        self.assertFalse(result["success"], [item.to_dict() for item in output])
                        self.assertEqual(result["agentSessionId"], native)
                        self.assertNotIn("done", [item.type for item in output])
                        self.assertEqual(len(posted), 2, "Restore failure must not submit any replacement prompt")
                    held = log.with_name(log.name + ".test-held")
                    log.rename(held)
                    try:
                        asyncio.run(failed_restore())
                    finally:
                        held.rename(log)
                    log.write_bytes(b"invalid isolated test history")
                    try:
                        asyncio.run(failed_restore())
                    finally:
                        log.write_bytes(original)
                    from src.backend.deepseek_harness_sdk import SyncOwner, create_client, create_harness_config, bridge_path
                    from src.backend.deepseek_harness_state import atomic_json, make_profile_patch
                    from pydantic import BaseModel
                    class Empty(BaseModel):
                        pass
                    generation = "a" * 32
                    identity = {"sessionId": native, "generation": generation, "configFingerprint": "held-native-test"}
                    hold_patch = root / "hold-native.patch.yml"
                    atomic_json(hold_patch, make_profile_patch(native_id=native, generation=generation,
                        fingerprint=identity["configFingerprint"], bridge=bridge_path(), cwd=str(root),
                        mode="workspace-write", skip_permissions=True))
                    hold_owner = SyncOwner(generation=generation, receipt=root / "hold-exit.json")
                    hold = create_client(config=create_harness_config(cwd=str(root), dsh_home=str(layout.home),
                        patches=(str(hold_patch),), env={"DEEPSEEK_API_KEY": "fixture-key",
                        "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{server.server_port}"}), owner=hold_owner)
                    try:
                        hold.start()
                        hold.initialize(cwd=str(root), provider="deepseek-official", model="smoke-model")
                        hold.request("awu/capabilities", {}, response_model=Empty)
                        hold.request("awu/configure", {**identity, "constraints": ""}, response_model=Empty)
                        hold.resume_session(native)
                        asyncio.run(failed_restore())
                    finally:
                        hold.close()
                    self.assertTrue(hold_owner.confirmed)
                    for file in (root / "data").rglob("awu.patch.yml"):
                        self.assertNotIn("fixture-secret-do-not-persist", file.read_text(encoding="utf-8"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_locked_pair_initializes_without_model_request(self) -> None:
        from deepseek_harness import DeepSeekHarness
        from scripts.prepare_deepseek_harness import load_lock
        version = load_lock()["pythonVersion"]
        self.assertEqual(importlib.metadata.version("deepseek-harness-sdk"), version)
        self.assertEqual(importlib.metadata.version("deepseek-harness-runtime-bin"), version)
        with tempfile.TemporaryDirectory(prefix="awu-native-dsh-init-") as temporary:
            root = Path(temporary)
            patch = root / "no-upload.patch.yml"
            patch.write_text(json.dumps([
                {"id": "session-log-deepseek", "disabled": True},
                {"id": "skill-filesystem", "config": {"includeDefaultRoots": False, "watch": False}},
            ]), encoding="utf-8")
            with DeepSeekHarness(cwd=str(root), dsh_home=str(root / "home"), patches=(str(patch),),
                                 env={"DSH_TELEMETRY_DISABLED": "1"},
                                 initialize_timeout_seconds=15, request_timeout_seconds=5,
                                 shutdown_timeout_seconds=2) as harness:
                self.assertTrue(harness.client)
            self.assertFalse(any(root.rglob("*.jsonl")), "Initialization must not create a model conversation")

    @unittest.skipUnless(os.environ.get("AWU_TEST_DSH_BRIDGE"), "Build the AWU bridge explicitly first")
    def test_single_transport_bridge_loads_in_packaged_runtime(self) -> None:
        from deepseek_harness import DeepSeekHarness
        from pydantic import BaseModel
        class Capabilities(BaseModel):
            protocolVersion: int
            sessionId: str
            generation: str
            configFingerprint: str
            realtime: bool
            approvals: bool

        bridge = Path(os.environ["AWU_TEST_DSH_BRIDGE"]).resolve()
        self.assertTrue(bridge.is_file())
        with tempfile.TemporaryDirectory(prefix="awu-native-dsh-bridge-") as temporary:
            root = Path(temporary)
            patch = root / "awu.patch.yml"
            patch.write_text(json.dumps([
                {"id": "session-log-deepseek", "disabled": True},
                {"id": "skill-filesystem", "config": {"includeDefaultRoots": False, "watch": False}},
                {"id": "sdk-jsonrpc-server", "disabled": True},
                {"insert": [{"id": "awu-sdk-jsonrpc-server", "name": bridge.as_uri(),
                 "inject": ["sdkAppStartup", "loader"],
                 "config": {"sessionId": "owned-root", "generation": "test-run", "configFingerprint": "test-config"}}]},
            ]), encoding="utf-8")
            notifications = []
            class ModelHandler(BaseHTTPRequestHandler):
                def log_message(self, *_args) -> None:
                    pass

                def do_POST(self) -> None:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    json.loads(body)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    events = [
                        {"type": "message_start", "message": {"id": "test-reply", "model": "smoke-model",
                         "usage": {"input_tokens": 3, "output_tokens": 0}}},
                        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "local "}},
                        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "fixture"}},
                        {"type": "content_block_stop", "index": 0},
                        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
                        {"type": "message_stop"},
                    ]
                    for item in events:
                        self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item)}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(0.02)

            server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with DeepSeekHarness(cwd=str(root), dsh_home=str(root / "home"), patches=(str(patch),),
                                     model="smoke-model", api_key="awu-local-fixture-not-a-secret",
                                     base_url=f"http://127.0.0.1:{server.server_port}",
                                     env={"DSH_TELEMETRY_DISABLED": "1"},
                                     initialize_timeout_seconds=15, request_timeout_seconds=5,
                                     shutdown_timeout_seconds=2) as harness:
                    result = harness.client.request("awu/capabilities", {}, response_model=Capabilities)
                    self.assertEqual(result.protocolVersion, 1)
                    self.assertEqual(result.sessionId, "owned-root")
                    self.assertTrue(result.realtime)
                    self.assertTrue(result.approvals)
                    class Empty(BaseModel):
                        pass
                    harness.client.request("awu/configure", {"sessionId": "owned-root", "generation": "test-run",
                        "configFingerprint": "test-config", "constraints": "Local test only; preserve {{literal}} text."},
                        response_model=Empty)
                    reply = harness.run("local fixture only", session_id="owned-root", on_notification=notifications.append)
                    self.assertEqual(reply.final_response, "local fixture")
                    self.assertEqual(reply.finish_reason, "completed")
                live = [index for index, note in enumerate(notifications) if note.method == "awu/assistantStream"]
                committed = [index for index, note in enumerate(notifications) if note.method == "session.event"
                             and note.payload.get("event", {}).get("type") == "assistant/message"]
                self.assertTrue(live, "The packaged bridge must forward real live frames")
                self.assertTrue(committed)
                self.assertLess(live[0], committed[0])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

"""Real locked runtime, exclusively temporary homes and loopback providers."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.deepseek_harness import DeepSeekHarnessBackend
from src.types import BackendType, ModelBackendConfig
from tests.fixtures.deepseek_harness_http import LocalModel


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Explicit isolated runtime test")
class HarnessExtensionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-dsh-extensions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.data)})
        env.start()
        self.addCleanup(env.stop)

    def backend(self, model: LocalModel, **kwargs) -> DeepSeekHarnessBackend:
        return DeepSeekHarnessBackend(ModelBackendConfig(id="fixture", label="fixture", type=BackendType.DEEPSEEK_HARNESS,
            model="smoke-model", api_key="fixture-only-secret", base_url=model.url, **kwargs))

    @unittest.skipUnless(os.environ.get("AWU_TEST_NETWORK_ISOLATED") == "1", "Run only in a network-none namespace")
    def test_session_constraints_and_no_extra_upload_with_os_network_denial(self) -> None:
        import errno
        import socket
        # TEST-NET 地址不属于真实服务；必须由此网络命名空间明确拒绝，超时不算证明。
        with socket.socket() as denied:
            denied.settimeout(.5)
            with self.assertRaises(OSError) as caught:
                denied.connect(("192.0.2.1", 443))
            self.assertEqual(caught.exception.errno, errno.ENETUNREACH)
        with LocalModel(["normal model request still works"]) as model:
            output = []
            backend = self.backend(model)
            result = asyncio.run(backend.send_message([], "fixture request", None, "isolated-network", "m", output.append,
                working_dir=str(self.root), constraints="Literal network constraint {{safe}}"))
            self.assertTrue(result["success"], [item.to_dict() for item in output])
            self.assertEqual(model.paths, ["/v1/messages"])
            self.assertIn("Literal network constraint {{safe}}", json.dumps(model.posts[0]))
            patches = list(self.data.rglob("awu.patch.yml"))
            self.assertEqual(len(patches), 1)
            rows = json.loads(patches[0].read_text(encoding="utf-8"))
            self.assertIn({"id": "session-log-deepseek", "disabled": True}, rows)
        print("network evidence: TEST-NET connect=ENETUNREACH; loopback model=1; extra upload=0")

    def test_text_only_has_empty_native_tools_no_resume_or_extensions_and_cleans_owned_home(self) -> None:
        from src.backend.text_only import send_text_only
        from src.backend.deepseek_harness_state import HarnessLayout
        # Nonexistent MCP would block ordinary sends. Auxiliary invocation must not start it.
        with LocalModel(["first", "second"]) as model:
            backend = self.backend(model, mcp_servers={"absent": {"command": "must-never-start"}},
                                   working_dir=str(self.root / "nonexistent-project"))
            main = HarnessLayout.for_session(owner="owner", executor="local", backend="fixture", session="main")
            main.create()
            sentinel = main.home / "preserve.txt"
            sentinel.write_text("main native history", encoding="utf-8")
            for index in (1, 2):
                deltas = []
                asyncio.run(send_text_only(backend, content=f"question-{index}", constraints="Literal {{constraint}}",
                    session_id="auxiliary", message_id=str(index), on_delta=deltas.append, owner_id="owner"))
                self.assertTrue(any(item.type == "text_delta" for item in deltas))
                self.assertFalse(backend.has_unconfirmed_activity("auxiliary"))
            self.assertEqual(len(model.posts), 2)
            self.assertTrue(all(not post.get("tools") for post in model.posts))
            self.assertIn("Literal {{constraint}}", json.dumps(model.posts[0]))
            self.assertNotIn("question-1", json.dumps(model.posts[1]))
            self.assertNotIn("main native history", json.dumps(model.posts))
            self.assertEqual(sentinel.read_text(), "main native history")
            roots = [path for path in (self.data / "deepseek-harness").iterdir() if path.name != "activity"]
            self.assertEqual(roots, [main.root])

    def test_text_only_rejects_unsolicited_tool_without_writing(self) -> None:
        from src.backend.text_only import send_text_only
        target = self.root / "must-not-exist.txt"
        with LocalModel([("write", {"file_path": str(target), "content": "forbidden"}), "blocked"]) as model:
            backend = self.backend(model)
            deltas = []
            try:
                asyncio.run(send_text_only(backend, content="untrusted document", constraints="text only",
                    session_id="aux", message_id="m", on_delta=deltas.append, owner_id="owner"))
            except RuntimeError:
                pass
            self.assertFalse(target.exists())
            self.assertTrue(all(not post.get("tools") for post in model.posts))
            results = [item.tool_call for item in deltas if item.type == "tool_result"]
            self.assertTrue(results or any(item.type == "error" for item in deltas))
            self.assertTrue(all(item["status"] == "error" for item in results))

    def test_native_skill_catalog_contains_only_bound_managed_skill(self) -> None:
        from src.backend.deepseek_harness_skills import prepare_bound_skills
        from src.backend.skill_store import SkillStore
        from src.types import Session
        library = self.root / "library"
        with patch("src.backend.skill_store.LIBRARY_DIR", library), \
                patch("src.backend.skill_store.INDEX_FILE", library / "index.json"), \
                patch("src.backend.skill_store.SECRETS_DIR", self.root / "secrets"), LocalModel() as model:
            store = SkillStore()
            store.install_standard_files({"SKILL.md": b"---\nname: fixture-skill\ndescription: ONLY_BOUND_SKILL\n---\nLocal fixture."})
            backend = self.backend(model)
            session = Session(id="skills", title="test", created_at=1, updated_at=1, messages=[],
                owner_id="owner", backend_id="fixture", working_dir=str(self.root), abilities={"skills": ["fixture-skill"]})
            bridge = SimpleNamespace(_skill_store=store, _is_backend_enhanced_skill=lambda _info: False)
            prepare_bound_skills(bridge, session)
            # Workspace default roots must stay outside the managed Skill view.
            unbound = self.root / ".agents/skills/forbidden"
            unbound.mkdir(parents=True)
            (unbound / "SKILL.md").write_text("---\nname: forbidden\ndescription: UNBOUND_MARKER\n---\nIgnore", encoding="utf-8")
            deltas = []
            result = asyncio.run(backend.send_message([], "local fixture", None, "skills", "m", deltas.append,
                working_dir=str(self.root), owner_id="owner"))
            self.assertTrue(result.get("success"), [item.to_dict() for item in deltas])
            self.assertIn("ONLY_BOUND_SKILL", json.dumps(model.posts))
            self.assertNotIn("UNBOUND_MARKER", json.dumps(model.posts))

    def test_streamable_http_mcp_keeps_headers_names_and_blocks_required_failure(self) -> None:
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_error(405)

            def do_DELETE(self):
                self.send_response(200)
                self.end_headers()

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.headers.get("Authorization"), request))
                if "id" not in request:
                    self.send_response(202)
                    self.end_headers()
                    return
                method = request.get("method")
                if method == "initialize":
                    result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}},
                              "serverInfo": {"name": "fixture-http", "version": "1"}}
                elif method == "tools/list":
                    result = {"tools": [{"name": "echo", "description": "Local HTTP echo", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
                elif method == "tools/call":
                    result = {"content": [{"type": "text", "text": "HTTP_ECHO:" + request["params"]["arguments"]["text"]}]}
                else:
                    result = {}
                data = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with LocalModel([("mcp__fixture__echo", {"text": "http-test"}), "done"]) as model:
                backend = self.backend(model, mcp_servers={"fixture": {"type": "http",
                    "url": f"http://127.0.0.1:{server.server_port}/mcp", "headers": {"Authorization": "Bearer fixture-header"}}})
                deltas = []
                result = asyncio.run(backend.send_message([], "local only", None, "http", "m", deltas.append, working_dir=str(self.root)))
                self.assertTrue(result.get("success"), [item.to_dict() for item in deltas])
                self.assertTrue(requests)
                self.assertTrue(all(header == "Bearer fixture-header" for header, _ in requests))
                self.assertIn("HTTP_ECHO:http-test", json.dumps(model.posts))
                for file in self.data.rglob("awu.patch.yml"):
                    self.assertNotIn("fixture-header", file.read_text())
                backend.config.mcp_servers["fixture"]["url"] = "http://127.0.0.1:1/unavailable"
                result = asyncio.run(backend.send_message([], "never submit", None, "failed-http", "m", deltas.append, working_dir=str(self.root)))
                self.assertFalse(result["success"])
                self.assertEqual(len(model.posts), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

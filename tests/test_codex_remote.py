import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.backend.codex_app_server import (
    APP_SERVER_STREAM_LIMIT, ATTACHABLE_THREAD_SOURCE_KINDS, CodexAppServerProcess,
    list_local_threads, list_ssh_hosts, validate_ssh_host,
)
from src.backend.bridge_ws import BridgeWS
from src.backend.codex_office import CodexOfficeBackend
from src.types import BackendType, ModelBackendConfig, Session


class SshHostDiscoveryTests(unittest.TestCase):
    def test_concrete_hosts_only_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config"
            path.write_text(
                "Host devbox *.example !blocked\n  HostName 10.0.0.2\n"
                "Host work devbox\n  User coder\n",
                encoding="utf-8",
            )
            self.assertEqual(list_ssh_hosts(path), ["devbox", "work"])

    def test_host_validation_rejects_ssh_options(self):
        with self.assertRaises(ValueError):
            validate_ssh_host("-oProxyCommand=bad")

    def test_remote_working_dir_is_never_used_as_a_local_skill_root(self):
        bridge = BridgeWS.__new__(BridgeWS)
        session = Session(id="remote", title="Remote", created_at=1, updated_at=1, messages=[],
                          working_dir="/srv/project", backend_id="codex",
                          codex_remote_host="devbox")
        self.assertEqual(bridge._skill_deploy_roots_for_session(session), [])

    def test_node_thread_routes_codex_turn_through_local_app_server(self):
        bridge = BridgeWS.__new__(BridgeWS)
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
        ))
        session = Session(id="node", title="Node", created_at=1, updated_at=1,
                          messages=[], working_dir="C:/work", backend_id="codex",
                          codex_connection_mode="node")
        kwargs = {}
        bridge._add_runtime_kwargs(backend, kwargs, {}, session)
        self.assertTrue(kwargs["app_server_local"])
        self.assertNotIn("remote_host", kwargs)
        self.assertEqual(session.to_dict()["codexConnectionMode"], "node")

    def test_attached_thread_provenance_is_independent_from_ssh_transport(self):
        session = Session(
            id="ssh-attached", title="Attached", created_at=1, updated_at=1,
            messages=[], working_dir="/srv/project", backend_id="codex",
            agent_session_id="thread-1", codex_connection_mode="ssh",
            codex_remote_host="devbox", codex_thread_attached=True,
        )

        full = session.to_dict()
        summary = session.meta_dict()
        self.assertEqual(full["codexConnectionMode"], "ssh")
        self.assertTrue(full["codexThreadAttached"])
        self.assertTrue(summary["codexThreadAttached"])
        self.assertEqual(summary["codexRemoteHost"], "devbox")


class _FakeAppServer:
    instances = []

    def __init__(self, host="", command="", **kwargs):
        self.host = host
        self.command = command
        self.launch_command = kwargs.get("launch_command") or []
        self.requests = []
        self.messages = [
            {"method": "item/agentMessage/delta", "params": {"itemId": "a1", "delta": "远端"}},
            {"method": "item/agentMessage/delta", "params": {"itemId": "a1", "delta": "成功"}},
            {"method": "thread/tokenUsage/updated", "params": {"tokenUsage": {"total": {"inputTokens": 3, "outputTokens": 2}}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}},
        ]
        self.__class__.instances.append(self)

    async def start(self):
        return None

    async def request(self, method, params, timeout=30):
        self.requests.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": "remote-thread-1"}}
        if method == "turn/start":
            return {"turn": {"id": "turn-1"}}
        return {}

    async def next_message(self, timeout=None):
        return self.messages.pop(0)

    async def respond(self, request_id, **kwargs):
        return None

    async def close(self):
        return None


class CodexRemoteTurnTests(unittest.IsolatedAsyncioTestCase):
    async def test_attach_listing_includes_all_user_level_thread_sources(self):
        _FakeAppServer.instances.clear()
        with patch("src.backend.codex_app_server.CodexAppServerProcess", _FakeAppServer):
            rows = await list_local_threads("codex")

        self.assertEqual(rows, [])
        params = _FakeAppServer.instances[0].requests[0][1]
        self.assertEqual(params["sourceKinds"], ATTACHABLE_THREAD_SOURCE_KINDS)
        self.assertIn("exec", params["sourceKinds"])
        self.assertIn("appServer", params["sourceKinds"])
        self.assertFalse(any(kind.startswith("subAgent") for kind in params["sourceKinds"]))

    async def test_app_server_reads_json_lines_larger_than_asyncio_default(self):
        reader = asyncio.StreamReader(limit=APP_SERVER_STREAM_LIMIT)
        expected = {"id": 1, "result": {"text": "x" * 200_000}}
        reader.feed_data((json.dumps(expected) + "\n").encode("utf-8"))
        reader.feed_eof()
        process = type("Process", (), {"stdout": reader})()
        connection = CodexAppServerProcess(launch_command=["codex"])
        connection.proc = process
        actual = await connection._read_one(timeout=1)
        self.assertEqual(len(actual["result"]["text"]), 200_000)

    async def test_executor_rpc_lists_native_codex_threads(self):
        config = ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
        )
        backend = CodexOfficeBackend(config)
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = [config]
        bridge._backends = {"codex": backend}
        rows = [{"id": "thread-1", "preview": "existing", "cwd": "C:/repo"}]
        with patch("src.backend.bridge_ws.list_local_threads", AsyncMock(return_value=rows)):
            result = json.loads(await bridge._rpc_codexLocalThreads("codex"))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["threads"][0]["id"], "thread-1")
        self.assertEqual(result["threads"][0]["cwd"], "C:/repo")

    async def test_remote_turn_uses_app_server_and_streams(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL,
            label="Codex", model="gpt-test", skip_permissions=True,
        ))
        deltas = []
        _FakeAppServer.instances.clear()
        with patch("src.backend.codex_office.CodexAppServerProcess", _FakeAppServer):
            result = await backend.send_message(
                messages=[], content="hello", images=None,
                session_id="s1", message_id="m1", on_delta=deltas.append,
                working_dir="/srv/project", remote_host="devbox",
            )

        self.assertEqual(result["agentSessionId"], "remote-thread-1")
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "text_delta"), "远端成功")
        self.assertEqual(deltas[-1].type, "done")
        requests = _FakeAppServer.instances[0].requests
        self.assertEqual([r[0] for r in requests], ["thread/start", "turn/start"])
        self.assertEqual(requests[0][1]["cwd"], "/srv/project")
        self.assertEqual(requests[0][1]["sandbox"], "workspace-write")
        self.assertNotIn("sandboxPolicy", requests[1][1])
        self.assertEqual(requests[1][1]["effort"] if "effort" in requests[1][1] else "", "")

    async def test_executor_local_thread_uses_local_app_server(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL,
            label="Codex", model="gpt-test", skip_permissions=True,
        ))
        deltas = []
        _FakeAppServer.instances.clear()
        with patch("src.backend.codex_office.CodexAppServerProcess", _FakeAppServer), \
             patch("src.backend.codex_office.resolve_codex_cli", return_value="codex"):
            result = await backend.send_message(
                messages=[], content="continue", images=None,
                session_id="s2", message_id="m2", on_delta=deltas.append,
                agent_session_id="remote-thread-1", working_dir="C:/work",
                app_server_local=True,
            )

        self.assertEqual(result["agentSessionId"], "remote-thread-1")
        instance = _FakeAppServer.instances[0]
        self.assertFalse(instance.host)
        self.assertIn("app-server", " ".join(instance.launch_command))
        self.assertEqual(instance.requests[0][0], "thread/resume")
        self.assertEqual(instance.requests[0][1]["sandbox"], "workspace-write")
        self.assertNotIn("sandboxPolicy", instance.requests[1][1])

    async def test_app_server_uses_danger_full_access_mode_string(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL,
            label="Codex", model="gpt-test", skip_permissions=True,
        ))
        _FakeAppServer.instances.clear()
        with patch("src.backend.codex_office.CodexAppServerProcess", _FakeAppServer), \
             patch("src.backend.codex_office.resolve_codex_cli", return_value="codex"):
            await backend.send_message(
                messages=[], content="sandboxed", images=None,
                session_id="s3", message_id="m3", on_delta=lambda _delta: None,
                working_dir="C:/work", app_server_local=True,
                sandbox_enabled=False,
            )

        requests = _FakeAppServer.instances[0].requests
        self.assertEqual(requests[0][1]["sandbox"], "danger-full-access")
        self.assertNotIn("sandboxPolicy", requests[1][1])


if __name__ == "__main__":
    unittest.main()

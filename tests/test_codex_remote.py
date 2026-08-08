import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.backend.codex_app_server import (
    APP_SERVER_STREAM_LIMIT, ATTACHABLE_THREAD_SOURCE_KINDS, CodexAppServerProcess,
    list_local_threads, list_ssh_hosts, local_thread_change_token, validate_ssh_host,
)
from src.backend.bridge_ws import BridgeWS, _codex_visible_messages
from src.backend.codex_office import CodexOfficeBackend
from src.types import BackendType, ChatMessage, ModelBackendConfig, Session


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

    def test_local_thread_change_token_uses_rollout_stat(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rollout = root / "2026" / "07" / "rollout-thread-123.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_text("{}\n", encoding="utf-8")

            token = local_thread_change_token("thread-123", root)

            self.assertIsNotNone(token)
            self.assertEqual(token[1], rollout.stat().st_size)

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

    def test_normal_codex_session_uses_app_server_unless_explicitly_disabled(self):
        session = Session(
            id="normal", title="Normal", created_at=1, updated_at=1,
            messages=[], working_dir="C:/work", backend_id="codex",
        )
        enabled = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
        ))
        enabled_kwargs = {}
        BridgeWS._add_runtime_kwargs(enabled, enabled_kwargs, {}, session)
        self.assertTrue(enabled_kwargs["app_server_local"])

        disabled = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
            env={"AGENTWITHU_CODEX_APP_SERVER": "false"},
        ))
        disabled_kwargs = {}
        BridgeWS._add_runtime_kwargs(disabled, disabled_kwargs, {}, session)
        self.assertNotIn("app_server_local", disabled_kwargs)

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
        self.responses = []
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
        self.responses.append((request_id, kwargs))

    async def close(self):
        return None


class _DynamicToolAppServer(_FakeAppServer):
    def __init__(self, host="", command="", **kwargs):
        super().__init__(host, command, **kwargs)
        self.messages = [
            {
                "method": "item/started",
                "params": {"item": {
                    "id": "dynamic-1",
                    "type": "dynamicToolCall",
                    "tool": "load_workspace_dependencies",
                    "namespace": "codex_app",
                    "arguments": {"token": "must-not-leak"},
                    "status": "inProgress",
                }},
            },
            {
                "id": 91,
                "method": "item/tool/call",
                "params": {
                    "threadId": "remote-thread-1",
                    "turnId": "turn-1",
                    "callId": "dynamic-1",
                    "tool": "load_workspace_dependencies",
                    "namespace": "codex_app",
                    "arguments": {"token": "must-not-leak"},
                },
            },
            {
                "method": "item/completed",
                "params": {"item": {
                    "id": "dynamic-1",
                    "type": "dynamicToolCall",
                    "tool": "load_workspace_dependencies",
                    "namespace": "codex_app",
                    "status": "failed",
                    "success": False,
                    "contentItems": [],
                }},
            },
            {
                "method": "item/agentMessage/delta",
                "params": {"itemId": "a1", "delta": "已改用远程节点的 PowerShell。"},
            },
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-1", "status": "completed"}},
            },
        ]


class _SteerableAppServer(_FakeAppServer):
    def __init__(self, host="", command="", **kwargs):
        super().__init__(host, command, **kwargs)
        self.messages = []
        self.release = asyncio.Event()
        self.completed = False

    async def request(self, method, params, timeout=30):
        result = await super().request(method, params, timeout)
        if method == "turn/steer":
            return {"turnId": "turn-1"}
        return result

    async def next_message(self, timeout=None):
        await asyncio.wait_for(self.release.wait(), timeout=timeout)
        if not self.completed:
            self.completed = True
            return {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-1", "status": "completed"}},
            }
        await asyncio.Event().wait()


class CodexRemoteTurnTests(unittest.IsolatedAsyncioTestCase):
    def test_visible_mirror_skips_in_progress_turns(self):
        thread = {
            "createdAt": 1,
            "turns": [
                {
                    "status": "completed",
                    "items": [
                        {"id": "u1", "type": "userMessage",
                         "content": [{"type": "text", "text": "ready"}]},
                        {"id": "a1", "type": "agentMessage", "text": "done"},
                    ],
                },
                {
                    "status": "inProgress",
                    "items": [
                        {"id": "u2", "type": "userMessage",
                         "content": [{"type": "text", "text": "running"}]},
                        {"id": "a2", "type": "agentMessage", "text": "partial"},
                    ],
                },
            ],
        }

        messages, latest, truncated = _codex_visible_messages(thread)

        self.assertEqual([message.id for message in messages], ["u1", "a1"])
        self.assertEqual(latest, "a1")
        self.assertFalse(truncated)

    def test_visible_mirror_uses_turn_dates_across_days(self):
        day_one = 1_787_000_000
        day_two = day_one + 86_400
        thread = {
            "createdAt": day_one - 60,
            "turns": [
                {
                    "status": "completed", "startedAt": day_one,
                    "completedAt": day_one + 12,
                    "items": [
                        {"id": "u1", "type": "userMessage",
                         "content": [{"type": "text", "text": "yesterday"}]},
                        {"id": "a1", "type": "agentMessage", "text": "done yesterday"},
                    ],
                },
                {
                    "status": "completed", "startedAt": day_two,
                    "completedAt": day_two + 30,
                    "items": [
                        {"id": "u2", "type": "userMessage",
                         "content": [{"type": "text", "text": "today"}]},
                        {"id": "a2", "type": "agentMessage", "text": "done today"},
                    ],
                },
            ],
        }

        messages, latest, truncated = _codex_visible_messages(thread)

        self.assertEqual([message.id for message in messages], ["u1", "a1", "u2", "a2"])
        self.assertEqual([message.timestamp for message in messages], [
            day_one, day_one + 12, day_two, day_two + 30,
        ])
        self.assertEqual(latest, "a2")
        self.assertFalse(truncated)

    async def test_attached_sync_matches_local_turns_and_appends_only_external_turns(self):
        config = ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
        )
        backend = CodexOfficeBackend(config)
        session = Session(
            id="attached", title="Attached", created_at=1, updated_at=1,
            messages=[
                ChatMessage(id="u0", role="user", content="start", timestamp=1),
                ChatMessage(id="a0", role="assistant", content="ready", timestamp=2),
                ChatMessage(id="local-u1", role="user", content="continue", timestamp=3),
                ChatMessage(id="local-a1", role="assistant", content="local answer", timestamp=4),
            ],
            working_dir="C:/repo", backend_id="codex",
            agent_session_id="thread-1", codex_connection_mode="node",
            codex_thread_attached=True, codex_sync_last_item_id="a0",
            codex_sync_local_count=2,
        )
        thread = {
            "createdAt": 1,
            "turns": [{
                "status": "completed",
                "items": [
                    {"id": "u0", "type": "userMessage",
                     "content": [{"type": "text", "text": "start"}]},
                    {"id": "a0", "type": "agentMessage", "text": "ready"},
                    {"id": "u1", "type": "userMessage",
                     "content": [{"type": "text", "text": "continue"}]},
                    {"id": "a1", "type": "agentMessage", "text": "local answer"},
                    {"id": "u2", "type": "userMessage",
                     "content": [{"type": "text", "text": "outside work"}]},
                    {"id": "a2", "type": "agentMessage", "text": "outside result"},
                ],
            }],
        }

        class Store:
            def __init__(self):
                self.saved = 0

            def load(self, _sid):
                return None

            def save(self, _session, async_=True):
                self.saved += 1

        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {session.id: session}
        bridge._session_store = Store()
        bridge._backend_configs = [config]
        bridge._backends = {"codex": backend}
        bridge._chat_turn_tasks = {}
        bridge._codex_sync_checked_at = {}
        bridge._codex_sync_change_tokens = {}
        events = []
        bridge._emit_session_updated = events.append

        with patch(
            "src.backend.bridge_ws.local_thread_change_token",
            return_value=None,
        ), patch(
            "src.backend.bridge_ws.read_local_thread",
            AsyncMock(return_value=thread),
        ):
            first = await bridge._sync_attached_codex_session(session.id, True)
            second = await bridge._sync_attached_codex_session(session.id, True)

        self.assertTrue(first["changed"])
        self.assertEqual(first["addedCount"], 2)
        self.assertFalse(second["changed"])
        self.assertEqual(
            [(message.role, message.content) for message in session.messages],
            [
                ("user", "start"),
                ("assistant", "ready"),
                ("user", "continue"),
                ("assistant", "local answer"),
                ("user", "outside work"),
                ("assistant", "outside result"),
            ],
        )
        self.assertEqual(session.codex_sync_last_item_id, "a2")
        self.assertEqual(session.codex_sync_local_count, 6)
        self.assertGreater(session.messages[-2].timestamp, session.messages[3].timestamp)
        self.assertGreater(session.messages[-1].timestamp, session.messages[-2].timestamp)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "codex_thread_synced")

    async def test_in_progress_sync_does_not_consume_unmatched_local_tail(self):
        config = ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
        )
        backend = CodexOfficeBackend(config)
        session = Session(
            id="attached-running", title="Attached", created_at=1, updated_at=1,
            messages=[
                ChatMessage(id="u0", role="user", content="start", timestamp=1),
                ChatMessage(id="a0", role="assistant", content="ready", timestamp=2),
                ChatMessage(id="local-u", role="user", content="continue", timestamp=3),
                ChatMessage(id="local-a", role="assistant", content="finished", timestamp=4),
            ],
            working_dir="C:/repo", backend_id="codex",
            agent_session_id="thread-running", codex_connection_mode="node",
            codex_thread_attached=True, codex_sync_last_item_id="a0",
            codex_sync_local_count=2,
        )
        initial_turn = {
            "status": "completed",
            "items": [
                {"id": "u0", "type": "userMessage",
                 "content": [{"type": "text", "text": "start"}]},
                {"id": "a0", "type": "agentMessage", "text": "ready"},
            ],
        }
        running_turn = {
            "status": "inProgress",
            "items": [
                {"id": "u1", "type": "userMessage",
                 "content": [{"type": "text", "text": "continue"}]},
                {"id": "a1", "type": "agentMessage", "text": "partial"},
            ],
        }
        completed_turn = {
            **running_turn,
            "status": "completed",
            "items": [
                running_turn["items"][0],
                {"id": "a1", "type": "agentMessage", "text": "finished"},
            ],
        }

        class Store:
            def load(self, _sid):
                return None

            def save(self, _session, async_=True):
                return None

        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {session.id: session}
        bridge._session_store = Store()
        bridge._backend_configs = [config]
        bridge._backends = {"codex": backend}
        bridge._chat_turn_tasks = {}
        bridge._codex_sync_checked_at = {}
        bridge._codex_sync_change_tokens = {}
        bridge._emit_session_updated = lambda _payload: None

        with patch(
            "src.backend.bridge_ws.local_thread_change_token",
            return_value=None,
        ), patch(
            "src.backend.bridge_ws.read_local_thread",
            AsyncMock(side_effect=[
                {"createdAt": 1, "turns": [initial_turn, running_turn]},
                {"createdAt": 1, "turns": [initial_turn, completed_turn]},
            ]),
        ):
            first = await bridge._sync_attached_codex_session(session.id, True)
            count_while_running = session.codex_sync_local_count
            second = await bridge._sync_attached_codex_session(session.id, True)

        self.assertFalse(first["changed"])
        self.assertEqual(count_while_running, 2)
        self.assertFalse(second["changed"])
        self.assertEqual(session.codex_sync_local_count, 4)
        self.assertEqual(session.codex_sync_last_item_id, "a1")
        self.assertEqual(len(session.messages), 4)

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

    async def test_remote_takeover_dynamic_tool_failure_is_recoverable(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL,
            label="Codex", model="gpt-test", skip_permissions=True,
        ))
        deltas = []
        _DynamicToolAppServer.instances.clear()
        with patch("src.backend.codex_office.CodexAppServerProcess", _DynamicToolAppServer):
            result = await backend.send_message(
                messages=[], content="continue", images=None,
                session_id="remote-takeover", message_id="m-dynamic",
                on_delta=deltas.append, agent_session_id="remote-thread-1",
                working_dir="/srv/project", remote_host="devbox",
            )

        self.assertEqual(result["agentSessionId"], "remote-thread-1")
        instance = _DynamicToolAppServer.instances[0]
        self.assertEqual(len(instance.responses), 1)
        request_id, envelope = instance.responses[0]
        self.assertEqual(request_id, 91)
        response = envelope["result"]
        self.assertFalse(response["success"])
        self.assertEqual(response["contentItems"][0]["type"], "inputText")
        response_text = response["contentItems"][0]["text"]
        self.assertIn("codex_app.load_workspace_dependencies", response_text)
        self.assertNotIn("must-not-leak", response_text)
        self.assertFalse(any(delta.type == "error" for delta in deltas))
        self.assertIn(
            "PowerShell",
            "".join(delta.text or "" for delta in deltas if delta.type == "text_delta"),
        )
        self.assertEqual(deltas[-1].type, "done")

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

    async def test_active_app_server_turn_accepts_native_steer_serially(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL,
            label="Codex", model="gpt-test", skip_permissions=True,
        ))
        _SteerableAppServer.instances.clear()
        with patch("src.backend.codex_office.CodexAppServerProcess", _SteerableAppServer):
            turn_task = asyncio.create_task(backend.send_message(
                messages=[], content="start", images=None,
                session_id="steer-session", message_id="assistant-1",
                on_delta=lambda _delta: None, working_dir="C:/work",
                app_server_local=True,
            ))
            for _ in range(20):
                if "steer-session" in backend._active_app_turns:
                    break
                await asyncio.sleep(0)

            first, second = await asyncio.gather(
                backend.steer_message(
                    session_id="steer-session", content="先检查测试",
                    client_message_id="follow-1",
                ),
                backend.steer_message(
                    session_id="steer-session", content="再检查性能",
                    client_message_id="follow-2",
                ),
            )
            instance = _SteerableAppServer.instances[0]
            instance.release.set()
            await turn_task

        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "ok")
        steer_requests = [request for request in instance.requests if request[0] == "turn/steer"]
        self.assertEqual(len(steer_requests), 2)
        self.assertEqual(steer_requests[0][1]["expectedTurnId"], "turn-1")
        self.assertEqual(steer_requests[0][1]["clientUserMessageId"], "follow-1")
        self.assertEqual(steer_requests[1][1]["clientUserMessageId"], "follow-2")

        finished = await backend.steer_message(
            session_id="steer-session", content="too late", client_message_id="follow-3",
        )
        self.assertEqual(finished["status"], "turn_finished")


if __name__ == "__main__":
    unittest.main()

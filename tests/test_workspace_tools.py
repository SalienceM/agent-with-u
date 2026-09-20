import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_CLIENT, _REQUEST_OWNER_ID
from src.backend.workspace_tools import ChatWorkspaceTools, WorkspaceOperations, relative_path, validate_args
from src.types import BackendType, ChatMessage, ModelBackendConfig, Session
from tests.test_session_user_isolation import _MemorySessionStore, _Client


class WorkspaceToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        self.environment.start()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {}
        self.bridge._session_store = _MemorySessionStore([])
        self.bridge._backend_configs = [ModelBackendConfig(id="target-model", type=BackendType.OPENAI_COMPATIBLE,
            label="目标模型", model="model", api_key="NEVER_EXPOSE_ME", env={"SECRET": "NEVER_EXPOSE_ME"})]
        self.bridge._default_workspace_root = lambda: self.root / "new-workspaces"
        self.bridge._clients = set()
        self.bridge._permission_gates = {}
        self.bridge._skip_rest_sessions = set()
        self.bridge._emit_session_updated = lambda *_a, **_kw: None
        self.bridge._ensure_kit_scheduler = lambda: None
        self.ops = self.bridge._workspace_operations_service = WorkspaceOperations(self.bridge)
        self.session = self.add_session("source", "源会话")
        (Path(self.session.working_dir) / "a.md").write_bytes("需求一\n需求二\n需求三".encode("utf-8"))

    async def asyncSetUp(self):
        self.owner = _REQUEST_OWNER_ID.set("alice")

    async def asyncTearDown(self):
        _REQUEST_OWNER_ID.reset(self.owner)
        self.environment.stop()
        self.temp.cleanup()

    def add_session(self, sid, title, owner="alice"):
        root = self.root / sid
        root.mkdir()
        session = Session(id=sid, title=title, created_at=1, updated_at=1, messages=[],
                          working_dir=str(root), backend_id="target-model", owner_id=owner)
        self.bridge._session_store.save(session)
        return session

    def create_args(self, **changes):
        return {"action": "create_session", "requestId": "split-001", "title": "拆分的需求",
                "files": [{"path": "requirements/01.md", "text": "# 需求一"},
                          {"path": "requirements/02.md", "text": "# 需求二"}], **changes}

    async def test_discovery_is_owner_scoped_and_backend_secrets_never_exposed(self):
        self.add_session("foreign", "不能看", "bob")
        result = await self.bridge._rpc_workspaceQuery(json.dumps({"action": "sessions"}))
        self.assertEqual([s["id"] for s in json.loads(result)["items"]], ["source"])
        result = await self.bridge._rpc_workspaceQuery(json.dumps({"action": "backends"}))
        self.assertNotIn("NEVER_EXPOSE_ME", result)
        self.assertNotIn("apiKey", result)
        self.assertEqual(json.loads(result)["items"][0]["id"], "target-model")

    async def test_name_resolution_and_character_pagination(self):
        result = self.ops.query({"action": "read_file", "session": "源会", "path": "a.md", "offset": 2, "limit": 3})
        self.assertEqual(result["text"], "一\n需")
        self.assertEqual(result["nextOffset"], 5)
        self.assertEqual(len(result["sha256"]), 64)
        self.add_session("duplicate", "源会话")
        self.assertEqual(self.ops.query({"action": "files", "session": "源会话"})["status"], "ambiguous")
        self.assertEqual(self.ops.query({"action": "files", "session": "source"})["items"][0]["path"], "a.md")

    async def test_foreign_shared_workspace_and_ssh_fail_closed(self):
        foreign = self.add_session("other", "foreign", "bob")
        self.assertEqual(self.ops.query({"action": "files", "session": foreign.id})["status"], "not_found")
        foreign.working_dir = self.session.working_dir
        with self.assertRaises(PermissionError):
            self.ops.query({"action": "read_file", "session": "source", "path": "a.md"})
        foreign.working_dir = str(self.root / "other")
        self.session.codex_connection_mode = "ssh"
        with self.assertRaisesRegex(ValueError, "SSH"):
            self.ops.query({"action": "files", "session": "source"})

    async def test_paths_and_collisions_are_validated_before_creation(self):
        for path in ("../x", "/x", "C:\\x", "a/../x", "a:stream", "CON.md", "x.", ".env", ".git/config"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                relative_path(path)
        for files in ([{"path": "a", "text": ""}, {"path": "A", "text": ""}],
                      [{"path": "a", "text": ""}, {"path": "a/b", "text": ""}]):
            with self.assertRaises(ValueError):
                await self.ops.prepare("origin", self.create_args(files=files))
        self.assertFalse((self.root / "new-workspaces").exists())

    async def test_symlink_and_binary_reads_are_rejected(self):
        root = Path(self.session.working_dir)
        (root / "binary").write_bytes(b"\x00\x01")
        with self.assertRaises(ValueError):
            self.ops.query({"action": "read_file", "session": "source", "path": "binary"})
        try:
            (root / "link").symlink_to(root / "a.md")
        except OSError:
            self.skipTest("创建 symlink 需要 Windows Developer Mode")
        with self.assertRaises(ValueError):
            self.ops.query({"action": "read_file", "session": "source", "path": "link"})

    async def test_prepare_is_read_only_and_commit_is_durable_idempotent(self):
        args = self.create_args()
        prepared = await self.ops.prepare("origin", args)
        root = Path(prepared["plan"]["session"]["workingDir"])
        self.assertFalse(root.exists())
        self.assertEqual(len(self.ops.sessions()), 1)
        self.assertEqual(await self.ops.prepare("origin", args), prepared)
        with self.assertRaises(ValueError):
            await self.ops.commit("origin", args["requestId"], "wrong-fingerprint")
        first = await self.ops.commit("origin", args["requestId"], prepared["fingerprint"])
        self.assertEqual(first["status"], "succeeded")
        self.assertTrue(first["receipt"]["verified"])
        self.assertEqual((root / "requirements/01.md").read_text(encoding="utf-8"), "# 需求一")
        self.assertEqual(len(self.ops.sessions()), 2)
        self.assertEqual(self.bridge._session_store.load(first["receipt"]["session"]["id"]).messages, [])
        recreated = WorkspaceOperations(self.bridge)
        self.assertEqual(await recreated.commit("origin", args["requestId"], prepared["fingerprint"]), first)
        self.assertEqual(recreated.status("origin", args["requestId"]), first)
        with self.assertRaises(ValueError):
            await recreated.prepare("origin", self.create_args(title="changed"))
        other = _REQUEST_OWNER_ID.set("bob")
        try:
            self.assertEqual(recreated.status("origin", args["requestId"])["status"], "not_found")
        finally:
            _REQUEST_OWNER_ID.reset(other)

    async def test_append_never_overwrites_and_rechecks_plan(self):
        args = {"action": "write_files", "session": "source", "requestId": "append",
                "files": [{"path": "b.md", "text": "new"}]}
        prepared = await self.ops.prepare("origin", args)
        path = Path(self.session.working_dir) / "b.md"
        path.write_text("user work", encoding="utf-8")
        with self.assertRaises(ValueError):
            await self.ops.commit("origin", "append", prepared["fingerprint"])
        self.assertEqual(path.read_text(), "user work")
        self.assertEqual(self.ops.status("origin", "append")["status"], "prepared")

    async def test_backend_disabled_after_preview_blocks_creation(self):
        prepared = await self.ops.prepare("origin", self.create_args())
        self.bridge._backend_configs[0].enabled = False
        with self.assertRaises(ValueError):
            await self.ops.commit("origin", "split-001", prepared["fingerprint"])
        self.assertFalse(Path(prepared["plan"]["session"]["workingDir"]).exists())

    async def test_interrupted_atomic_write_can_resume_without_new_session(self):
        prepared = await self.ops.prepare("origin", self.create_args())
        original = os.link
        count = 0
        def interrupted(source, target):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("simulated interruption")
            original(source, target)
        with patch("src.backend.workspace_tools.os.link", side_effect=interrupted), self.assertRaises(RuntimeError):
            await self.ops.commit("origin", "split-001", prepared["fingerprint"])
        status = self.ops.status("origin", "split-001")
        self.assertEqual(status["status"], "writing")
        self.assertEqual(len(self.ops.sessions()), 1)
        resumed = await WorkspaceOperations(self.bridge).commit("origin", "split-001", prepared["fingerprint"])
        self.assertEqual(resumed["status"], "succeeded")
        self.assertEqual(len(self.ops.sessions()), 2)
        self.assertEqual(list(Path(resumed["receipt"]["session"]["workingDir"]).rglob(".awu-new-*")), [])

    def gateway(self, skip_permissions=False):
        client = _Client("alice")
        self.bridge._clients.add(client)
        service = self.bridge._chat_workspace_tools = ChatWorkspaceTools(self.bridge)
        token = service.issue("source", "assistant", client, skip_permissions=skip_permissions)
        return service, token, client

    async def test_current_session_skip_setting_writes_and_verifies_without_extra_gate(self):
        service, token, _ = self.gateway(skip_permissions=True)
        args = self.create_args(action="write_files", session="源会话")
        async def route(_lease, phase, payload):
            result = (await self.ops.prepare("session:source", payload) if phase == "prepare"
                      else await self.ops.commit("session:source", payload["requestId"], payload["fingerprint"]))
            return {**result, "node": {"id": "relay:alice:work", "isCurrent": True, "isDefault": False}}
        service._request = AsyncMock(side_effect=route)
        self.bridge._await_permission_grant = AsyncMock(return_value=False)
        result = await service.call(token, args)
        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(result["receipt"]["verified"])
        self.assertEqual((Path(self.session.working_dir) / "requirements/01.md").read_text(encoding="utf-8"), "# 需求一")
        self.bridge._await_permission_grant.assert_not_awaited()
        # 同一批重试只有回执，不再写入或弹卡。
        self.assertEqual((await service.call(token, args))["status"], "succeeded")
        self.assertEqual([c.args[1] for c in service._request.call_args_list], ["prepare", "commit", "prepare"])

    async def test_skip_rest_only_applies_to_current_node_and_session(self):
        service, token, _ = self.gateway()
        args = self.create_args(action="write_files", session="source")
        prepared = await self.ops.prepare("origin", args)
        current = {**prepared, "node": {"id": "work", "isCurrent": True}}
        service._request = AsyncMock(side_effect=[current, {"status": "succeeded"}])
        self.bridge._await_permission_grant = AsyncMock(return_value=True)
        self.assertEqual((await service.call(token, args))["status"], "succeeded")
        self.assertTrue(self.bridge._await_permission_grant.call_args.kwargs["allow_skip"])
        self.assertTrue(self.bridge._await_permission_grant.call_args.kwargs["require_request_id"])
        self.bridge._skip_rest_sessions.add("source")
        self.bridge._await_permission_grant.reset_mock()
        service._request.side_effect = [current, {"status": "succeeded"}]
        self.assertEqual((await service.call(token, args))["status"], "succeeded")
        self.bridge._await_permission_grant.assert_not_awaited()
        # 即便普通工具刚选择了跳过后续，也不能授权另一个 Session。
        other = {**current, "plan": {**prepared["plan"], "session": {**prepared["plan"]["session"], "id": "other"}}}
        service._request.side_effect = [other, {"status": "succeeded"}]
        self.assertEqual((await service.call(token, {**args, "requestId": "other-write"}))["status"], "succeeded")
        self.assertFalse(self.bridge._await_permission_grant.call_args.kwargs["allow_skip"])

    async def test_cross_scope_never_inherits_skip_from_names_default_or_same_path(self):
        service, token, _ = self.gateway(skip_permissions=True)
        self.bridge._skip_rest_sessions.add("source")
        args = self.create_args(action="write_files", session="source")
        prepared = await self.ops.prepare("origin", args)
        target = prepared["plan"]["session"]
        cases = [
            ({"id": "remote", "isCurrent": False, "isDefault": True}, target, "write_files"),
            ({"id": "local"}, target, "write_files"),
            ({"id": "local", "isCurrent": "true"}, target, "write_files"),
            ({"id": "local", "isCurrent": True}, {**target, "id": "same-title-other-session"}, "write_files"),
            ({"id": "local", "isCurrent": True}, {**target, "workingDir": str(self.root)}, "write_files"),
            ({"id": "local", "isCurrent": True}, target, "create_session"),
        ]
        for index, (node, session, action) in enumerate(cases):
            with self.subTest(index=index):
                result = {**prepared, "node": node, "plan": {**prepared["plan"], "action": action, "session": session}}
                service._request = AsyncMock(return_value=result)
                self.bridge._await_permission_grant = AsyncMock(return_value=False)
                response = await service.call(token, {**args, "action": action, "requestId": f"scope-{index}"})
                self.assertEqual(response["status"], "cancelled")
                self.assertFalse(self.bridge._await_permission_grant.call_args.kwargs["allow_skip"])
                service._request.assert_awaited_once()  # 拒绝后绝不能提交。

    async def test_current_session_confirmation_is_id_bound_and_supports_skip_rest(self):
        self.bridge._send_for_session = AsyncMock()
        task = asyncio.create_task(self.bridge._await_permission_grant(
            "source", "assistant", [], allow_skip=True, require_request_id=True))
        await asyncio.sleep(0)
        for request_id in ("", "stale"):
            with self.assertRaises(ValueError):
                self.bridge._rpc_grantPermission("source", True, True, request_id)
        self.assertNotIn("source", self.bridge._skip_rest_sessions)
        request_id = self.bridge._permission_gate_ids["source"]
        self.bridge._rpc_grantPermission("source", True, True, request_id)
        self.assertTrue(await task)
        self.assertIn("source", self.bridge._skip_rest_sessions)
        resolved = json.loads(self.bridge._send_for_session.call_args.args[1]["data"])
        self.assertTrue(resolved["resolved"])
        self.assertEqual(resolved["requestId"], request_id)
        with self.assertRaises(ValueError):
            self.bridge._rpc_grantPermission("source", True, True, request_id)

    async def test_disconnect_dismisses_own_gate_in_both_scopes_without_writes(self):
        self.bridge._send_for_session = AsyncMock()
        for current in (True, False):
            with self.subTest(current=current):
                service, token, client = self.gateway()
                args = self.create_args(action="write_files", session="source")
                prepared = await self.ops.prepare("origin", args)
                service._request = AsyncMock(return_value={**prepared, "node": {"id": "work", "isCurrent": current}})
                task = asyncio.create_task(service.call(token, args))
                for _ in range(200):
                    if "source" in self.bridge._permission_gates:
                        break
                    await asyncio.sleep(.01)
                self.assertIn("source", self.bridge._permission_gates)
                service.disconnect(client)
                self.assertEqual((await asyncio.wait_for(task, 1))["status"], "cancelled")
                self.assertNotIn("source", self.bridge._permission_gates)
                service._request.assert_awaited_once()

    async def test_workspace_change_after_prepare_cannot_write_stale_root(self):
        args = self.create_args(action="write_files", session="source")
        prepared = await self.ops.prepare("origin", args)
        previous = Path(self.session.working_dir)
        self.add_session("shared", "同目录会话").working_dir = str(previous)
        self.session.working_dir = str(self.root)
        with self.assertRaisesRegex(ValueError, "工作区发生变化"):
            await self.ops.commit("origin", args["requestId"], prepared["fingerprint"])
        self.assertFalse((previous / "requirements").exists())

    async def test_gateway_only_originating_client_can_answer_and_lease_expires(self):
        service, token, client = self.gateway()
        task = asyncio.create_task(service.call(token, {"action": "nodes"}))
        for _ in range(10):
            await asyncio.sleep(0)
            if client.sent: break
        request = client.sent[0]["data"]["id"]
        self.assertFalse(service.respond(_Client("alice"), request, {"status": "ok"}))
        self.assertTrue(service.respond(client, request, {"status": "ok", "nodes": []}))
        self.assertEqual((await task)["status"], "ok")
        service.disconnect(client)
        self.assertEqual((await service.call(token, {"action": "nodes"}))["status"], "unavailable")

    async def test_gateway_freezes_plan_and_requires_separate_ui_confirmation(self):
        service, token, client = self.gateway()
        prepared = await self.ops.prepare("origin", self.create_args())
        node = {"id": "node-home", "name": "home"}
        service._request = AsyncMock(side_effect=[{**prepared, "node": node}, {"status": "succeeded"}])
        self.bridge._await_permission_grant = AsyncMock(return_value=True)
        result = await service.call(token, self.create_args(node="home"))
        self.assertEqual(result["status"], "succeeded")
        self.assertFalse(self.bridge._await_permission_grant.call_args.kwargs["allow_skip"])
        commit = service._request.call_args.args
        self.assertEqual(commit[1], "commit")
        self.assertEqual(commit[2]["node"], "node-home")
        self.assertEqual(commit[2]["fingerprint"], prepared["fingerprint"])

    async def test_denial_does_not_commit(self):
        service, token, _ = self.gateway()
        prepared = await self.ops.prepare("origin", self.create_args())
        service._request = AsyncMock(return_value={**prepared, "node": {"id": "home", "name": "home"}})
        self.bridge._await_permission_grant = AsyncMock(return_value=False)
        self.assertEqual((await service.call(token, self.create_args()))["status"], "cancelled")
        service._request.assert_awaited_once()
        self.assertFalse(Path(prepared["plan"]["session"]["workingDir"]).exists())

    async def test_workspace_confirmation_rejects_stale_or_missing_ids_and_skip_rest(self):
        self.bridge._send_for_session = AsyncMock()
        task = asyncio.create_task(self.bridge._await_permission_grant("source", "assistant", [], allow_skip=False))
        await asyncio.sleep(0)
        with self.assertRaises(ValueError):
            self.bridge._rpc_grantPermission("source", True, True)
        with self.assertRaises(ValueError):
            self.bridge._rpc_grantPermission("source", True, True, "stale")
        request_id = self.bridge._permission_gate_ids["source"]
        self.bridge._rpc_grantPermission("source", True, True, request_id)
        self.assertTrue(await task)
        self.assertNotIn("source", self.bridge._skip_rest_sessions)

    async def test_http_endpoint_is_local_only_and_cannot_create_other_actions(self):
        service, token, _ = self.gateway()
        self.assertEqual((await self.bridge._route_http_api("POST", "/api/chat-workspace", b"{}", "10.1.1.1"))[0], 403)
        self.assertEqual((await self.bridge._route_http_api("GET", "/api/chat-workspace", b"{}", "127.0.0.1"))[0], 405)
        self.assertEqual((await self.bridge._route_http_api("POST", "/api/chat-workspace", b"[]", "127.0.0.1"))[0], 400)
        self.assertEqual((await self.bridge._route_http_api("POST", "/api/chat-workspace", b'{"token":"bad"}', "127.0.0.1"))[0], 403)
        result = await service.call(token, {"action": "commit", "command": "bad"})
        self.assertEqual(result["status"], "error")
        with self.assertRaises(ValueError): validate_args({"action": "write_files"})

    async def test_one_request_cannot_move_to_another_node_after_retry(self):
        service, token, _ = self.gateway()
        prepared = await self.ops.prepare("origin", self.create_args())
        result = {**prepared, "node": {"id": "home", "name": "home"}}
        service._request = AsyncMock(return_value=result)
        self.bridge._await_permission_grant = AsyncMock(return_value=False)
        self.assertEqual((await service.call(token, self.create_args()))["status"], "cancelled")
        service._request.return_value = {**result, "node": {"id": "other", "name": "other"}}
        failed = await service.call(token, self.create_args(node="other"))
        self.assertEqual(failed["status"], "error")
        self.assertIn("requestId", failed["message"])
        self.bridge._await_permission_grant.assert_awaited_once()

    async def test_gateway_restores_original_identity_for_http_callbacks(self):
        service, token, _ = self.gateway()
        async def inspect_identity(*args):
            self.assertEqual(self.bridge._current_owner_id(), "alice")
            return {"status": "ok"}
        service._request = inspect_identity
        context = _REQUEST_OWNER_ID.set("local")
        try:
            self.assertEqual((await service.call(token, {"action": "nodes"}))["status"], "ok")
        finally:
            _REQUEST_OWNER_ID.reset(context)

    async def test_revoked_lease_cannot_dispatch_even_when_client_remains_connected(self):
        service, token, client = self.gateway()
        lease = service.leases[token]
        service.revoke(token)
        result = await service._request(lease, "commit", {"node": "home", "requestId": "split", "fingerprint": "x"})
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(client.sent, [])


class WorkspaceBackendInjectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": self.temp.name})
        self.environment.start()
        self.bridge = BridgeWS()
        self.client = _Client("local", "loopback")
        self.bridge._clients.add(self.client)
        self.client_context = _REQUEST_CLIENT.set(self.client)
        self.session = Session(id="workspace-chat", title="Workspace", created_at=1, updated_at=1,
            messages=[], working_dir=self.temp.name, backend_id="fake", abilities={"kitToolsMode": "off"})
        self.bridge._active_sessions[self.session.id] = self.session

    async def asyncTearDown(self):
        from tests.test_session_user_isolation import _stop_store
        _stop_store(self.bridge._session_store)
        _REQUEST_CLIENT.reset(self.client_context)
        self.environment.stop()
        self.temp.cleanup()

    async def invoke(self, backend, enabled=True, skip_permissions=True):
        self.session.messages = [ChatMessage(id="user", role="user", content="看看节点"),
                                 ChatMessage(id="assistant", role="assistant", content="", streaming=True)]
        with patch.object(self.bridge, "_get_backend", return_value=backend), patch.object(
            self.bridge, "_collect_backend_skills", return_value=([], None)), patch.object(self.bridge._session_store, "save"):
            await self.bridge._async_send(self.session, "看看节点", None, "fake", "assistant",
                                          workspace_tools=enabled, skip_permissions=skip_permissions)

    async def test_lease_uses_effective_turn_setting_not_persisted_session_default(self):
        from src.backend.openai_compat import OpenAICompatibleBackend
        observed = []
        class Probe(OpenAICompatibleBackend):
            def __init__(inner): pass
            async def send_message(inner, **kwargs):
                observed.append(next(iter(self.bridge._chat_workspace_tools.leases.values()))["skip_permissions"])
                return {"stopReason": "end_turn"}
        self.session.skip_permissions = True
        await self.invoke(Probe(), skip_permissions=False)
        self.session.skip_permissions = False
        await self.invoke(Probe(), skip_permissions=True)
        self.assertEqual(observed, [False, True])

    async def test_api_receives_callable_tool_and_no_credentials_or_cli_prompt(self):
        from src.backend.openai_compat import OpenAICompatibleBackend
        captured = []
        class Probe(OpenAICompatibleBackend):
            def __init__(inner): pass
            async def send_message(inner, **kwargs):
                captured.append(kwargs)
                service = self.bridge._chat_workspace_tools
                service._request = AsyncMock(return_value={"status": "ok", "nodes": []})
                result = json.loads(await kwargs["on_tool_call"]("awu_workspace", {"action": "nodes"}))
                self.assertEqual(result["status"], "ok")
                return {"stopReason": "end_turn"}
        await self.invoke(Probe())
        self.assertEqual(captured[0]["extra_tools"][0]["name"], "awu_workspace")
        self.assertNotIn("/api/chat-workspace", captured[0]["content"])
        self.assertEqual(self.bridge._chat_workspace_tools.leases, {})

    async def test_resumed_qwen_gets_live_http_entry_only_on_supported_manual_turns(self):
        from src.backend.qwen_code_cli import QwenCodeSdkBackend
        captured = []
        class Probe(QwenCodeSdkBackend):
            def __init__(inner): pass
            async def send_message(inner, **kwargs):
                captured.append(kwargs)
                return {"stopReason": "end_turn", "agentSessionId": "native"}
        self.session.agent_session_id = "native"
        await self.invoke(Probe())
        self.assertIn("/api/chat-workspace", captured[-1]["content"])
        self.assertNotIn("/api/chat-workspace", json.dumps([m.to_dict() for m in self.session.messages]))
        self.assertEqual(self.bridge._chat_workspace_tools.leases, {})
        self.session.abilities["workspaceToolsMode"] = "off"
        await self.invoke(Probe())
        self.assertNotIn("/api/chat-workspace", captured[-1]["content"])
        self.session.abilities["workspaceToolsMode"] = "on"
        await self.invoke(Probe(), enabled=False)
        self.assertNotIn("/api/chat-workspace", captured[-1]["content"])
        self.session.codex_connection_mode = "ssh"
        await self.invoke(Probe())
        self.assertNotIn("/api/chat-workspace", captured[-1]["content"])


if __name__ == "__main__":
    unittest.main()

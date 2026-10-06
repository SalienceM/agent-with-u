import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from src.backend import codex_model_catalog as catalog
from src.backend.backend_store import BackendStore
from src.backend.bridge_ws import BridgeWS
from src.backend.codex_office import CodexOfficeBackend
from src.types import BackendType, ModelBackendConfig


def page(*models, cursor=None):
    return {"data": [{"id": "display-" + model, "model": model, "displayName": "名称 " + model,
                      "isDefault": True} for model in models], "nextCursor": cursor}


class PageTests(unittest.TestCase):
    def test_runtime_model_and_source_order(self):
        self.assertEqual(catalog.parse_catalog_page(page("z", "a")), (
            [{"id": "z", "label": "名称 z"}, {"id": "a", "label": "名称 a"}], None))
        self.assertEqual(catalog.parse_catalog_page({"data": [{"model": "future/x"}]}),
                         ([{"id": "future/x"}], None))

    def test_reject_invalid_and_oversized_without_echoing_data(self):
        for value in [None, {}, {"data": {}}, {"data": [None]},
                      {"data": [{"id": "not-runtime-id"}]}, page("secret x"), page("a", "a"),
                      page(*map(str, range(101))), page("x", cursor=""), page("x", cursor=3),
                      {"data": [{"model": "x", "displayName": None}]}]:
            with self.subTest(value=str(value)[:50]), self.assertRaises(catalog.CatalogError) as caught:
                catalog.parse_catalog_page(value)
            self.assertNotIn("secret", str(caught.exception))


class QueryTests(unittest.IsolatedAsyncioTestCase):
    def fake(self, results):
        conn = MagicMock()
        conn.start = AsyncMock()
        conn.request = AsyncMock(side_effect=results)
        conn.close = AsyncMock()
        return conn

    async def test_pagination_context_and_freshness(self):
        conn = self.fake([page("z", cursor="next"), page("a")])
        with patch.object(catalog, "CatalogProcess", return_value=conn) as factory:
            result = await catalog.query_codex_catalog("codex", {"CODEX_HOME": "isolated"}, ["--config", "model_provider=test"], "test-cwd")
        self.assertEqual([row["id"] for row in result["modelOptions"]], ["z", "a"])
        self.assertEqual(result["freshness"], "unknown")
        self.assertIsNone(result["upstreamUpdatedAt"])
        self.assertEqual(result["source"], "codex-app-server")
        self.assertIn("fetchedAt", result)
        self.assertEqual(factory.call_args.kwargs["env"], {"CODEX_HOME": "isolated"})
        self.assertEqual(factory.call_args.kwargs["cwd"], "test-cwd")
        self.assertIn("model_provider=test", factory.call_args.kwargs["launch_command"])
        self.assertEqual(conn.request.call_args_list[1].args[1]["cursor"], "next")
        self.assertTrue(all(call.args[0] == "model/list" for call in conn.request.call_args_list))
        conn.close.assert_awaited_once()

    async def test_complete_or_fail_and_cleanup(self):
        cases = [([page()], "empty"), ([page("a", cursor="n"), page("a")], "invalid"),
                 ([page("a", cursor="n"), page("b", cursor="n")], "incomplete"),
                 ([page("a", cursor="n"), RuntimeError("token=secret")], "unavailable"),
                 ([asyncio.TimeoutError()], "timeout"),
                 ([catalog.CatalogError("unsupported", "safe")], "unsupported")]
        for responses, code in cases:
            conn = self.fake(responses)
            with self.subTest(code=code), patch.object(catalog, "CatalogProcess", return_value=conn):
                with self.assertRaises(catalog.CatalogError) as caught:
                    await catalog.query_codex_catalog("codex", {}, [])
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("secret", str(caught.exception))
                conn.close.assert_awaited_once()

    async def test_total_timeout_start_failure_and_cancel_cleanup(self):
        conn = self.fake([])
        conn.start.side_effect = RuntimeError("secret")
        with patch.object(catalog, "CatalogProcess", return_value=conn):
            with self.assertRaises(catalog.CatalogError):
                await catalog.query_codex_catalog("codex", {}, [])
        conn.close.assert_awaited_once()
        for cancel in (False, True):
            started = asyncio.Event()
            async def wait(*args, **kwargs):
                started.set()
                await asyncio.Event().wait()
            conn = self.fake([])
            conn.request.side_effect = wait
            with patch.object(catalog, "CatalogProcess", return_value=conn), patch.object(catalog, "CATALOG_TIMEOUT", 0.05):
                task = asyncio.create_task(catalog.query_codex_catalog("codex", {}, []))
                await started.wait()
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaises(catalog.CatalogError) as caught:
                        await task
                    self.assertEqual(caught.exception.code, "timeout")
            conn.close.assert_awaited_once()

    async def test_page_and_size_budgets(self):
        for budget, limit in [("MAX_PAGES", 1), ("MAX_RESPONSE_BYTES", 1)]:
            conn = self.fake([page("a", cursor="next")])
            with patch.object(catalog, "CatalogProcess", return_value=conn), patch.object(catalog, budget, limit):
                with self.assertRaises(catalog.CatalogError):
                    await catalog.query_codex_catalog("codex", {}, [])
            conn.close.assert_awaited_once()

    async def test_protocol_only_uses_safe_error_codes_and_bounds_notifications(self):
        for code, expected in [(-32601, "unsupported"), (-32602, "unsupported"), (401, "auth"), (403, "auth"), (500, "query_failed")]:
            conn = catalog.CatalogProcess()
            conn.send = AsyncMock()
            conn._read_one = AsyncMock(return_value={"id": 1, "error": {"code": code, "message": "secret"}})
            with self.assertRaises(catalog.CatalogError) as caught:
                await conn.request("model/list", {})
            self.assertEqual(caught.exception.code, expected)
            self.assertNotIn("secret", str(caught.exception))
        for msg, expected in [({"method": "approve", "id": 2}, "unexpected_request"), ({"method": "notice"}, "limit")]:
            conn = catalog.CatalogProcess()
            conn.send = AsyncMock()
            conn._read_one = AsyncMock(return_value=msg)
            with self.assertRaises(catalog.CatalogError) as caught:
                await conn.request("model/list", {})
            self.assertEqual(caught.exception.code, expected)
            self.assertEqual(conn._queued, [])

    async def test_stderr_never_logged_or_retained(self):
        conn = catalog.CatalogProcess()
        conn.proc = MagicMock()
        conn.proc.stderr.read = AsyncMock(side_effect=[b"secret", b""])
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            await conn._read_stderr()
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(conn._stderr_tail, [])


class RpcTests(unittest.IsolatedAsyncioTestCase):
    async def test_backend_scope_readonly_runtime_and_normal_save(self):
        with tempfile.TemporaryDirectory() as directory, patch("src.backend.backend_store.paths.sub", side_effect=lambda name: Path(directory) / name):
            store = BackendStore()
            for backend_id in ["official-codex", "custom-codex"]:
                cfg = ModelBackendConfig(id=backend_id, type=BackendType.CODEX_OFFICIAL, label="Test", model="keep-model",
                    cli_path="chosen-codex", skip_permissions=False,
                    env={"CODEX_HOME": "test-only", "AGENTWITHU_CODEX_PROXY_MODE": "system"},
                    model_options=[{"id": "keep-candidate"}])
                store.save(cfg)
                bridge = BridgeWS.__new__(BridgeWS)
                bridge._backend_configs = [cfg]
                bridge._backend_store = store
                bridge._backends = {}
                bridge._require_node_update_capability = MagicMock()
                bridge._get_backend = MagicMock(side_effect=AssertionError("不得访问活动 Backend"))
                original = cfg.to_dict()
                result = {"status": "ok", "modelOptions": [{"id": "new-model"}]}
                with patch.object(catalog, "query_codex_catalog", AsyncMock(return_value=result)) as query:
                    reply = json.loads(await bridge._rpc_codexModelCatalog(backend_id))
                self.assertEqual(reply, result)
                self.assertEqual(cfg.to_dict(), original)
                self.assertEqual(BackendStore().get(backend_id).model_options, original["modelOptions"])
                args = query.call_args.args
                self.assertEqual(args[0], "chosen-codex")
                self.assertEqual(args[1]["CODEX_HOME"], "test-only")
                self.assertEqual(args[2], ["--enable", "respect_system_proxy"] + CodexOfficeBackend(cfg)._http_provider_args())
                bridge._require_node_update_capability.assert_called_once()
                bridge._get_backend.assert_not_called()
                bridge._rpc_saveBackend(json.dumps({**original, "modelOptions": reply["modelOptions"]}))
                restarted = BackendStore().get(backend_id)
                self.assertEqual(restarted.model_options, [{"id": "new-model"}])
                self.assertEqual(restarted.model, "keep-model")
                self.assertFalse(restarted.skip_permissions)

    async def test_invalid_target_and_denied_access_never_query(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = [ModelBackendConfig(id="other", type=BackendType.OPENAI_COMPATIBLE, label="Other")]
        bridge._require_node_update_capability = MagicMock()
        with patch.object(catalog, "query_codex_catalog", AsyncMock()) as query:
            for target in ["missing", "other"]:
                self.assertEqual(json.loads(await bridge._rpc_codexModelCatalog(target))["code"], "backend")
            bridge._require_node_update_capability.side_effect = PermissionError("denied")
            with self.assertRaises(PermissionError):
                await bridge._rpc_codexModelCatalog("other")
            query.assert_not_called()

    async def test_rpc_gate_and_safe_transport_errors(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._require_node_update_capability = MagicMock(side_effect=PermissionError("denied"))
        with self.assertRaises(PermissionError):
            bridge._authorize_rpc("codexModelCatalog", bridge._rpc_codexModelCatalog, ["codex"])
        bridge._require_node_update_capability = MagicMock()
        bridge._backend_configs = [ModelBackendConfig(id="codex", type=BackendType.CODEX_OFFICIAL, label="Test")]
        for error in [RuntimeError("secret"), catalog.CatalogError("timeout", "safe timeout")]:
            with patch.object(catalog, "query_codex_catalog", AsyncMock(side_effect=error)):
                response = await bridge._rpc_codexModelCatalog("codex")
            self.assertNotIn("secret", response)
            self.assertEqual(json.loads(response)["status"], "error")


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_isolated_process_cleanup_on_success_timeout_and_malformed_output(self):
        script = str(Path(__file__).parent / "fixtures" / "codex_catalog_server.py")
        for mode in ("ok", "hang", "startup-hang", "oversize", "cancel"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                # 完全独立 Python 协议进程，不执行 Codex，不继承认证变量。
                env = {key: value for key, value in os.environ.items()
                       if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"}}
                env.update(CODEX_HOME=root, HOME=root, USERPROFILE=root)
                conn = catalog.CatalogProcess(launch_command=[sys.executable, script, "hang" if mode == "cancel" else mode],
                    env=env, cwd=root, stream_limit=1024 * 1024, isolated_process_group=True)
                procs = []
                started = asyncio.Event()
                original_request = conn.request
                async def request(method, params, timeout=12):
                    if conn.proc and conn.proc not in procs:
                        procs.append(conn.proc)
                    if method == "model/list":
                        started.set()
                    return await original_request(method, params, timeout)
                conn.request = request
                output = io.StringIO()
                with patch.object(catalog, "CatalogProcess", return_value=conn), patch.object(catalog, "CATALOG_TIMEOUT", 0.3), contextlib.redirect_stderr(output):
                    task = asyncio.create_task(catalog.query_codex_catalog("unused", env, [], root))
                    if mode == "cancel":
                        await started.wait()
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await task
                    elif mode == "ok":
                        self.assertEqual((await task)["modelOptions"], [{"id": "runtime-id", "label": "Fixture"}])
                    else:
                        with self.assertRaises(catalog.CatalogError) as caught:
                            await task
                        self.assertEqual(caught.exception.code, "limit" if mode == "oversize" else "timeout")
                self.assertEqual(output.getvalue(), "")
                self.assertTrue(procs)
                self.assertTrue(all(proc.returncode is not None for proc in procs))
                self.assertIsNone(conn.proc)
                self.assertIsNone(conn._stderr_task)


if __name__ == "__main__":
    unittest.main()

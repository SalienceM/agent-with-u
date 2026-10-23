import json
import unittest
from unittest.mock import patch

import httpx

from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.bridge_ws import BridgeWS
from src.backend.poe_api import (
    POE_BALANCE_URL, POE_MODELS_URL, fetch_poe_overview, is_poe_api_base_url,
)
from src.types import BackendType, ModelBackendConfig


class PoeApiTests(unittest.IsolatedAsyncioTestCase):
    def test_poe_endpoint_detection_is_strict(self):
        self.assertTrue(is_poe_api_base_url("https://api.poe.com/v1"))
        self.assertTrue(is_poe_api_base_url("https://API.POE.COM/v1/"))
        self.assertFalse(is_poe_api_base_url("http://api.poe.com/v1"))
        self.assertFalse(is_poe_api_base_url("https://api.poe.com.evil.example/v1"))
        self.assertFalse(is_poe_api_base_url("https://api.poe.com/v1/extra"))
        self.assertFalse(is_poe_api_base_url("https://api.poe.com:444/v1"))
        self.assertFalse(is_poe_api_base_url("https://api.poe.com:not-a-port/v1"))
        self.assertFalse(is_poe_api_base_url("https://api.poe.com/v1?redirect=1"))

    async def test_model_catalog_requires_a_saved_exact_poe_backend(self):
        bridge = object.__new__(BridgeWS)
        bridge._backend_configs = [ModelBackendConfig(
            id="poe", type=BackendType.OPENAI_COMPATIBLE, label="Poe Chat",
            base_url="https://api.poe.com/v1", model="assistant",
        )]
        overview = {
            "status": "ok", "models": [{"id": "assistant"}],
            "modelCount": 1, "catalogError": "", "fetchedAt": 123,
        }
        with patch("src.backend.bridge_ws.fetch_poe_overview", return_value=overview) as fetch:
            result = json.loads(await bridge._rpc_poeModelCatalog("poe"))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["models"], [{"id": "assistant"}])
        fetch.assert_awaited_once_with("")

        bridge._backend_configs[0].base_url = "https://api.poe.com.evil.example/v1"
        with patch("src.backend.bridge_ws.fetch_poe_overview") as fetch:
            rejected = json.loads(await bridge._rpc_poeModelCatalog("poe"))
        self.assertEqual(rejected["status"], "error")
        self.assertEqual(rejected["models"], [])
        fetch.assert_not_called()

    async def test_create_loop_rejects_poe_backend_before_workspace_changes(self):
        bridge = object.__new__(BridgeWS)
        bridge._require_agent_execution_enabled = lambda: None
        bridge._backend_configs = [ModelBackendConfig(
            id="poe", type=BackendType.OPENAI_COMPATIBLE, label="Poe Chat",
            base_url="https://api.poe.com/v1", model="assistant",
        )]

        with self.assertRaisesRegex(ValueError, "Poe.*Chat"):
            await bridge._rpc_createSession("C:/unused", "poe", "loop")

    async def test_catalog_and_balance_are_combined_and_sorted(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == POE_MODELS_URL:
                self.assertNotIn("authorization", request.headers)
                return httpx.Response(200, json={"object": "list", "data": [
                    {"id": "older", "created": 1_700_000_000, "description": "Old"},
                    {"id": "newer", "created": 1_800_000_000_000, "description": "New"},
                ]})
            if str(request.url) == POE_BALANCE_URL:
                self.assertEqual(request.headers.get("authorization"), "Bearer poe-secret")
                return httpx.Response(200, json={"current_point_balance": 4321})
            return httpx.Response(404)

        result = await fetch_poe_overview(
            "poe-secret", transport=httpx.MockTransport(handler),
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["currentPointBalance"], 4321)
        self.assertEqual([item["id"] for item in result["models"]], ["newer", "older"])
        self.assertEqual(result["models"][1]["createdAt"], 1_700_000_000_000)
        self.assertEqual(result["catalogError"], "")
        self.assertEqual(result["balanceError"], "")

    async def test_missing_key_keeps_public_catalog_available(self):
        requested: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested.append(str(request.url))
            return httpx.Response(200, json={"data": [{"id": "assistant", "created": 1}]})

        result = await fetch_poe_overview("", transport=httpx.MockTransport(handler))

        self.assertEqual(requested, [POE_MODELS_URL])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["modelCount"], 1)
        self.assertIsNone(result["currentPointBalance"])
        self.assertIn("API Key", result["balanceError"])

    async def test_balance_failure_does_not_hide_catalog(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == POE_MODELS_URL:
                return httpx.Response(200, json={"data": [{"id": "assistant", "created": 1}]})
            return httpx.Response(401, json={"detail": "Invalid token"})

        result = await fetch_poe_overview("bad", transport=httpx.MockTransport(handler))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["modelCount"], 1)
        self.assertIsNone(result["currentPointBalance"])
        self.assertIn("HTTP 401", result["balanceError"])
        self.assertNotIn("bad", result["balanceError"])

    async def test_poe_chat_uses_session_bot_and_never_sends_tools(self):
        captured: list[dict] = []

        class Response:
            status_code = 200
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                return None
            async def aiter_lines(self):
                yield 'data: ' + json.dumps({"choices": [{"delta": {"content": "ok"}}]})
                yield 'data: [DONE]'

        class Client:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                return None
            def stream(self, _method, _url, *, json, headers):
                captured.append(json)
                return Response()

        backend = OpenAICompatibleBackend(ModelBackendConfig(
            id="poe", type=BackendType.OPENAI_COMPATIBLE, label="Poe Chat",
            base_url="https://api.poe.com/v1", model="assistant", api_key="secret",
        ))
        tool_called = False

        async def on_tool_call(_name, _args):
            nonlocal tool_called
            tool_called = True
            return "should not run"

        with patch("src.backend.openai_compat.httpx.AsyncClient", return_value=Client()), \
             patch("src.backend.openai_compat.print"):
            await backend.send_message(
                [], "hello", None, "session", "message", lambda _delta: None,
                model_override="GPT-Official-Bot",
                extra_tools=[{"name": "danger", "description": "", "input_schema": {}}],
                on_tool_call=on_tool_call,
            )

        self.assertEqual(captured[0]["model"], "GPT-Official-Bot")
        self.assertNotIn("tools", captured[0])
        self.assertFalse(tool_called)


if __name__ == "__main__":
    unittest.main()

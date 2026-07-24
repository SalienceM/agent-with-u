import json
import time
import unittest

from src.backend.bridge_ws import BridgeWS
from src.backend.codex_office import CodexOfficeBackend
from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.types import BackendType, ModelBackendConfig, Session


class _Store:
    def __init__(self):
        self.saved = None

    def load(self, _session_id):
        return None

    def save(self, session, async_=False):
        self.saved = session


class SessionRuntimeTests(unittest.TestCase):
    def _config(self, backend_type):
        return ModelBackendConfig(id="backend", label="Backend", type=backend_type)

    def _session(self, backend_type):
        return Session(
            id="session", title="test", created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=".", backend_id="backend",
            agent_session_id="native-thread-id",
        ), self._config(backend_type)

    def test_runtime_update_preserves_native_context(self):
        session, config = self._session(BackendType.CODEX_OFFICIAL)
        bridge = object.__new__(BridgeWS)
        bridge._active_sessions = {session.id: session}
        bridge._backend_configs = [config]
        bridge._session_store = _Store()
        bridge._emit_session_updated = lambda _payload: None

        result = json.loads(bridge._rpc_updateSessionRuntime(
            session.id, json.dumps({"model": "gpt-next", "reasoningEffort": "high"})
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(session.agent_session_id, "native-thread-id")
        self.assertEqual(session.model_override, "gpt-next")
        self.assertEqual(session.reasoning_effort, "high")
        self.assertIs(bridge._session_store.saved, session)

    def test_qwen_accepts_model_but_drops_codex_effort(self):
        session, config = self._session(BackendType.QWEN_CODE_CLI)
        bridge = object.__new__(BridgeWS)
        bridge._active_sessions = {session.id: session}
        bridge._backend_configs = [config]
        bridge._session_store = _Store()
        bridge._emit_session_updated = lambda _payload: None

        result = json.loads(bridge._rpc_updateSessionRuntime(
            session.id, json.dumps({"model": "qwen-next", "reasoningEffort": "high"})
        ))

        self.assertEqual(result["runtime"], {"model": "qwen-next"})
        self.assertEqual(session.agent_session_id, "native-thread-id")
        self.assertIsNone(session.reasoning_effort)

    def test_runtime_kwargs_are_backend_specific(self):
        qwen = QwenCodeSdkBackend(self._config(BackendType.QWEN_CODE_CLI))
        qwen_kwargs = {}
        BridgeWS._add_runtime_kwargs(
            qwen, qwen_kwargs, {"model": "qwen-next", "reasoningEffort": "high"}
        )
        self.assertEqual(qwen_kwargs, {"model_override": "qwen-next"})

        codex = CodexOfficeBackend(self._config(BackendType.CODEX_OFFICIAL))
        codex_kwargs = {}
        BridgeWS._add_runtime_kwargs(
            codex, codex_kwargs, {"model": "gpt-next", "reasoningEffort": "high"}
        )
        self.assertEqual(codex_kwargs["model_override"], "gpt-next")
        self.assertEqual(codex_kwargs["reasoning_effort"], "high")


if __name__ == "__main__":
    unittest.main()

import json
import time
import unittest

from src.backend.bridge_ws import BridgeWS
from src.backend.codex_office import CodexOfficeBackend
from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.backend.codex_reasoning import normalize_reasoning_effort
from src.backend.loop_store import LoopPolicy
from src.types import BackendType, ModelBackendConfig, Session


class _Store:
    def __init__(self):
        self.saved = None

    def load(self, _session_id):
        return None

    def save(self, session, async_=False):
        self.saved = session


class SessionRuntimeTests(unittest.TestCase):
    def test_dynamic_effort_survives_session_loop_and_cli(self):
        runtime = {"model": "native-next", "reasoningEffort": "ultra"}
        self.assertEqual(LoopPolicy._clean_runtime(runtime), runtime)
        session, cfg = self._session(BackendType.CODEX_OFFICIAL)
        session.reasoning_effort = "ultra"
        session.model_override = "native-next"
        self.assertEqual(BridgeWS._session_runtime(session), runtime)
        bridge = object.__new__(BridgeWS)
        bridge._backend_configs = [cfg]
        bridge._active_sessions = {session.id: session}
        bridge._session_store = _Store()
        bridge._emit_session_updated = lambda _payload: None
        self.assertEqual(json.loads(bridge._rpc_updateSessionRuntime(session.id, json.dumps(runtime)))["runtime"], runtime)
        self.assertEqual(bridge._resolved_runtime(cfg.id, runtime), runtime)
        kwargs = {}
        backend = CodexOfficeBackend(cfg)
        BridgeWS._add_runtime_kwargs(backend, kwargs, runtime)
        self.assertEqual(kwargs["reasoning_effort"], "ultra")
        command = backend._build_cmd(codex_cli="codex", prompt="test", model="native-next",
            approval_mode="never", sandbox_mode="read-only", agent_session_id=None,
            output_path=None, image_paths=[], stdin_mode=False, reasoning_effort="ultra")
        self.assertIn("model_reasoning_effort=ultra", command)
        for invalid in [None, {}, "", "a" * 65, 'high"', "high;cmd", "high\ncmd", "--config"]:
            self.assertEqual(normalize_reasoning_effort(invalid), "")

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

    def test_qwen_inside_codex_attached_session_never_gets_codex_transport_kwargs(self):
        qwen = QwenCodeSdkBackend(self._config(BackendType.QWEN_CODE_CLI))
        attached = Session(
            id="attached", title="attached", created_at=1, updated_at=1,
            messages=[], working_dir=".", backend_id="codex",
            codex_connection_mode="node", codex_remote_host="devbox",
            codex_thread_attached=True,
        )
        kwargs = {}

        BridgeWS._add_runtime_kwargs(
            qwen, kwargs, {"model": "qwen-next"}, attached,
        )

        self.assertEqual(kwargs, {"model_override": "qwen-next"})
        self.assertNotIn("app_server_local", kwargs)
        self.assertNotIn("remote_host", kwargs)


if __name__ == "__main__":
    unittest.main()

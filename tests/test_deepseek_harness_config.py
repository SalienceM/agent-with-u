"""配置/注册测试不安装 SDK，不启动 runtime，不访问真实用户数据。"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from src.backend.backend_store import BackendStore
from src.backend.bridge_ws import BridgeWS
from src.types import BackendType, ModelBackendConfig


class HarnessConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-config-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        patcher = patch.dict("os.environ", {"AGENT_WITH_U_DATA_ROOT": str(root)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = BackendStore()
        self.config = ModelBackendConfig(
            id="harness", type=BackendType.DEEPSEEK_HARNESS, label="Harness",
            api_key="fixture-only", base_url="http://127.0.0.1:1", model="manual-model",
            model_options=[{"id": "manual-model", "label": "手工候选"}],
            harness_provider="deepseek-official", harness_permission_mode="read-only",
            harness_max_tokens=4321, skip_permissions=False,
            mcp_servers={"fixture": {"command": "fake", "args": ["--offline"]}},
        )

    def test_roundtrip_restart_export_import_and_bridge(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_store, bridge._backend_configs, bridge._backends = self.store, [], {}
        bridge._rpc_saveBackend(json.dumps(self.config.to_dict()))
        self.assertEqual(BackendStore().get("harness"), self.config)
        exported = self.store.export_json()
        self.store.delete("harness")
        self.store.import_configs(exported)
        self.assertEqual(self.store.get("harness"), self.config)
        for options in (None, [], [{"id": "unlisted"}]):
            payload = dict(self.config.to_dict(), modelOptions=options)
            bridge._rpc_saveBackend(json.dumps(payload))
            payload.pop("modelOptions")
            bridge._rpc_saveBackend(json.dumps(payload))
            self.assertEqual(BackendStore().get("harness").model_options, options)

    def test_invalid_fields_rejected_atomically(self) -> None:
        self.store.save(self.config)
        before = self.store._config_path.read_bytes()
        for changes in ({"harness_permission_mode": "yolo"}, {"harness_provider": "unknown"},
                        {"harness_max_tokens": True}, {"cli_path": "dsh --danger"},
                        {"env": {"DSH_HOME": "other-user"}}, {"env": {"NODE_OPTIONS": "--import evil"}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.store.save(replace(self.config, **changes))
            self.assertEqual(self.store._config_path.read_bytes(), before)

    def test_factory_and_compat_exports_do_not_import_optional_sdk(self) -> None:
        # 新解释器主动禁止 SDK/runtime 的导入，证明旧后端及新类型发现不依赖它们。
        source = '''
import sys
class NoSdk:
    def find_spec(self, name, *args):
        if name.startswith(('deepseek_harness', 'deepseek_harness_runtime')):
            raise AssertionError('optional SDK eagerly imported')
sys.meta_path.insert(0, NoSdk())
from src.backend.backends import DeepSeekHarnessBackend, create_backend
from src.types import BackendType, ModelBackendConfig
for kind in BackendType:
    backend = create_backend(ModelBackendConfig(id=kind.value, type=kind, label='test'))
    assert backend is not None
assert isinstance(create_backend(ModelBackendConfig(id='dsh', type=BackendType.DEEPSEEK_HARNESS, label='test')), DeepSeekHarnessBackend)
assert DeepSeekHarnessBackend(ModelBackendConfig(id='dsh', type=BackendType.DEEPSEEK_HARNESS, label='test')).follow_up_capabilities() == dict(queue=True, nativeSteer=False, interruptResume=False, steerAttachments=False)
'''
        result = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()

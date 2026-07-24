import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.backend_store import BackendStore
from src.backend.bridge_ws import BridgeWS
from src.types import BackendType, ModelBackendConfig


class BackendEnabledTests(unittest.TestCase):
    def test_legacy_config_defaults_to_enabled_and_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_dir = root / "backends"
            backend_dir.mkdir()
            (backend_dir / "config.json").write_text(
                json.dumps([{
                    "id": "legacy",
                    "type": "openai-compatible",
                    "label": "Legacy",
                }]),
                encoding="utf-8",
            )

            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                self.assertTrue(store.get("legacy").enabled)

                store.save(ModelBackendConfig(
                    id="sleeping",
                    type=BackendType.OPENAI_COMPATIBLE,
                    label="Sleeping",
                    enabled=False,
                ))
                saved = json.loads((backend_dir / "config.json").read_text(encoding="utf-8"))
                self.assertFalse(next(item for item in saved if item["id"] == "sleeping")["enabled"])

    def test_daily_list_hides_disabled_but_manager_list_includes_it(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = [
            ModelBackendConfig(
                id="active",
                type=BackendType.OPENAI_COMPATIBLE,
                label="Active",
            ),
            ModelBackendConfig(
                id="sleeping",
                type=BackendType.OPENAI_COMPATIBLE,
                label="Sleeping",
                enabled=False,
            ),
        ]

        daily = json.loads(bridge._rpc_getBackends())
        manager = json.loads(bridge._rpc_getBackends(True))

        self.assertEqual([item["id"] for item in daily], ["active"])
        self.assertEqual([item["id"] for item in manager], ["active", "sleeping"])
        self.assertFalse(manager[1]["enabled"])


if __name__ == "__main__":
    unittest.main()

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

    def test_qwen_token_limits_round_trip_with_backend_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "backends").mkdir()
            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                store.save(ModelBackendConfig(
                    id="enterprise-qwen",
                    type=BackendType.QWEN_CODE_CLI,
                    label="Enterprise Qwen",
                    qwen_context_window_size=135168,
                    qwen_max_output_tokens=32768,
                ))
                reloaded = BackendStore().get("enterprise-qwen")

            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded.qwen_context_window_size, 135168)
            self.assertEqual(reloaded.qwen_max_output_tokens, 32768)
            payload = reloaded.to_dict()
            self.assertEqual(payload["qwenContextWindowSize"], 135168)
            self.assertEqual(payload["qwenMaxOutputTokens"], 32768)

    def test_selective_export_contains_only_requested_backends_and_qwen_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "backends").mkdir()
            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                store.save(ModelBackendConfig(
                    id="plain",
                    type=BackendType.OPENAI_COMPATIBLE,
                    label="Plain",
                ))
                store.save(ModelBackendConfig(
                    id="enterprise-qwen",
                    type=BackendType.QWEN_CODE_CLI,
                    label="Enterprise Qwen",
                    qwen_context_window_size=135168,
                    qwen_max_output_tokens=32768,
                ))
                payload = json.loads(store.export_json(["enterprise-qwen"]))

            self.assertEqual(payload["format"], "agent-with-u-backends")
            self.assertEqual(payload["version"], 1)
            self.assertEqual([item["id"] for item in payload["backends"]], ["enterprise-qwen"])
            self.assertEqual(payload["backends"][0]["qwenContextWindowSize"], 135168)
            self.assertEqual(payload["backends"][0]["qwenMaxOutputTokens"], 32768)

    def test_selective_import_merges_and_supports_skip_overwrite_and_protected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "backends").mkdir()
            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                store.save(ModelBackendConfig(
                    id="keep",
                    type=BackendType.OPENAI_COMPATIBLE,
                    label="Keep Existing",
                    model="old-model",
                ))
                store.save(ModelBackendConfig(
                    id="official-codex",
                    type=BackendType.CODEX_OFFICIAL,
                    label="Codex 官方账户",
                    model="safe-model",
                ))
                content = json.dumps({
                    "format": "agent-with-u-backends",
                    "version": 1,
                    "backends": [
                        {
                            "id": "keep", "type": "openai-compatible",
                            "label": "Imported Keep", "model": "new-model",
                        },
                        {
                            "id": "new-qwen", "type": "qwen-code-cli",
                            "label": "New Qwen", "qwenContextWindowSize": 135168,
                            "qwenMaxOutputTokens": 32768,
                        },
                        {
                            "id": "official-codex", "type": "codex-office",
                            "label": "Malicious Replacement", "model": "unsafe-model",
                        },
                    ],
                })

                preview = store.preview_import(
                    content,
                    protected_ids={"official-codex"},
                )
                by_id = {item["id"]: item for item in preview}
                self.assertTrue(by_id["keep"]["conflict"])
                self.assertFalse(by_id["new-qwen"]["conflict"])
                self.assertTrue(by_id["official-codex"]["protected"])

                skipped = store.import_configs(
                    content,
                    selected_ids=["keep", "new-qwen", "official-codex"],
                    conflict_policy="skip",
                    protected_ids={"official-codex"},
                )
                self.assertEqual(skipped["added"], 1)
                self.assertEqual(skipped["skipped"], 1)
                self.assertEqual(skipped["protected"], 1)
                self.assertEqual(store.get("keep").label, "Keep Existing")
                self.assertEqual(store.get("official-codex").model, "safe-model")
                self.assertEqual(store.get("new-qwen").qwen_context_window_size, 135168)

                overwritten = store.import_configs(
                    content,
                    selected_ids=["keep"],
                    conflict_policy="overwrite",
                    protected_ids={"official-codex"},
                )
                self.assertEqual(overwritten["overwritten"], 1)
                self.assertEqual(store.get("keep").label, "Imported Keep")
                self.assertEqual(store.get("new-qwen").label, "New Qwen")
                self.assertEqual(store.get("official-codex").model, "safe-model")

    def test_invalid_import_is_atomic_and_does_not_partially_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_dir = root / "backends"
            backend_dir.mkdir()
            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                store.save(ModelBackendConfig(
                    id="existing",
                    type=BackendType.OPENAI_COMPATIBLE,
                    label="Existing",
                ))
                before = (backend_dir / "config.json").read_bytes()
                invalid = json.dumps([
                    {"id": "valid-first", "type": "openai-compatible", "label": "Valid"},
                    {"id": "broken", "type": "not-a-backend", "label": "Broken"},
                ])

                with self.assertRaises(ValueError):
                    store.import_configs(invalid, conflict_policy="overwrite")

                self.assertEqual((backend_dir / "config.json").read_bytes(), before)
                self.assertEqual([config.id for config in store.list()], ["existing"])

    def test_bridge_backend_import_rpc_updates_runtime_snapshot_without_clearing_others(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "backends").mkdir()
            with patch("src.backend.backend_store.paths.sub", side_effect=lambda name: root / name):
                store = BackendStore()
                existing = ModelBackendConfig(
                    id="existing",
                    type=BackendType.OPENAI_COMPATIBLE,
                    label="Existing",
                )
                store.save(existing)
                bridge = BridgeWS.__new__(BridgeWS)
                bridge._backend_store = store
                bridge._backend_configs = [existing]
                bridge._backends = {"existing": object()}
                content = json.dumps([{
                    "id": "imported",
                    "type": "anthropic-api",
                    "label": "Imported",
                }])

                result = json.loads(bridge._rpc_importBackends(
                    content,
                    json.dumps(["imported"]),
                    "skip",
                ))

                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["added"], 1)
                self.assertEqual(
                    [config.id for config in bridge._backend_configs],
                    ["existing", "imported"],
                )


if __name__ == "__main__":
    unittest.main()

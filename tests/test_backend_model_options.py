import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from src.backend.backend_store import BackendStore
from src.backend.bridge_ws import BridgeWS
from src.model_options import normalize_model_options
from src.types import BackendType, ModelBackendConfig


class ModelOptionsTests(unittest.TestCase):
    def test_normalization_and_independent_copies(self):
        self.assertIsNone(normalize_model_options(None))
        self.assertEqual(normalize_model_options([]), [])
        source = [{"id": " vendor/future:fast ", "label": " 常用 "}, {"id": "UPPER", "label": " "}]
        expected = [{"id": "vendor/future:fast", "label": "常用"}, {"id": "UPPER"}]
        self.assertEqual(normalize_model_options(source), expected)
        normalized = normalize_model_options(source)
        normalized[0]["id"] = "changed"
        self.assertEqual(source[0]["id"], " vendor/future:fast ")
        self.assertEqual(len(normalize_model_options([{"id": str(i)} for i in range(100)])), 100)
        self.assertEqual(normalize_model_options([{"id": "x" * 200, "label": "名" * 120}])[0]["label"], "名" * 120)
        self.assertEqual(len(normalize_model_options([{"id": "a", "label": "同名"}, {"id": "A", "label": "同名"}])), 2)

    def test_invalid_data_rejected_without_coercion(self):
        for value in [False, {}, "x", [None], ["x"], [{}], [{"id": 3}], [{"id": " "}],
                      [{"id": "a b"}], [{"id": "a\u0085b"}], [{"id": "a\x00b"}],
                      [{"id": "a", "label": None}], [{"id": "a", "label": "a\x7fb"}],
                      [{"id": "x" * 201}], [{"id": "a", "label": "x" * 121}],
                      [{"id": "a"}, {"id": " a "}], [{"id": str(i)} for i in range(101)],
                      [{"id": "a", "extra": True}]]:
            with self.subTest(value=repr(value)[:80]), self.assertRaises(ValueError):
                normalize_model_options(value)


class ModelOptionsStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        patcher = patch("src.backend.backend_store.paths.sub", side_effect=lambda name: self.root / name)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = BackendStore()
        self.config = ModelBackendConfig(
            id="codex", type=BackendType.CODEX_OFFICIAL, label="Codex",
            model="unlisted-running-model", skip_permissions=False,
            model_options=[{"id": "future/b", "label": "次选"}, {"id": "future/a"}],
        )
        self.store.save(self.config)
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._backend_store = self.store
        self.bridge._backend_configs = self.store.list()
        self.bridge._backends = {}

    def test_restart_export_and_import_three_states(self):
        for options in [self.config.model_options, [], None]:
            with self.subTest(options=options):
                self.store.save(replace(self.config, model_options=options))
                restarted = BackendStore()
                self.assertEqual(restarted.get("codex").model_options, options)
                exported = restarted.export_json()
                self.assertEqual(json.loads(exported)["backends"][0]["modelOptions"], options)
                self.store.delete("codex")
                self.store.import_configs(exported)
                self.assertEqual(self.store.get("codex").model_options, options)
        legacy = {"id": "legacy", "type": "codex-office", "label": "Legacy"}
        self.store.import_configs(json.dumps([legacy]))
        self.assertIsNone(BackendStore().get("legacy").model_options)

    def test_save_normalizes_without_mutating_source(self):
        source = replace(self.config, model_options=[{"id": " x ", "label": " "}])
        self.store.save(source)
        self.assertEqual(self.store.get("codex").model_options, [{"id": "x"}])
        self.assertEqual(source.model_options, [{"id": " x ", "label": " "}])

    def test_atomic_validation_and_disk_failure(self):
        before = self.store._config_path.read_bytes()
        existing = self.store.get("codex").to_dict()
        with self.assertRaises(ValueError):
            self.store.save(replace(self.config, model_options=[{"id": ""}]))
        with patch("src.backend.backend_store.os.replace", side_effect=OSError("test disk failure")):
            with self.assertRaises(OSError):
                self.store.save(replace(self.config, model_options=[]))
            with self.assertRaises(OSError):
                self.store.import_configs(json.dumps([dict(self.config.to_dict(), modelOptions=[])]))
        self.assertEqual(self.store._config_path.read_bytes(), before)
        self.assertEqual(self.store.get("codex").to_dict(), existing)

    def test_rpc_fixed_and_ordinary_missing_null_empty_and_failure(self):
        for config_id in ["codex", "official-codex"]:
            with self.subTest(config_id=config_id):
                payload = dict(self.config.to_dict(), id=config_id)
                self.bridge._rpc_saveBackend(json.dumps(payload))
                payload.pop("modelOptions")
                payload["label"] = "Renamed"
                self.bridge._rpc_saveBackend(json.dumps(payload))
                self.assertEqual(self.store.get(config_id).model_options, self.config.model_options)
                for options in [[], None, [{"id": "newer"}]]:
                    payload["modelOptions"] = options
                    self.bridge._rpc_saveBackend(json.dumps(payload))
                    saved = self.store.get(config_id)
                    self.assertEqual(saved.model_options, options)
                    self.assertEqual(saved.model, self.config.model)
                    self.assertFalse(saved.skip_permissions)
                    listed = next(c for c in json.loads(self.bridge._rpc_getBackends()) if c["id"] == config_id)
                    self.assertEqual(listed["modelOptions"], options)
                before = self.store._config_path.read_bytes()
                snapshot = [c.to_dict() for c in self.bridge._backend_configs]
                payload["modelOptions"] = [{"id": ""}]
                with self.assertRaises(ValueError):
                    self.bridge._rpc_saveBackend(json.dumps(payload))
                payload["modelOptions"] = []
                with patch.object(self.store, "_write_configs", side_effect=OSError("test")):
                    with self.assertRaises(OSError):
                        self.bridge._rpc_saveBackend(json.dumps(payload))
                self.assertEqual([c.to_dict() for c in self.bridge._backend_configs], snapshot)
                self.assertEqual(self.store._config_path.read_bytes(), before)

    def test_import_presence_protection_and_skip(self):
        legacy = self.config.to_dict()
        legacy.pop("modelOptions")
        self.store.import_configs(json.dumps([legacy]))
        self.assertEqual(self.store.get("codex").model_options, self.config.model_options)
        explicit = dict(legacy, modelOptions=[])
        self.store.import_configs(json.dumps([explicit]), conflict_policy="skip")
        self.assertEqual(self.store.get("codex").model_options, self.config.model_options)
        for options in [[], None]:
            self.store.import_configs(json.dumps([dict(legacy, modelOptions=options)]))
            self.assertEqual(self.store.get("codex").model_options, options)
        self.store.save(replace(self.config, id="official-codex"))
        result = self.store.import_configs(json.dumps([dict(explicit, id="official-codex")]), protected_ids={"official-codex"})
        self.assertEqual(result["protected"], 1)
        self.assertEqual(self.store.get("official-codex").model_options, self.config.model_options)
        self.store.save(self.config)
        self.store.import_configs(json.dumps([dict(legacy, type="openai-compatible")]))
        self.assertIsNone(self.store.get("codex").model_options)

    def test_invalid_import_does_not_partially_merge(self):
        before = self.store._config_path.read_bytes()
        with self.assertRaises(ValueError):
            self.store.import_configs(json.dumps([
                dict(self.config.to_dict(), id="new"),
                dict(self.config.to_dict(), modelOptions=[{"id": "a"}, {"id": "a"}]),
            ]))
        self.assertIsNone(self.store.get("new"))
        self.assertEqual(self.store._config_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

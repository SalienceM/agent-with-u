"""静态资源契约与定位测试；假清单不构成 Linux/frozen 运行验收。"""
from __future__ import annotations

import ast
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

from scripts import harness_image_resources as build
from scripts import prepare_harness_bundle as prepare
from src.backend import deepseek_harness_distribution as bundle
from src.backend.deepseek_harness_image_contract import image_resource_contract
from src.backend.deepseek_harness_images import MAX_REQUEST_BYTES, encode_frame
from src.backend.deepseek_harness_sdk import bridge_path

ROOT = Path(__file__).resolve().parents[1]


def fake_bridge(folder: Path) -> dict:
    """生成显式 fixture，不把假资源写入真实 build 或发行清单。"""
    (folder / "lib").mkdir(parents=True)
    (folder / "lib/index.mjs").write_text("// isolated fixture, not a runtime\n", encoding="utf-8")
    (folder / "package.json").write_text(json.dumps({"name": "@agentwithu/deepseek-harness-bridge",
        "version": bundle.RUNTIME_VERSION}), encoding="utf-8")
    for name in ("UPSTREAM-LICENSE", "THIRD_PARTY_NOTICES.md"):
        (folder / name).write_text("fixture license only\n", encoding="utf-8")
    record = {"schema": 1, "contract": image_resource_contract(), "resources": {
        name: {"sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest(), "executable": False}
        for name in bundle.BRIDGE_RESOURCE_NAMES}}
    save_record(folder, record)
    return record


def save_record(folder: Path, record: dict) -> None:
    (folder / bundle.IMAGE_CONTRACT_FILE).write_text(json.dumps(record), encoding="utf-8")


class HarnessImageResourceTests(unittest.TestCase):
    def test_python_frontend_and_node_source_contracts_match(self) -> None:
        build.verify_frontend_contract(ROOT)
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node required for static export check (no automatic install)")
        build.verify_source_contracts(ROOT, Path(node))

    def test_frontend_drift_and_boolean_versions_fail(self) -> None:
        for mutate in (lambda value: value.update(version=True),
                       lambda value: value["limits"].update(maxFrameBytes=1024 * 1024),
                       lambda value: value["formats"].append("image/gif")):
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                file = root / "frontend/src/types/harnessImageContract.json"
                file.parent.mkdir(parents=True)
                value = image_resource_contract()
                mutate(value)
                file.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "契约不匹配"):
                    build.verify_frontend_contract(root)

    def test_missing_mixed_or_incomplete_resources_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / "bridge"
            record = fake_bridge(folder)
            entry = folder / "lib/index.mjs"
            self.assertEqual(bundle.verify_image_bridge(entry), image_resource_contract())
            for name in (*bundle.BRIDGE_RESOURCE_NAMES, bundle.IMAGE_CONTRACT_FILE):
                with self.subTest(missing=name):
                    file = folder / name
                    original = file.read_bytes()
                    file.unlink()
                    with self.assertRaisesRegex(RuntimeError, "图片资源缺失或不匹配"):
                        bundle.verify_image_bridge(entry)
                    file.write_bytes(original)
                with self.subTest(mixed=name):
                    file.write_bytes(b"different build\n")
                    with self.assertRaises(RuntimeError):
                        bundle.verify_image_bridge(entry)
                    file.write_bytes(original)
            for mutate in (lambda row: row.update(schema=True),
                           lambda row: row["contract"].update(bridgeVersion=999),
                           lambda row: row["contract"]["limits"].update(maxImages=999),
                           lambda row: row["resources"].pop("UPSTREAM-LICENSE"),
                           lambda row: row["resources"].update({"../escape": {}}),
                           lambda row: row["resources"]["lib/index.mjs"].update(executable=True)):
                bad = copy.deepcopy(record)
                mutate(bad)
                save_record(folder, bad)
                with self.assertRaises(RuntimeError):
                    bundle.verify_image_bridge(entry)

    def test_source_and_frozen_paths_share_image_gate_without_breaking_legacy_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for frozen in (False, True):
                with self.subTest(frozen=frozen), patch.object(sys, "frozen", frozen, create=True), \
                        patch.object(sys, "_MEIPASS", str(root / "extracted"), create=True), \
                        patch.object(bundle, "__file__", str(root / "src/backend/deepseek_harness_distribution.py")):
                    folder = bundle.bundle_directory() / "bridge"
                    fake_bridge(folder)
                    expected = (root / "extracted/deepseek-harness" if frozen else root / "build/deepseek-harness")
                    self.assertEqual(bundle.bundle_directory(), expected)
                    self.assertEqual(bridge_path(require_images=True), (folder / "lib/index.mjs").resolve())
                    manifest = {"schema": 1, "version": bundle.VERSION, "commit": bundle.COMMIT}
                    (expected / "bundle-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                    base, actual = bundle.bundle_manifest()
                    self.assertEqual(base, root / "extracted" if frozen else root)
                    self.assertEqual(actual, manifest)
                    (folder / bundle.IMAGE_CONTRACT_FILE).unlink()
                    self.assertEqual(bridge_path(), (folder / "lib/index.mjs").resolve())
                    with self.assertRaisesRegex(RuntimeError, "图片资源缺失或不匹配"):
                        bridge_path(require_images=True)

    def test_build_reads_actual_export_and_never_blesses_mismatch(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node required for static export check")
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / "bridge"
            fake_bridge(folder)
            marker = folder / bundle.IMAGE_CONTRACT_FILE
            marker.unlink()
            entry = folder / "lib/index.mjs"
            wrong = image_resource_contract()
            wrong["limits"]["maxPendingBytes"] = 1
            entry.write_text("export const IMAGE_RESOURCE_CONTRACT = " + json.dumps(wrong), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "契约不匹配"):
                build.write_bridge_contract(folder, Path(node))
            self.assertFalse(marker.exists())
            entry.write_text("export const IMAGE_RESOURCE_CONTRACT = " + json.dumps(image_resource_contract()), encoding="utf-8")
            build.write_bridge_contract(folder, Path(node))
            self.assertEqual(bundle.verify_image_bridge(entry), image_resource_contract())

    def test_manifest_requires_sidecar_and_failure_preserves_previous_manifest(self) -> None:
        # 只模拟 receipt/wheel 内容；真实两平台制品验证仍由原脚本执行。
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "build/deepseek-harness/bridge"
            fake_bridge(folder)
            (root / "deploy").mkdir()
            receipt = {"commit": bundle.COMMIT, "pythonVersion": bundle.VERSION,
                       "wheels": [{"filename": "missing-linux.whl"}]}
            for suffix in ("windows", "linux"):
                (root / f"deploy/deepseek-harness.build-{suffix}.json").write_text(json.dumps(receipt), encoding="utf-8")
            manifest = folder.parent / "bundle-manifest.json"
            manifest.write_text("previous manifest retained", encoding="utf-8")
            with patch.object(prepare, "ROOT", root), patch.object(prepare, "verify_frontend_contract"), \
                    patch.object(prepare, "verify_wheel", side_effect=FileNotFoundError("locked wheel unavailable")):
                with self.assertRaises(FileNotFoundError):
                    prepare.prepare()
            self.assertEqual(manifest.read_text(), "previous manifest retained")
            (folder / bundle.IMAGE_CONTRACT_FILE).unlink()
            with patch.object(prepare, "ROOT", root), patch.object(prepare, "verify_frontend_contract"), \
                    patch.object(prepare, "verify_wheel") as wheels:
                with self.assertRaises(RuntimeError):
                    prepare.prepare()
                wheels.assert_not_called()

    def test_manifest_records_contract_and_both_platforms_only_after_wheel_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "build/deepseek-harness/bridge"
            fake_bridge(folder)
            (root / "deploy").mkdir()
            wheels = folder.parent / "wheels"
            wheels.mkdir()
            for target, suffix in (("win-x64", "windows"), ("linux-x64", "linux")):
                rows = []
                for name in ("sdk-fixture.whl", f"runtime_bin-fixture-{target}.whl"):
                    path = wheels / name
                    with zipfile.ZipFile(path, "w") as archive:
                        archive.writestr("fixture/" + name + ".txt", "isolated resource fixture")
                    rows.append({"filename": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
                (root / f"deploy/deepseek-harness.build-{suffix}.json").write_text(json.dumps({
                    "commit": bundle.COMMIT, "pythonVersion": bundle.VERSION, "wheels": rows}), encoding="utf-8")
            with patch.object(prepare, "ROOT", root), patch.object(prepare, "verify_frontend_contract"), \
                    patch.object(prepare, "verify_wheel", side_effect=lambda file, *_args: {
                        "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}) as verify:
                output = prepare.prepare()
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(verify.call_count, 4)
            self.assertEqual([call.args[2] for call in verify.call_args_list], [None, "win-x64", None, "linux-x64"])
            self.assertEqual(manifest["imageContract"], image_resource_contract())
            self.assertEqual(set(manifest["platforms"]), {"win-x64", "linux-x64"})
            self.assertEqual(set(manifest["bridge"]), {"deepseek-harness/bridge/" + name
                for name in (*bundle.BRIDGE_RESOURCE_NAMES, bundle.IMAGE_CONTRACT_FILE)})

    def test_distribution_cannot_skip_image_contract(self) -> None:
        from tests.test_deepseek_harness_distribution import BundleResourceTests
        fixture = BundleResourceTests()
        fixture.setUp()
        try:
            self.assertTrue(bundle.verify_bundle())  # 原清单仍能用于旧文字路径。
            with self.assertRaisesRegex(RuntimeError, "契约不匹配"):
                bundle.verify_bundle(require_images=True)
            fixture.manifest["imageContract"] = image_resource_contract()
            with self.assertRaisesRegex(RuntimeError, "图片资源清单缺失"):
                bundle.verify_bundle()
            for frozen in (False, True):
                with self.subTest(frozen=frozen), patch.object(sys, "frozen", frozen, create=True):
                    folder = fixture.root / ("deepseek-harness/bridge" if frozen else "build/deepseek-harness/bridge")
                    fake_bridge(folder)
                    fixture.manifest["bridge"] = {"deepseek-harness/bridge/" + name: {
                        "sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest(), "executable": False}
                        for name in (*bundle.BRIDGE_RESOURCE_NAMES, bundle.IMAGE_CONTRACT_FILE)}
                    self.assertEqual(len(bundle.verify_bundle(require_images=True)), 6)
                    # 外层清单即使更新了哈希，也不能让混配的内层契约通过。
                    (folder / "lib/index.mjs").write_bytes(b"mismatched bridge")
                    fixture.manifest["bridge"]["deepseek-harness/bridge/lib/index.mjs"]["sha256"] = hashlib.sha256(b"mismatched bridge").hexdigest()
                    with self.assertRaisesRegex(RuntimeError, "图片资源缺失或不匹配"):
                        bundle.verify_bundle(require_images=True)
        finally:
            fixture.doCleanups()

    def test_pyinstaller_gate_precedes_resource_collection(self) -> None:
        from scripts.harness_pyinstaller import collect
        modules = {name: types.ModuleType(name) for name in ("PyInstaller", "PyInstaller.utils", "PyInstaller.utils.hooks")}
        hooks = modules["PyInstaller.utils.hooks"]
        hooks.collect_all = lambda name: self.fail("must not collect before the image gate")
        hooks.copy_metadata = lambda name: self.fail("must not copy metadata before the image gate")
        with patch.dict(sys.modules, modules), patch.object(bundle, "verify_adapter", side_effect=RuntimeError("unpaired")) as verify:
            with self.assertRaisesRegex(RuntimeError, "unpaired"):
                collect()
            verify.assert_called_once_with()

    def test_websocket_relay_caps_and_nested_encoding_remain_bounded(self) -> None:
        def evaluate(node: ast.AST) -> int:
            if isinstance(node, ast.Constant) and type(node.value) is int:
                return node.value
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
                return evaluate(node.left) * evaluate(node.right)
            raise AssertionError("unexpected transport limit expression")

        for file, limit in (("src/ws_main.py", 50), ("src/backend/relay.py", 64), ("src/relay_server.py", 64)):
            tree = ast.parse((ROOT / file).read_text(encoding="utf-8"))
            sizes = [evaluate(item.value) for item in ast.walk(tree) if isinstance(item, ast.keyword) and item.arg == "max_size"]
            self.assertIn(limit * 1024 * 1024, sizes)
        # 接近 12 MiB 的 Unicode/转义最坏输入；WS 参数 JSON 字符串及 Relay 再包一层。
        # 不是真图片解码测试，专门计量序列化额外层次，不修改任何传输上限。
        for char in ('\\', '"', '图'):
            width = len(json.dumps(char, ensure_ascii=False).encode()) - 2
            prompt = {"jsonrpc": "2.0", "id": "image-request", "method": "session/prompt",
                      "params": {"contentBlocks": [{"type": "text", "text": char * ((MAX_REQUEST_BYTES - 4096) // width)}]}}
            self.assertLessEqual(len(encode_frame(prompt)), MAX_REQUEST_BYTES)
            wire = json.dumps({"id": "rpc", "method": "harnessImageSubmit", "params": [json.dumps(prompt, ensure_ascii=False)]}, ensure_ascii=False)
            relay = json.dumps({"type": "rpc", "payload": wire}, ensure_ascii=False).encode("utf-8")
            self.assertLess(len(wire.encode("utf-8")), 50 * 1024 * 1024)
            self.assertLess(len(relay), 64 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()

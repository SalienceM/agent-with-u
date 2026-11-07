"""临时用户根、内存清单、惰性安装器字节和假桌面；绝不安装、退出或访问真实更新源。"""
import asyncio
import copy
import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.backend import paths
from src.backend.bridge_ws import BridgeWS
from src.backend.kit_capabilities import CHECK_UPDATE_CAPABILITY, LOCAL_UPDATE_CAPABILITIES, KitCapabilityRegistry
from src.backend.kit_update_journal import durable_json
from src.backend.kit_update_template import standalone_template, standalone_requested
from src.backend.workspace_kit_store import WorkspaceKit
from src.types import Session


class StandaloneUpdateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="awu-kit-check-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data"),
            "AGENT_WITH_U_RUNTIME": "desktop", "AGENT_WITH_U_DESKTOP_EXE": str(self.root / "desktop.exe"),
            "AGENT_WITH_U_DESKTOP_PID": "12345", "AGENT_WITH_U_UPDATE_KEY": ""})
        env.start(); self.addCleanup(env.stop)
        self.assertEqual(self.root / "data", paths.data_root().resolve())
        self.assertTrue(paths.data_root().resolve().is_relative_to(self.root))
        self.bridge = BridgeWS()
        self.manager = self.bridge._update_manager
        self.assertTrue(self.manager.root.resolve().is_relative_to(self.root))
        self.manager.configure({"manifestUrl": "https://fixture.invalid/latest.json", "channel": "stable"})
        self.session = Session(id="kit-check", title="fixture", created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=str(self.workspace), backend_id="codex-office")
        self.bridge._active_sessions[self.session.id] = self.session
        self.current = {"version": "1.0.0", "packageVersion": "1.0.0", "buildId": "old-1", "sequence": 1}
        self.desktop = AsyncMock()
        self.desktop_view = {"protocol": 1, "installed": True, "deviceId": "fixture-device", "instanceId": "fixture-instance",
            "pid": 12345, "exe": str(self.root / "desktop.exe"), "release": self.current.copy()}
        artifact = self.root / "fixture.msi"
        artifact.write_bytes(b"INERT - not an installer")
        self.document = {"schemaVersion": 1, "channel": "stable", "release": {
            "version": "2.0.0", "packageVersion": "2.0.0", "buildId": "new-2", "sequence": 2, "kitUpdateProtocol": 1},
            "artifacts": [{"id": "msi-a", "platform": "windows", "arch": "x86_64", "target": "desktop", "kind": "msi",
                "fileName": "fixture.msi", "url": str(artifact), "size": artifact.stat().st_size,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}]}
        async def read(source, **kwargs):
            self.assertEqual("https://fixture.invalid/latest.json", source)
            return json.dumps(self.document).encode()
        self.reader = AsyncMock(side_effect=read)
        patches = [patch.object(self.bridge, "_kit_desktop", side_effect=lambda: (self.desktop, copy.deepcopy(self.desktop_view))),
            patch.object(self.manager, "_read_source", self.reader),
            patch.object(self.bridge, "_published_for_update", side_effect=AssertionError("standalone cannot borrow publication"))]
        for module in ("update_manager", "kit_update_bridge"):
            patches.append(patch(f"src.backend.{module}._current_release", side_effect=lambda: self.current.copy()))
        for name, value in (("_platform", "windows"), ("_runtime", "desktop"), ("_arch", "x86_64")):
            patches.append(patch(f"src.backend.update_manager.{name}", return_value=value))
        for stub in patches:
            stub.start(); self.addCleanup(stub.stop)

    async def asyncTearDown(self):
        tasks = [*self.bridge._kit_tasks.values(), *getattr(self.bridge, "_kit_update_observers", {}).values()]
        if self.bridge._kit_scheduler_task:
            tasks.append(self.bridge._kit_scheduler_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def until(self, predicate):
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(.01)
        self.fail("fixture did not settle")

    async def run_update(self):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(standalone_template()["kit"])))
        self.assertEqual("ok", created["status"], created)
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, created["kit"]["id"]))
        self.assertEqual("ok", result["status"], result)
        run = self.bridge._kit_get(self.session.id).runs[-1]
        await self.until(lambda: run.status in {"waiting_approval", "succeeded", "failed", "error"})
        return run, run.steps[-1], run.steps[-1].config["capabilityRuntime"]

    def confirm(self, run, step, runtime):
        return self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
            runtime["planFingerprint"], "fixture-confirmation")

    async def test_standalone_freezes_and_requires_confirmation_and_actual_restart(self):
        before = self.manager.config_path.read_bytes()
        run, step, runtime = await self.run_update()
        self.assertEqual("waiting_approval", run.status, run.to_dict())
        self.assertEqual(1, len(run.steps))
        self.desktop.send.assert_not_awaited()
        record = self.manager.journal.get(runtime["installRequestId"])
        self.assertNotIn("publishedRelease", record["plan"])
        self.assertEqual("configured", record["plan"]["updateSource"]["sourceKind"])
        self.document["release"]["buildId"] = "latest-drift"
        self.document["release"]["sequence"] = 3
        self.confirm(run, step, runtime)
        await self.until(lambda: run.status == "waiting_restart")
        self.confirm(run, step, runtime)
        self.assertEqual(1, self.desktop.send.await_count)
        self.assertEqual(1, self.reader.await_count)
        self.assertEqual("cannot_cancel", json.loads(self.bridge._rpc_kitCancel(self.session.id, run.id))["status"])
        receipt = dict(protocol=1, requestId=runtime["installRequestId"], identity=runtime["identity"],
            planFingerprint=runtime["planFingerprint"], installation="succeeded", restart="started")
        durable_json(self.manager.journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertNotEqual("succeeded", run.status)
        self.current = runtime["plan"]["release"].copy()
        self.desktop_view["release"] = self.current.copy()
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertEqual("succeeded", run.status)
        self.assertFalse(self.manager.journal.active())
        self.assertEqual(before, self.manager.config_path.read_bytes())

    async def test_current_is_check_success_not_installed_or_restarted(self):
        self.document["release"] = self.current.copy()
        run, step, runtime = await self.run_update()
        self.assertEqual("succeeded", run.status, run.to_dict())
        self.assertEqual("current", runtime["phase"])
        self.assertIn("未执行安装或重启", runtime["message"])
        self.assertNotIn("receipt", runtime)
        self.assertFalse(self.manager.journal.active())
        self.assertIsNone(self.manager._task)
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertEqual("succeeded", run.status)
        self.bridge._rpc_kitUpdateReconcile(self.session.id, run.id)
        self.assertEqual("succeeded", run.status)
        self.assertEqual("current", runtime["phase"])
        self.desktop.send.assert_not_awaited()

    async def test_multiple_installers_use_original_checked_snapshot(self):
        self.document["artifacts"].append({**self.document["artifacts"][0], "id": "msi-b"})
        run, step, runtime = await self.run_update()
        self.assertEqual("needs_selection", runtime["phase"])
        self.assertIsNone(self.manager._task)
        old_fingerprint = runtime["planFingerprint"]
        self.document = {"broken": "latest changed after checking"}
        args = (self.session.id, run.id, "msi-b", old_fingerprint, "fixture-selection")
        self.bridge._rpc_kitUpdateSelect(*args)
        self.bridge._rpc_kitUpdateSelect(*args)
        await self.until(lambda: runtime["phase"] != "needs_selection" and run.status == "waiting_approval")
        self.assertEqual("waiting_approval", runtime["phase"])
        self.assertEqual("msi-b", runtime["plan"]["artifact"]["id"])
        self.assertEqual("new-2", runtime["plan"]["release"]["buildId"])
        self.assertEqual(1, self.reader.await_count)
        self.bridge._rpc_kitCancel(self.session.id, run.id)
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_confirmation_rechecks_busy_identity_and_config_without_notify(self):
        run, step, runtime = await self.run_update()
        self.bridge._seq_dispatch_reservations["busy"] = time.time() + 10
        with self.assertRaisesRegex(Exception, "序列"):
            self.confirm(run, step, runtime)
        self.bridge._seq_dispatch_reservations.clear()
        self.desktop_view["instanceId"] = "changed"
        with self.assertRaisesRegex(Exception, "实例"):
            self.confirm(run, step, runtime)
        self.desktop_view["instanceId"] = "fixture-instance"
        # 模拟文件被外部改变；常规 configure 在预留期间本就禁止修改。
        config = json.loads(self.manager.config_path.read_text(encoding="utf-8"))
        config["channel"] = "beta"
        self.manager.config_path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(Exception, "策略已变化"):
            self.confirm(run, step, runtime)
        self.desktop.send.assert_not_awaited()

    async def test_bad_hash_is_failure_not_waiting_for_approval(self):
        self.document["artifacts"][0]["sha256"] = "a" * 64
        run, step, runtime = await self.run_update()
        self.assertEqual("error", run.status)
        self.assertIn("SHA-256 mismatch", run.error)
        self.assertEqual("failed", runtime["phase"])
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_unavailable_unknown_older_wrong_channel_and_signature_fail_closed(self):
        self.current["sequence"] = 10
        self.desktop_view["release"] = self.current.copy()
        self.document["release"]["sequence"] = 20
        original = copy.deepcopy(self.document)
        variants = [("invalid-json-object", None), ("wrong-channel", {**original, "channel": "beta"}),
            ("old", {**original, "release": {**self.current, "sequence": 9}}),
            ("equal-but-different", {**original, "release": {**self.current, "buildId": "different"}}),
            ("legacy", {**original, "release": {**original["release"], "kitUpdateProtocol": 0}}),
            ("wrong-platform", {**original, "artifacts": [{**original["artifacts"][0], "platform": "linux"}]}),
            ("custom-command", {**original, "artifacts": [{**original["artifacts"][0], "install": {"program": "unsafe"}}]})]
        expected = {"invalid-json-object": "schema", "wrong-channel": "channel", "old": "早于",
                    "equal-but-different": "身份不同", "legacy": "协议", "wrong-platform": "Windows",
                    "custom-command": "自定义"}
        for name, document in variants:
            with self.subTest(name=name):
                self.document = document
                run, _, _ = await self.run_update()
                self.assertEqual("error", run.status, run.to_dict())
                self.assertIn(expected[name], run.error)
                self.assertFalse(self.manager.journal.active())
        self.document = original
        self.manager.configure({"requireSignature": True, "signatureKey": "fixture-not-a-secret"})
        run, _, _ = await self.run_update()
        self.assertEqual("error", run.status)
        self.assertIn("signature", run.error)
        self.assertIsNone(self.manager._task)
        self.desktop.send.assert_not_awaited()

    async def test_offline_or_unconfigured_is_not_no_update(self):
        with patch.object(self.manager, "_read_source", side_effect=OSError("fixture offline")):
            run, _, _ = await self.run_update()
            self.assertEqual("error", run.status)
            self.assertIn("offline", run.error)
        self.manager.configure({"manifestUrl": ""})
        run, _, _ = await self.run_update()
        self.assertEqual("error", run.status)
        self.assertIn("配置更新清单", run.error)
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_tampered_frozen_snapshot_cannot_confirm_or_select(self):
        run, step, runtime = await self.run_update()
        record = self.manager.journal.get(runtime["installRequestId"])
        record["updateSource"]["document"]["release"]["buildId"] = "tampered"
        durable_json(self.manager.journal.path(runtime["installRequestId"]), record)
        with self.assertRaisesRegex(Exception, "快照已变化"):
            self.confirm(run, step, runtime)
        self.desktop.send.assert_not_awaited()

    async def test_restarted_bridge_recovers_same_standalone_run_without_check_or_install(self):
        run, step, runtime = await self.run_update()
        self.confirm(run, step, runtime)
        await self.until(lambda: run.status == "waiting_restart")
        observers = list(self.bridge._kit_update_observers.values())
        for task in observers:
            task.cancel()
        await asyncio.gather(*observers, return_exceptions=True)
        receipt = dict(protocol=1, requestId=runtime["installRequestId"], identity=runtime["identity"],
            planFingerprint=runtime["planFingerprint"], installation="succeeded", restart="started")
        durable_json(self.manager.journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
        restarted = BridgeWS()
        restarted._active_sessions[self.session.id] = self.session
        self.current = runtime["plan"]["release"].copy()
        self.desktop_view["release"] = self.current.copy()
        with patch.object(restarted, "_kit_desktop", return_value=(self.desktop, self.desktop_view)), patch.object(
                restarted._update_manager, "_read_source", new=AsyncMock(side_effect=AssertionError("must not recheck"))):
            for _ in range(2):
                result = json.loads(restarted._rpc_kitResume(self.session.id, run.id))
                self.assertEqual("succeeded", result["run"]["status"])
                self.assertEqual(run.id, result["run"]["id"])
        self.assertEqual(1, self.reader.await_count)
        self.assertEqual(1, self.desktop.send.await_count)

    async def test_cancel_during_check_releases_only_owned_request(self):
        entered = asyncio.Event()
        async def slow(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()
        with patch.object(self.manager, "_read_source", side_effect=slow):
            created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(standalone_template()["kit"])))
            self.bridge._rpc_kitRun(self.session.id, created["kit"]["id"])
            await entered.wait()
            run = self.bridge._kit_get(self.session.id).runs[-1]
            self.bridge._rpc_kitCancel(self.session.id, run.id)
            await self.until(lambda: not self.bridge._kit_tasks.get(run.id))
        self.assertEqual("cancelled", run.status)
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_generation_and_legacy_definition_validation_no_implicit_migration(self):
        state = self.bridge._kit_get(self.session.id)
        preview = json.loads(await self.bridge._rpc_kitGenerate(self.session.id,
            json.dumps({"objective": "本机一键检查并更新"})))
        self.assertTrue(preview["ready"], preview)
        self.assertEqual(CHECK_UPDATE_CAPABILITY, preview["kit"]["steps"][0]["config"]["capability"])
        self.assertFalse(state.kits or state.runs)
        spec = standalone_template()["kit"]
        spec["steps"][0]["config"]["capability"] = "node.update_local_published"
        rejected = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
        self.assertEqual("error", rejected["status"])
        self.assertIn("bindBuild", rejected["message"])
        legacy = WorkspaceKit.from_dict({**spec, "id": "existing-misconfigured"})
        state.kits.append(legacy)
        original = legacy.to_dict()
        rejected = json.loads(self.bridge._rpc_kitRun(self.session.id, legacy.id))
        self.assertEqual("error", rejected["status"])
        self.assertIn("node.check_update_local", rejected["message"])
        self.assertEqual(original, legacy.to_dict())
        self.assertFalse(state.runs)
        self.reader.assert_not_awaited()

    async def test_arguments_schedule_and_position_guards_cover_both_capabilities(self):
        registry = KitCapabilityRegistry()
        for capability in LOCAL_UPDATE_CAPABILITIES:
            with self.assertRaises(Exception):
                registry.validate(capability, {"manifestUrl": "https://forged.invalid"})
        for mode in ("schedule", "non-last", "duplicate"):
            spec = standalone_template()["kit"]
            if mode == "schedule":
                spec["schedule"] = {"mode": "interval", "intervalSeconds": 60}
            else:
                spec["steps"].append(copy.deepcopy(spec["steps"][0]) if mode == "duplicate"
                                     else {"id": "after", "type": "command", "command": "echo forbidden"})
            rejected = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
            self.assertEqual("error", rejected["status"], rejected)
        self.assertTrue(standalone_requested("本机一键检查并更新"))
        for intent in ("只检查更新", "不要更新本机", "打包发布并更新本机"):
            self.assertFalse(standalone_requested(intent))


if __name__ == "__main__":
    unittest.main()

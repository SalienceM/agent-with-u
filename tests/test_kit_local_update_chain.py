"""隔离链路：临时构建登记、fake publisher、fake desktop/installer receipt；不退出应用。"""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_CLIENT, _REQUEST_OWNER_ID, _REQUEST_IDENTITY_SOURCE, _REQUEST_CAN_CLAIM_LEGACY
from src.backend.kit_capabilities import KitCapabilityRegistry
from src.backend.kit_update_journal import durable_json
from src.backend.kit_update_template import build_template
from src.backend.release_center import ReleaseCenterManager
from src.backend.workspace_kit_store import WorkspaceKit
from src.types import Session


class Desktop:
    def __init__(self):
        self.notifications = []
    async def send(self, value):
        self.notifications.append(json.loads(value))


class LocalUpdateChainTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "project"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "dist").mkdir()
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data"),
            "AGENT_WITH_U_RUNTIME": "desktop", "AGENT_WITH_U_DESKTOP_EXE": str(self.root / "desktop.exe"),
            "AGENT_WITH_U_DESKTOP_PID": "12345"})
        env.start(); self.addCleanup(env.stop)
        self.bridge = BridgeWS()
        self.session = Session(id="kit-chain", title="fixture", created_at=time.time(), updated_at=time.time(),
                               messages=[], working_dir=str(self.workspace), backend_id="codex-office")
        self.bridge._active_sessions[self.session.id] = self.session
        self.desktop = Desktop()
        self.desktop_view = {"protocol": 1, "instanceId": "installed-instance", "deviceId": "executor-a",
                             "pid": 12345, "exe": str(self.root / "desktop.exe"), "installed": True,
                             "release": {"version": "1", "packageVersion": "1", "buildId": "old", "sequence": 1}}
        stub = patch.object(self.bridge, "_kit_desktop", side_effect=lambda: (self.desktop, dict(self.desktop_view)))
        stub.start(); self.addCleanup(stub.stop)
        self.manager = ReleaseCenterManager(self.root / "data" / "release-center")
        self.manager.configure({"projectRoot": str(self.workspace), "baseUrl": "https://invalid.example", "qiniuBucket": "fake"})
        self.bridge._release_center_manager = self.manager
        self.publish_count = 0
        self.manifest = None
        async def fake_publish(job_id, plan):
            self.publish_count += 1
            self.manifest = plan["manifest"]
            self.manager._update_job(job_id, {"status": "succeeded"})
        for target, name, value in [
            (self.manager, "_fetch_manifest", None),
            (self.manager, "qiniu_account_status", {"configured": True, "mode": "fixture"}),
            (self.manager, "_qshell_path", "fixture"),
        ]:
            if hasattr(target, name):
                stub = patch.object(target, name, return_value=value); stub.start(); self.addCleanup(stub.stop)
        stub = patch.object(self.manager, "_run_publish", side_effect=fake_publish); stub.start(); self.addCleanup(stub.stop)
        # qshell existence preflight needs a file; it is never executed by the fake publisher.
        qshell = self.root / "qshell.exe"; qshell.write_bytes(b"inert")
        self.manager.configure({"qshell": str(qshell)})
        async def fake_read(source, **kwargs):
            self.assertIn("20990101000000-fixture", source)
            return json.dumps(self.manifest).encode()
        updater = self.bridge._update_manager
        stub = patch.object(updater, "_read_source", side_effect=fake_read); stub.start(); self.addCleanup(stub.stop)
        stub = patch.object(updater, "_artifact_url", return_value=str(self.workspace / "dist" / "AgentWithU_x64.msi")); stub.start(); self.addCleanup(stub.stop)
        stub = patch("src.backend.update_manager._arch", return_value="x86_64"); stub.start(); self.addCleanup(stub.stop)
        script = self.workspace / "register_release_candidate.py"
        script.write_text(
            "import sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(Path.cwd())!r})\n"
            "from src.backend.release_center import ReleaseCenterManager\n"
            "from src.backend.kit_build_receipts import register_build_receipt\n"
            f"root=Path({str(self.workspace)!r})\n"
            "(root/'src/_version.py').write_text(\"__version__='99.1.1'\\n__package_version__='99.1.1'\\n__build_id__='20990101000000-fixture'\\n__build_sequence__=20990101000000\\n__kit_update_protocol__=1\\n\",encoding='utf-8')\n"
            "(root/'dist/AgentWithU_x64.msi').write_bytes(b'inert fixture installer')\n"
            "register_build_receipt(ReleaseCenterManager().scan_project(str(root))['candidate'])\n", encoding="utf-8")
        self.build = WorkspaceKit.from_dict({"id": "real-builder", "title": "fixture builder", "enabled": True,
            "command": f"& '{sys.executable}' '{script}'", "shell": "powershell", "cwd": "."})
        state = self.bridge._kit_get(self.session.id)
        state.kits.append(self.build); self.bridge._kit_save(state)

    async def asyncTearDown(self):
        tasks = [*self.bridge._kit_tasks.values(), *getattr(self.bridge, "_kit_update_observers", {}).values()]
        for task in tasks: task.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        if self.bridge._kit_scheduler_task:
            self.bridge._kit_scheduler_task.cancel()
            await asyncio.gather(self.bridge._kit_scheduler_task, return_exceptions=True)

    async def until(self, predicate):
        for _ in range(400):
            if predicate(): return
            await asyncio.sleep(.02)
        self.fail("fixture did not reach expected state")

    async def prepared(self):
        state = self.bridge._kit_get(self.session.id)
        original = self.build.to_dict()
        generated = build_template(state, "打包上传并本机更新")
        self.assertTrue(generated["ready"])
        self.assertEqual(original, self.build.to_dict())
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(generated["kit"])))
        self.assertEqual("ok", created["status"], created)
        self.assertEqual([], state.runs)
        started = json.loads(self.bridge._rpc_kitRun(self.session.id, created["kit"]["id"], "{}"))
        self.assertEqual("ok", started["status"], started)
        run = state.runs[-1]
        await self.until(lambda: run.status in {"waiting_approval", "error", "failed"})
        self.assertEqual("waiting_approval", run.status, run.to_dict())
        self.assertEqual(0, self.publish_count)
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, run.steps[run.current_step].id, True)
        await self.until(lambda: run.current_step == len(run.steps)-1 and run.status == "waiting_approval" or run.status in {"error", "failed"})
        self.assertEqual("waiting_approval", run.status, run.to_dict())
        self.assertEqual(1, self.publish_count)
        self.assertEqual([], self.desktop.notifications)
        return run, run.steps[-1]

    async def test_chain_requires_second_confirmation_and_actual_restart(self):
        run, step = await self.prepared()
        runtime = step.config["capabilityRuntime"]
        with self.assertRaises(Exception):
            self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True, "stale", "fixture-confirmation")
        self.assertEqual([], self.desktop.notifications)
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True, runtime["planFingerprint"], "fixture-confirmation")
        await self.until(lambda: bool(self.desktop.notifications))
        self.assertEqual("waiting_restart", run.status)
        self.assertIsNone(run.ended_at)
        self.assertEqual("cannot_cancel", json.loads(self.bridge._rpc_kitCancel(self.session.id, run.id))["status"])
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True, runtime["planFingerprint"], "fixture-confirmation")
        self.assertEqual(1, len(self.desktop.notifications))
        journal = self.bridge._update_manager.journal
        receipt = {"protocol": 1, "requestId": runtime["installRequestId"], "identity": runtime["identity"],
                   "planFingerprint": runtime["planFingerprint"], "installation": "succeeded", "restart": "started"}
        durable_json(journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertNotEqual("succeeded", run.status)
        self.desktop_view["release"] = runtime["plan"]["release"]
        with patch("src.backend.kit_update_bridge._current_release", return_value=self.desktop_view["release"]):
            self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertEqual("succeeded", run.status)
        self.assertEqual(1, self.publish_count)
        self.assertEqual(1, len(self.desktop.notifications))

    async def test_cancel_before_install_preserves_published_result(self):
        run, step = await self.prepared()
        self.bridge._rpc_kitCancel(self.session.id, run.id)
        self.assertEqual("cancelled", run.status)
        self.assertEqual(1, self.publish_count)
        self.assertEqual([], self.desktop.notifications)
        self.assertFalse(self.bridge._update_manager.journal.active())
        self.assertEqual("cancelled", self.bridge._update_manager._state["phase"])
        self.bridge._update_manager.reserve_kit("f" * 32, step.config["capabilityRuntime"]["identity"])

    async def test_busy_identity_permission_and_double_file_failure_never_notify(self):
        run, step = await self.prepared()
        runtime = step.config["capabilityRuntime"]
        def confirm():
            return self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
                runtime["planFingerprint"], "fixture-confirmation")
        self.desktop_view["instanceId"] = "other-instance"
        with self.assertRaisesRegex(Exception, "实例"): confirm()
        self.desktop_view["instanceId"] = "installed-instance"
        self.bridge._seq_dispatch_reservations["busy"] = time.time() + 10
        with self.assertRaisesRegex(Exception, "序列"): confirm()
        self.bridge._seq_dispatch_reservations.clear()
        token = _REQUEST_OWNER_ID.set("foreign")
        try:
            with self.assertRaises(PermissionError): confirm()
        finally: _REQUEST_OWNER_ID.reset(token)
        source = _REQUEST_IDENTITY_SOURCE.set("relay"); rights = _REQUEST_CAN_CLAIM_LEGACY.set(False)
        try:
            with self.assertRaises(PermissionError): confirm()
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(rights); _REQUEST_IDENTITY_SOURCE.reset(source)
        with patch.object(self.bridge._kit_store, "save_durable", side_effect=OSError("fixture full disk")):
            with self.assertRaises(OSError): confirm()
        await asyncio.sleep(0)
        self.assertEqual([], self.desktop.notifications)
        self.assertTrue(self.bridge._update_work_blocked())
        confirm()  # 同确认仅回执，不在重试中补发副作用。
        self.assertEqual([], self.desktop.notifications)

    async def test_recreated_bridge_recovers_original_run_without_reinstall(self):
        run, step = await self.prepared()
        runtime = step.config["capabilityRuntime"]
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
            runtime["planFingerprint"], "fixture-confirmation")
        await self.until(lambda: bool(self.desktop.notifications))
        tasks = list(self.bridge._kit_update_observers.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        restarted = BridgeWS()
        restarted._active_sessions[self.session.id] = self.session
        receipt = dict(protocol=1, requestId=runtime["installRequestId"], identity=runtime["identity"],
            planFingerprint=runtime["planFingerprint"], installation="succeeded", restart="started")
        durable_json(restarted._update_manager.journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
        with patch.object(restarted, "_kit_desktop", side_effect=RuntimeError("offline")):
            # 真实离线为 JournalError；不把意外错误当作成功。
            with self.assertRaises(RuntimeError): restarted._rpc_kitResume(self.session.id, run.id)
        from src.backend.kit_update_journal import JournalError
        with patch.object(restarted, "_kit_desktop", side_effect=JournalError("offline")), patch(
                "src.backend.kit_update_bridge._current_release", return_value=runtime["plan"]["release"]):
            result = json.loads(restarted._rpc_kitResume(self.session.id, run.id))
            self.assertEqual("waiting_restart", result["run"]["status"])
        updated = {**self.desktop_view, "release": runtime["plan"]["release"]}
        with patch.object(restarted, "_kit_desktop", return_value=(self.desktop, updated)), patch(
                "src.backend.kit_update_bridge._current_release", return_value=updated["release"]):
            for _ in range(2):
                result = json.loads(restarted._rpc_kitResume(self.session.id, run.id))
                self.assertEqual("succeeded", result["run"]["status"])
                self.assertEqual("passed", result["run"]["verdict"])
        self.assertEqual(1, self.publish_count)
        self.assertEqual(1, len(self.desktop.notifications))

    async def test_failed_or_disconnected_handoff_never_replays_or_erases_publication(self):
        run, step = await self.prepared()
        runtime = step.config["capabilityRuntime"]
        from unittest.mock import AsyncMock
        with patch.object(self.desktop, "send", new=AsyncMock(side_effect=OSError("disconnected"))):
            self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
                runtime["planFingerprint"], "fixture-confirmation")
            await self.until(lambda: run.status == "result_unknown")
        self.assertTrue(self.bridge._update_work_blocked())
        receipt = dict(protocol=1, requestId=runtime["installRequestId"], identity=runtime["identity"],
            planFingerprint=runtime["planFingerprint"], installation="succeeded", restart="failed", error="fixture spawn failure")
        durable_json(self.bridge._update_manager.journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertEqual("failed", run.status)
        self.assertEqual("succeeded", run.steps[-2].status)
        self.assertEqual(1, self.publish_count)
        self.assertFalse(self.bridge._update_work_blocked())

    async def test_remote_controller_only_notifies_executor_and_installer_failure_stays_failed(self):
        self.session.owner_id = "relay-owner"
        remote = Desktop()
        owner = _REQUEST_OWNER_ID.set("relay-owner")
        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        rights = _REQUEST_CAN_CLAIM_LEGACY.set(True)
        client = _REQUEST_CLIENT.set(remote)
        try:
            run, step = await self.prepared()
            runtime = step.config["capabilityRuntime"]
            self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
                runtime["planFingerprint"], "fixture-confirmation")
            await self.until(lambda: bool(self.desktop.notifications))
            self.assertEqual([], remote.notifications)
            receipt = dict(protocol=1, requestId=runtime["installRequestId"], identity=runtime["identity"],
                planFingerprint=runtime["planFingerprint"], installation="failed", restart="not_started", error="fixture installer exit 42")
            durable_json(self.bridge._update_manager.journal.path(runtime["installRequestId"]).with_suffix(".result.json"), receipt)
            self.bridge._rpc_kitResume(self.session.id, run.id)
            self.assertEqual("failed", run.status)
            self.assertEqual("succeeded", run.steps[-2].status)
            self.assertIn("exit 42", run.error)
            self.assertEqual(1, self.publish_count)
        finally:
            _REQUEST_CLIENT.reset(client); _REQUEST_CAN_CLAIM_LEGACY.reset(rights)
            _REQUEST_IDENTITY_SOURCE.reset(source); _REQUEST_OWNER_ID.reset(owner)

    def test_arguments_and_template_ambiguity_fail_closed(self):
        with self.assertRaises(Exception):
            KitCapabilityRegistry().validate("node.update_local_published", {"owner": "forged", "program": "anything"})
        state = self.bridge._kit_get(self.session.id)
        state.kits.append(WorkspaceKit.from_dict({**self.build.to_dict(), "id": "another-builder"}))
        self.assertFalse(build_template(state, "打包上传并本机更新")["ready"])
        self.assertTrue(build_template(state, "打包上传并本机更新 real-builder")["ready"])

    async def test_generation_preview_order_cycle_and_failed_build(self):
        state = self.bridge._kit_get(self.session.id)
        preview = json.loads(await self.bridge._rpc_kitGenerate(self.session.id,
            json.dumps({"objective": "打包上传并本机更新"})))
        self.assertTrue(preview["ready"], preview)
        self.assertEqual(1, len(state.kits))
        self.assertEqual([], state.runs)
        spec = build_template(state, "打包上传并本机更新")["kit"]
        spec["steps"].append({"id": "after", "type": "command", "command": "echo forbidden"})
        rejected = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
        self.assertEqual("error", rejected["status"])
        self.assertIn("最后一步", rejected["message"])
        from src.backend.workspace_kit_store import WorkspaceKit
        cycle = WorkspaceKit.from_dict({"id": "cycle", "title": "cycle", "steps": [
            {"id": "again", "type": "kit_call", "kitId": "cycle"}]})
        state.kits.append(cycle)
        self.assertTrue(self.bridge._kit_build_plan(state, cycle, {})[1])
        state.kits.remove(cycle)
        spec["steps"].pop()
        spec["schedule"] = {"mode": "interval", "intervalSeconds": 60}
        rejected = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
        self.assertEqual("error", rejected["status"])
        self.assertIn("Schedule", rejected["message"])
        spec["schedule"] = {"mode": "manual"}
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
        # 临时测试脚本故意不登记任何制品，即使退出 0 也不能发布。
        (self.workspace / "register_release_candidate.py").write_text("pass\n", encoding="utf-8")
        self.bridge._rpc_kitRun(self.session.id, created["kit"]["id"], "{}")
        run = state.runs[-1]
        await self.until(lambda: run.status in {"error", "failed"})
        self.assertTrue(all(s.status == "skipped" for s in run.steps[run.current_step + 1:]), run.to_dict())
        self.assertEqual(0, self.publish_count)
        self.assertFalse(self.bridge._update_manager.journal.active())

    def test_unresolved_update_survives_history_compaction(self):
        from src.backend.workspace_kit_store import KitRun, WorkspaceKitState
        state = WorkspaceKitState(session_id="fixture")
        state.runs = [KitRun.from_dict({"id": "original", "status": "result_unknown"})] + [
            KitRun.from_dict({"id": str(i), "status": "succeeded"}) for i in range(101)]
        state.compact()
        self.assertEqual("original", state.runs[0].id)

    async def test_cancel_during_download_releases_only_owned_preparation(self):
        run, step = await self.prepared()
        self.bridge._rpc_kitCancel(self.session.id, run.id)
        await self.until(lambda: not self.bridge._kit_tasks.get(run.id))
        # 以新请求模拟选择后的慢下载；归属与发布仍是当前原运行。
        runtime = step.config["capabilityRuntime"]
        runtime.pop("installRequestId")
        runtime["phase"] = "preparing"
        started = asyncio.Event()
        async def slow(*args, **kwargs):
            started.set()
            await asyncio.Event().wait()
        with patch.object(self.bridge._update_manager, "stage_published", side_effect=slow):
            task = asyncio.create_task(self.bridge._run_kit_update_step(self.bridge._kit_get(self.session.id), self.session, run, step))
            self.bridge._kit_track_task(run.id, task)
            await started.wait()
            self.bridge._rpc_kitCancel(self.session.id, run.id)
            await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(self.bridge._update_manager.journal.active())
        self.assertEqual(1, self.publish_count)
        self.assertEqual([], self.desktop.notifications)

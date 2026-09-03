import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS
from src.backend.kit_capabilities import KitCapabilityRegistry
from src.backend.workspace_kit_store import WorkspaceKitState
from src.backend.workspace_kit_store import WorkspaceKit
from src.types import Session


class FakeReleaseCenter:
    def __init__(self, artifact_path: Path) -> None:
        self.artifact_path = artifact_path
        self.start_calls = 0
        self.scan_calls = 0
        self.cancel_calls = 0
        self.jobs: list[dict] = []

    def scan_project(self, project_root: str, source: str = "manual") -> dict:
        self.scan_calls += 1
        return {
            "status": "ok",
            "candidate": {
                "id": "build-20260902",
                "status": "candidate",
                "version": "26.9.2.120000",
                "packageVersion": "26.9.70000",
                "buildId": "20260902120000-fixture",
                "sequence": 20260902120000,
                "projectRoot": project_root,
                "source": source,
                "artifacts": [{
                    "id": "windows-x86_64-desktop-msi-fixture",
                    "path": str(self.artifact_path),
                    "fileName": self.artifact_path.name,
                    "platform": "windows",
                    "arch": "x86_64",
                    "target": "desktop",
                    "kind": "msi",
                    "size": self.artifact_path.stat().st_size,
                    "sha256": "a" * 64,
                    "fresh": True,
                }],
            },
        }

    async def preview(self, candidate_id: str, artifact_ids: list[str], options: dict) -> dict:
        return {
            "status": "ok",
            "plan": {
                "id": "frozen-plan",
                "status": "ready",
                "candidateId": candidate_id,
                "candidate": {
                    "version": "26.9.2.120000",
                    "buildId": "20260902120000-fixture",
                    "sequence": 20260902120000,
                },
                "channel": options.get("channel", "stable"),
                "manifestUrl": "https://updates.example.com/stable/manifest.json",
                "manifestKey": "agentwithu/releases/stable/manifest.json",
                "manifest": {
                    "release": {
                        "version": "26.9.2.120000",
                        "buildId": "20260902120000-fixture",
                        "sequence": 20260902120000,
                    },
                    "artifacts": [{
                        "id": artifact_ids[0],
                        "fileName": self.artifact_path.name,
                        "platform": "windows",
                        "arch": "x86_64",
                        "size": self.artifact_path.stat().st_size,
                        "sha256": "a" * 64,
                    }],
                },
                "blockers": [],
                "warnings": [],
                "comparison": {},
                "fingerprint": "f" * 64,
                "createdAt": time.time(),
            },
        }

    async def start_publish(self, plan_id: str) -> dict:
        self.start_calls += 1
        job = {
            "id": "publish-job",
            "planId": plan_id,
            "status": "succeeded",
            "progress": 100,
            "message": "发布完成",
            "manifestUrl": "https://updates.example.com/stable/manifest.json",
        }
        self.jobs = [job]
        return {"status": "queued", "job": job}

    def status(self) -> dict:
        return {"status": "ok", "jobs": list(self.jobs)}

    async def cancel_publish(self, _job_id: str) -> dict:
        self.cancel_calls += 1
        return {"status": "ok"}


class KitCapabilityProtocolTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _session(bridge: BridgeWS, session_id: str, workspace: Path) -> None:
        bridge._active_sessions[session_id] = Session(
            id=session_id,
            title="Capability Kit",
            created_at=time.time(),
            updated_at=time.time(),
            messages=[],
            working_dir=str(workspace),
            backend_id="codex-office",
        )

    async def _waiting_run(self, bridge: BridgeWS, session_id: str) -> tuple[object, object]:
        created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps({
            "title": "发布最新包",
            "objective": "发布最新包",
            "successCriteria": "stable manifest 指向本次构建",
            "steps": [{
                "id": "publish",
                "type": "awu_capability",
                "target": "executor",
                "title": "发布最新包",
                "config": {
                    "capability": "release.publish_latest",
                    "arguments": {
                        "projectRoot": ".",
                        "channel": "stable",
                        "notes": "fixture",
                    },
                },
            }],
        }, ensure_ascii=False)))
        self.assertEqual("ok", created["status"])
        started = json.loads(bridge._rpc_kitRun(session_id, created["kit"]["id"], "{}"))
        self.assertEqual("ok", started["status"])
        task = bridge._kit_tasks[started["run"]["id"]]
        for _ in range(200):
            run = bridge._kit_get(session_id).runs[-1]
            if run.status == "waiting_approval":
                return run, task
            await asyncio.sleep(0.01)
        self.fail("capability run did not enter waiting_approval")

    async def test_publish_never_starts_before_human_approval(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            artifact = workspace / "AgentWithU_fixture_x64.msi"
            artifact.write_bytes(b"fixture")
            manager = FakeReleaseCenter(artifact)
            bridge._release_center_manager = manager  # type: ignore[assignment]
            self._session(bridge, "capability-approve", workspace)

            run, task = await self._waiting_run(bridge, "capability-approve")

            self.assertEqual(0, manager.start_calls)
            self.assertEqual("waiting_approval", run.steps[0].status)
            runtime = run.steps[0].config["capabilityRuntime"]
            self.assertEqual("frozen-plan", runtime["planId"])
            self.assertNotIn("approval", runtime)

            response = json.loads(bridge._rpc_kitCapabilityRespond(
                "capability-approve", run.id, run.steps[0].id, True,
            ))
            self.assertEqual("approved", response["decision"])
            await asyncio.wait_for(task, timeout=3)

            completed = bridge._kit_get("capability-approve").runs[-1]
            self.assertEqual(1, manager.start_calls)
            self.assertEqual("succeeded", completed.status)
            self.assertEqual("succeeded", completed.steps[0].status)
            self.assertTrue(
                completed.steps[0].config["capabilityRuntime"]["approval"]["approved"]
            )

    async def test_rejecting_frozen_plan_cancels_without_publishing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            artifact = workspace / "AgentWithU_fixture_x64.msi"
            artifact.write_bytes(b"fixture")
            manager = FakeReleaseCenter(artifact)
            bridge._release_center_manager = manager  # type: ignore[assignment]
            self._session(bridge, "capability-reject", workspace)

            run, task = await self._waiting_run(bridge, "capability-reject")
            response = json.loads(bridge._rpc_kitCapabilityRespond(
                "capability-reject", run.id, run.steps[0].id, False,
            ))
            await asyncio.wait_for(task, timeout=3)

            rejected = bridge._kit_get("capability-reject").runs[-1]
            self.assertEqual("rejected", response["decision"])
            self.assertEqual(0, manager.start_calls)
            self.assertEqual("cancelled", rejected.status)
            self.assertFalse(
                rejected.steps[0].config["capabilityRuntime"]["approval"]["approved"]
            )

    async def test_schedule_fails_closed_before_release_preflight(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            artifact = workspace / "AgentWithU_fixture_x64.msi"
            artifact.write_bytes(b"fixture")
            manager = FakeReleaseCenter(artifact)
            bridge._release_center_manager = manager  # type: ignore[assignment]
            session_id = "capability-schedule"
            self._session(bridge, session_id, workspace)
            created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps({
                "title": "scheduled release",
                "steps": [{
                    "id": "publish", "type": "awu_capability", "title": "publish",
                    "config": {
                        "capability": "release.publish_latest",
                        "arguments": {"projectRoot": "."},
                    },
                }],
            })))
            started = bridge._queue_workspace_kit_run(
                session_id, created["kit"]["id"], {}, trigger="schedule", owner="ai",
            )
            await bridge._kit_tasks[started["run"]["id"]]

            run = bridge._kit_get(session_id).runs[-1]
            self.assertEqual("error", run.status)
            self.assertIn("Schedule", run.error)
            self.assertEqual(0, manager.scan_calls)
            self.assertEqual(0, manager.start_calls)


class KitCapabilityModelTests(unittest.TestCase):
    def test_dynamic_catalog_exposes_ai_discovery_metadata(self):
        capability = KitCapabilityRegistry().list()[0]

        self.assertEqual("release.publish_latest", capability["id"])
        self.assertTrue(capability["requiresExplicitIntent"])
        self.assertIn("发布", capability["intentHints"])
        self.assertIn("projectRoot", capability["argumentSchema"])
        self.assertEqual("awu_capability", capability["example"]["type"])

    def test_ai_capability_requires_matching_human_contract(self):
        bridge = BridgeWS()
        kit = WorkspaceKit.from_dict({
            "title": "Release",
            "steps": [{
                "id": "release",
                "type": "awu_capability",
                "config": {
                    "capability": "release.publish_latest",
                    "arguments": {"projectRoot": ".", "channel": "stable"},
                },
            }],
        })
        BridgeWS._normalize_generated_kit(kit)

        self.assertEqual(
            [], bridge._kit_capability_intent_errors(kit, "发布本次最新稳定包"),
        )
        errors = bridge._kit_capability_intent_errors(kit, "检查本次打包结果")
        self.assertEqual(1, len(errors))
        self.assertIn("明确授权", errors[0])

    def test_unregistered_ai_capability_is_rejected(self):
        bridge = BridgeWS()
        kit = WorkspaceKit.from_dict({
            "title": "Unknown",
            "steps": [{
                "id": "unknown",
                "type": "awu_capability",
                "config": {"capability": "backend.do_anything", "arguments": {}},
            }],
        })
        BridgeWS._normalize_generated_kit(kit)

        errors = bridge._kit_definition_errors(WorkspaceKitState(session_id="test"), kit)
        self.assertTrue(any("未注册" in error for error in errors))

    def test_capability_step_round_trips_without_becoming_a_command(self):
        kit = WorkspaceKit.from_dict({
            "title": "Release",
            "steps": [{
                "id": "release",
                "type": "awu_capability",
                "target": "executor",
                "config": {
                    "capability": "release.publish_latest",
                    "arguments": {"projectRoot": ".", "channel": "stable"},
                },
            }],
        })
        BridgeWS._normalize_generated_kit(kit)
        restored = WorkspaceKit.from_dict(kit.to_dict())

        self.assertEqual("awu_capability", restored.steps[0]["type"])
        self.assertEqual(
            "release.publish_latest", restored.steps[0]["config"]["capability"],
        )

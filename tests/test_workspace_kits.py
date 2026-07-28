import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.workspace_kit_store import (
    WorkspaceKit,
    WorkspaceKitState,
    WorkspaceKitStore,
    KitArtifact,
    KitRun,
    build_artifacts,
    evaluate_assertions,
    render_kit_command,
    resolve_kit_inputs,
)
from src.backend.bridge_ws import BridgeWS
from src.types import Session


class WorkspaceKitModelTests(unittest.TestCase):
    def test_every_kit_gets_a_default_verdict(self):
        kit = WorkspaceKit.from_dict({
            "title": "build",
            "command": "Write-Output ok",
            "assertions": [],
        })

        self.assertEqual(kit.assertions[0]["type"], "exit_code")
        self.assertEqual(kit.assertions[0]["expected"], 0)

    def test_template_inputs_use_environment_references(self):
        kit = WorkspaceKit.from_dict({
            "command": "Write-Output {{branch}}",
            "shell": "powershell",
            "inputs": [{"key": "branch"}],
        })

        command, env = render_kit_command(kit, {"branch": "feature/a; Remove-Item *"})

        self.assertEqual(command, "Write-Output $env:KIT_INPUT_BRANCH")
        self.assertEqual(env["KIT_INPUT_BRANCH"], "feature/a; Remove-Item *")
        self.assertNotIn("Remove-Item", command)

    def test_inputs_can_consume_latest_data_market_value(self):
        state = WorkspaceKitState(
            session_id="s1",
            artifacts=[
                KitArtifact(
                    id="a1", session_id="s1", kit_id="producer", run_id="r1",
                    key="release.version", label="version", value="1.2.3", created_at=1,
                ),
                KitArtifact(
                    id="a2", session_id="s1", kit_id="producer", run_id="r2",
                    key="release.version", label="version", value="1.2.4", created_at=2,
                ),
            ],
        )
        kit = WorkspaceKit.from_dict({
            "command": "echo {{version}}",
            "inputs": [{"key": "version", "required": True, "sourceKey": "release.version"}],
            "dependencies": ["release.version"],
        })

        resolved, errors = resolve_kit_inputs(kit, {}, state)

        self.assertEqual(errors, [])
        self.assertEqual(resolved["version"], "1.2.4")

    def test_missing_required_input_and_dependency_are_reported(self):
        kit = WorkspaceKit.from_dict({
            "command": "echo {{name}}",
            "inputs": [{"key": "name", "label": "名字", "required": True}],
            "dependencies": ["build.output"],
        })

        _, errors = resolve_kit_inputs(kit, {}, WorkspaceKitState(session_id="s1"))

        self.assertIn("缺少必填输入：名字", errors)
        self.assertIn("缺少数据依赖：build.output", errors)


class WorkspaceKitVerdictTests(unittest.TestCase):
    def test_assertions_produce_independent_red_green_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artifact.txt").write_text("ok", encoding="utf-8")

            results = evaluate_assertions(
                [
                    {"type": "exit_code", "expected": 0, "label": "exit"},
                    {"type": "stdout_regex", "expected": r"version=\d+", "label": "version"},
                    {"type": "file_exists", "expected": "artifact.txt", "label": "file"},
                    {"type": "stderr_contains", "expected": "fatal", "label": "nope"},
                ],
                exit_code=0,
                stdout="version=42",
                stderr="",
                working_dir=root,
            )

        self.assertEqual([item.passed for item in results], [True, True, True, False])

    def test_file_assertion_cannot_escape_session_workdir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = evaluate_assertions(
                [{"type": "file_exists", "expected": "../secret.txt"}],
                exit_code=0,
                stdout="",
                stderr="",
                working_dir=root,
            )[0]

        self.assertFalse(result.passed)
        self.assertIn("超出", result.message)

    def test_successful_json_output_becomes_typed_artifact(self):
        kit = WorkspaceKit.from_dict({
            "id": "kit-1",
            "command": "echo",
            "outputs": [{"key": "report", "label": "Report", "source": "json"}],
        })
        run = KitRun(
            id="run-1", kit_id="kit-1", session_id="session-1",
            stdout=json.dumps({"score": 98}),
        )

        with tempfile.TemporaryDirectory() as tmp:
            artifacts = build_artifacts(kit, run, working_dir=Path(tmp))

        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0].type, "json")
        self.assertEqual(artifacts[0].value["score"], 98)
        self.assertEqual(artifacts[0].run_id, "run-1")


class WorkspaceKitStoreTests(unittest.TestCase):
    def test_state_round_trip_and_latest_market_projection(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": tmp},
        ):
            store = WorkspaceKitStore()
            state = WorkspaceKitState(
                session_id="session-1",
                kits=[WorkspaceKit.from_dict({
                    "id": "kit-1", "title": "Build", "command": "echo ok",
                })],
                artifacts=[
                    KitArtifact(
                        id="old", session_id="session-1", kit_id="kit-1",
                        run_id="r1", key="build", label="Build", value="old", created_at=1,
                    ),
                    KitArtifact(
                        id="new", session_id="session-1", kit_id="kit-1",
                        run_id="r2", key="build", label="Build", value="new", created_at=2,
                    ),
                ],
            )
            store.save(state)

            restored = store.load("session-1")

            self.assertIsNotNone(restored)
            assert restored is not None
            self.assertEqual(restored.kits[0].title, "Build")
            market = restored.to_dict()["dataMarket"]
            self.assertEqual(len(market), 1)
            self.assertEqual(market[0]["value"], "new")
            self.assertEqual(store.list_session_ids(), ["session-1"])


class WorkspaceKitExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_executes_verdict_and_publishes_output(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            session_id = "kit-execution-session"
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            bridge._active_sessions[session_id] = Session(
                id=session_id,
                title="Kit test",
                created_at=time.time(),
                updated_at=time.time(),
                messages=[],
                working_dir=str(workspace),
                backend_id="codex-office",
            )
            if os.name == "nt":
                shell = "powershell"
                command = "Write-Output {{word}}"
            else:
                shell = "bash"
                command = "printf '%s' {{word}}"
            created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps({
                "title": "Echo",
                "shell": shell,
                "command": command,
                "timeoutSeconds": 10,
                "inputs": [{"key": "word", "required": True}],
                "assertions": [
                    {"type": "exit_code", "expected": 0},
                    {"type": "stdout_contains", "expected": "hello"},
                ],
                "outputs": [{"key": "echo.text", "source": "stdout", "type": "text"}],
            })))
            started = json.loads(bridge._rpc_kitRun(
                session_id, created["kit"]["id"], json.dumps({"word": "hello"}),
            ))

            await bridge._kit_tasks[started["run"]["id"]]
            state = bridge._kit_get(session_id)
            run = state.runs[-1]

            self.assertEqual(run.status, "succeeded")
            self.assertTrue(all(item.passed for item in run.assertions))
            self.assertIn("hello", run.stdout)
            self.assertEqual(state.latest_artifact("echo.text").run_id, run.id)

            # 终端接管必须是真正的持久通道：前一条命令设置的变量，后一条仍可读取。
            set_command = "$env:AWU_KIT_KEEP='persisted'" if os.name == "nt" else "export AWU_KIT_KEEP=persisted"
            get_command = "Write-Output $env:AWU_KIT_KEEP" if os.name == "nt" else "printf '%s' \"$AWU_KIT_KEEP\""
            first = json.loads(bridge._rpc_kitTerminalCommand(
                session_id, created["kit"]["id"], set_command,
            ))
            await bridge._kit_tasks[first["run"]["id"]]
            terminal_key = bridge._kit_terminal_key(session_id, created["kit"]["id"])
            try:
                second = json.loads(bridge._rpc_kitTerminalCommand(
                    session_id, created["kit"]["id"], get_command,
                ))
                await bridge._kit_tasks[second["run"]["id"]]
                terminal_run = bridge._kit_get(session_id).runs[-1]
                self.assertEqual(
                    terminal_run.status,
                    "succeeded",
                    msg=f"exit={terminal_run.exit_code} stdout={terminal_run.stdout!r} error={terminal_run.error!r}",
                )
                self.assertIn("persisted", terminal_run.stdout)
                self.assertIn(terminal_key, bridge._kit_terminals)
            finally:
                await bridge._rpc_kitTerminalClose(session_id, created["kit"]["id"])
            self.assertNotIn(terminal_key, bridge._kit_terminals)


if __name__ == "__main__":
    unittest.main()

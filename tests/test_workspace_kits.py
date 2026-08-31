import asyncio
import json
import os
import base64
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.workspace_kit_store import (
    WorkspaceKit,
    WorkspaceKitState,
    WorkspaceKitStore,
    KitGenerationJob,
    KitArtifact,
    KitRun,
    KitStepRun,
    build_artifacts,
    evaluate_assertions,
    render_kit_command,
    resolve_kit_inputs,
)
from src.backend.bridge_ws import BridgeWS
from src.backend.backends import StreamDelta
from src.types import Session


class WorkspaceKitModelTests(unittest.TestCase):
    def test_legacy_kit_defaults_to_executor(self):
        kit = WorkspaceKit.from_dict({"title": "legacy", "command": "echo ok"})

        self.assertEqual(kit.execution_target, "executor")
        self.assertEqual(kit.steps, [])
        self.assertEqual(WorkspaceKit.from_dict(kit.to_dict()).execution_target, "executor")
        self.assertEqual(len(kit.versions), 1)
        self.assertEqual(kit.versions[0].version, "1.0")
        self.assertEqual(kit.active_version_id, kit.versions[0].id)

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

    def test_file_output_can_register_a_release_candidate_without_publishing(self):
        kit = WorkspaceKit.from_dict({
            "title": "Package",
            "command": "echo ok",
            "outputs": [{
                "key": "installer", "source": "file", "type": "file",
                "path": "dist/AgentWithU-setup.exe", "releaseCandidate": True,
            }],
        })

        BridgeWS._normalize_generated_kit(kit)
        restored = WorkspaceKit.from_dict(kit.to_dict())

        self.assertTrue(restored.outputs[0]["releaseCandidate"])
        self.assertNotIn("publish", restored.outputs[0])


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

    def test_natural_language_contract_and_ai_provenance_round_trip(self):
        kit = WorkspaceKit.from_dict({
            "title": "Stop AMP",
            "description": "Stop the owned process tree",
            "objective": "关闭 start-amp.bat 启动的服务",
            "successCriteria": "目标进程全部消失",
            "safetyConstraints": "不得关闭其他 Java",
            "references": ["start-amp.bat"],
            "implementationSummary": "按唯一根 PID 关闭进程树并复核",
            "generationWarnings": [],
            "generatedByAi": True,
            "command": "Write-Output ok",
        })

        restored = WorkspaceKit.from_dict(kit.to_dict())

        self.assertEqual(restored.objective, "关闭 start-amp.bat 启动的服务")
        self.assertEqual(restored.success_criteria, "目标进程全部消失")
        self.assertEqual(restored.safety_constraints, "不得关闭其他 Java")
        self.assertEqual(restored.references, ["start-amp.bat"])
        self.assertTrue(restored.generated_by_ai)


class _FakeKitCompilerBackend:
    def __init__(self, response: dict):
        self.response = response
        self.prompt = ""

    async def send_message(self, **kwargs):
        self.prompt = kwargs["content"]
        kwargs["on_delta"](StreamDelta(
            kwargs["session_id"], kwargs["message_id"], "text_delta",
            text=json.dumps(self.response, ensure_ascii=False),
        ))
        return {}

    def clear_cancelled(self, _session_id):
        return None


class _SlowKitCompilerBackend(_FakeKitCompilerBackend):
    def __init__(self, response: dict):
        super().__init__(response)
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.aborted = False

    async def send_message(self, **kwargs):
        self.prompt = kwargs["content"]
        self.started.set()
        await self.release.wait()
        kwargs["on_delta"](StreamDelta(
            kwargs["session_id"], kwargs["message_id"], "text_delta",
            text=json.dumps(self.response, ensure_ascii=False),
        ))
        return {}

    def abort(self, _session_id=None):
        self.aborted = True
        self.release.set()


class WorkspaceKitGenerationTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _generation_response() -> dict:
        return {
            "ready": True,
            "implementationSummary": "输出可验收结果",
            "safetySummary": "只读当前工作区",
            "verificationSummary": "退出码为零",
            "warnings": [],
            "questions": [],
            "kit": {
                "title": "后台生成测试",
                "description": "验证后台 Kit 编译",
                "shell": "powershell",
                "cwd": ".",
                "timeoutSeconds": 30,
                "command": "Write-Output 'ok'; exit 0",
                "assertions": [{"type": "exit_code", "expected": 0}],
            },
        }

    async def test_background_generation_returns_immediately_and_survives_requery(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            bridge = BridgeWS()
            session_id = "background-kit-generation"
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Background generation", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(workspace), backend_id="fake",
            )
            fake = _SlowKitCompilerBackend(self._generation_response())
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                started_at = asyncio.get_running_loop().time()
                started = json.loads(bridge._rpc_kitGenerateStart(session_id, json.dumps({
                    "objective": "在后台生成一个 Kit",
                    "successCriteria": "返回可执行并可验收的实现",
                    "safetyConstraints": "不得修改工作区",
                }, ensure_ascii=False)))
                elapsed = asyncio.get_running_loop().time() - started_at
                self.assertLess(elapsed, 0.1)
                self.assertEqual(started["status"], "ok")
                self.assertEqual(started["job"]["status"], "queued")

                job_id = started["job"]["id"]
                task = bridge._kit_generation_tasks[job_id]
                await asyncio.wait_for(fake.started.wait(), timeout=1)
                running = json.loads(bridge._rpc_kitGenerationGet(session_id))
                self.assertEqual(running["job"]["id"], job_id)
                self.assertEqual(running["job"]["status"], "running")
                self.assertIn("后台", running["job"]["request"]["objective"])

                duplicate = json.loads(bridge._rpc_kitGenerateStart(session_id, json.dumps({
                    "objective": "不要重复提交",
                }, ensure_ascii=False)))
                self.assertTrue(duplicate["reused"])
                self.assertEqual(duplicate["job"]["id"], job_id)

                fake.release.set()
                await asyncio.wait_for(task, timeout=2)

            completed = json.loads(bridge._rpc_kitGenerationGet(session_id))
            self.assertEqual(completed["job"]["status"], "succeeded")
            self.assertEqual(completed["job"]["result"]["status"], "ok")
            persisted = WorkspaceKitStore().load(session_id)
            self.assertIsNotNone(persisted)
            assert persisted is not None
            self.assertEqual(persisted.generation_jobs[-1].status, "succeeded")
            self.assertIsNotNone(persisted.generation_jobs[-1].result)

    async def test_background_generation_can_be_cancelled(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            bridge = BridgeWS()
            session_id = "cancel-kit-generation"
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Cancel generation", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(workspace), backend_id="fake",
            )
            fake = _SlowKitCompilerBackend(self._generation_response())
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                started = json.loads(bridge._rpc_kitGenerateStart(session_id, json.dumps({
                    "objective": "生成后等待取消",
                    "successCriteria": "可以停止",
                }, ensure_ascii=False)))
                job_id = started["job"]["id"]
                task = bridge._kit_generation_tasks[job_id]
                await asyncio.wait_for(fake.started.wait(), timeout=1)
                cancelled = json.loads(bridge._rpc_kitGenerateCancel(session_id, job_id))
                self.assertEqual(cancelled["job"]["status"], "cancelled")
                with self.assertRaises(asyncio.CancelledError):
                    await task
            restored = json.loads(bridge._rpc_kitGenerationGet(session_id, job_id))
            self.assertEqual(restored["job"]["status"], "cancelled")
            self.assertTrue(fake.aborted)

    async def test_backend_restart_marks_orphaned_generation_as_interrupted(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            session_id = "interrupted-kit-generation"
            store = WorkspaceKitStore()
            state = WorkspaceKitState(session_id=session_id, generation_jobs=[
                KitGenerationJob(
                    id="orphan-job", session_id=session_id, status="running",
                    request={"objective": "不会自动续跑"}, message="运行中",
                    started_at=time.time(),
                ),
            ])
            store.save(state)
            bridge = BridgeWS()
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Interrupted generation", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=tmp, backend_id="fake",
            )

            restored = json.loads(bridge._rpc_kitGenerationGet(session_id))
            self.assertEqual(restored["job"]["status"], "error")
            self.assertIn("重启", restored["job"]["message"])

    async def test_ai_compiler_returns_preview_without_saving_or_running(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            (workspace / "start-amp.bat").write_text("@echo off\njava -jar amp.jar\n", encoding="utf-8")
            bridge = BridgeWS()
            session_id = "kit-generation-session"
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Kit generation", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(workspace), backend_id="fake",
            )
            fake = _FakeKitCompilerBackend({
                "ready": True,
                "implementationSummary": "按唯一 PID 关闭 AMP 进程树",
                "safetySummary": "只处理已证明属于目标 CMD 的后代",
                "verificationSummary": "关闭后二次检查原 PID",
                "warnings": [],
                "questions": [],
                "kit": {
                    "title": "停止 AMP",
                    "description": "关闭 AMP 专属进程树",
                    "shell": "powershell",
                    "cwd": ".",
                    "timeoutSeconds": 30,
                    "command": "Write-Output 'closed'; exit 0",
                    "assertions": [{"type": "exit_code", "expected": 0, "label": "AMP 已关闭"}],
                    "outputs": [{"key": "result", "source": "stdout", "type": "text"}],
                },
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                result = json.loads(await bridge._rpc_kitGenerate(session_id, json.dumps({
                    "objective": "关闭 start-amp.bat 启动的 CMD 和附属 Java",
                    "successCriteria": "目标进程全部消失；否则失败",
                    "safetyConstraints": "不得关闭其他 Java",
                    "references": ["start-amp.bat"],
                }, ensure_ascii=False)))

            self.assertEqual(result["status"], "ok")
            self.assertTrue(result["ready"])
            self.assertTrue(result["kit"]["generatedByAi"])
            self.assertEqual(result["kit"]["objective"], "关闭 start-amp.bat 启动的 CMD 和附属 Java")
            self.assertIn("java -jar amp.jar", fake.prompt)
            self.assertEqual(bridge._kit_get(session_id).kits, [])
            self.assertEqual(bridge._kit_get(session_id).runs, [])

    async def test_ai_compiler_blocks_global_process_name_kill(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            bridge = BridgeWS()
            session_id = "unsafe-kit-generation"
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Unsafe generation", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(workspace), backend_id="fake",
            )
            fake = _FakeKitCompilerBackend({
                "ready": True,
                "kit": {
                    "title": "Unsafe",
                    "shell": "powershell",
                    "command": "taskkill.exe /IM java.exe /F",
                    "assertions": [{"type": "exit_code", "expected": 0}],
                },
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                result = json.loads(await bridge._rpc_kitGenerate(session_id, json.dumps({
                    "objective": "关闭我的 Java 服务",
                    "successCriteria": "服务进程消失",
                    "safetyConstraints": "不得影响其他 Java",
                }, ensure_ascii=False)))

            self.assertEqual(result["status"], "needs_input")
            self.assertFalse(result["ready"])
            self.assertTrue(any("全局 taskkill" in item for item in result["warnings"]))

            # 即使绕过前端直接提交，AI provenance 仍会触发同一安全门。
            created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps(result["kit"], ensure_ascii=False)))
            self.assertEqual(created["status"], "error")
            self.assertIn("安全检查", created["message"])

    async def test_remote_session_file_transfer_uses_builtin_file_push_without_ssh(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            bridge = BridgeWS()
            session_id = "builtin-file-push"
            bridge._active_sessions[session_id] = Session(
                id=session_id, title="Remote file push", created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(workspace), backend_id="fake",
            )
            # 模拟模型错误地索要 SSH 拓扑；产品层必须纠正为当前 Session 的
            # 内建 file_push，并把本地文件留作运行时文件选择输入。
            fake = _FakeKitCompilerBackend({
                "ready": False,
                "questions": [
                    {"key": "remote_target", "question": "请提供主机、用户名和端口"},
                    {"key": "auth_method", "question": "请提供 SSH 密钥或密码"},
                ],
                "warnings": ["缺少远端连接信息"],
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                result = json.loads(await bridge._rpc_kitGenerate(session_id, json.dumps({
                    "objective": "把本地的 amp-1.0-snapshot.jar 文件同步到 remote session 上",
                    "successCriteria": "传送成功则成功，反之失败",
                    "safetyConstraints": "只写入当前 Session 工作区",
                }, ensure_ascii=False)))

            self.assertEqual(result["status"], "ok")
            self.assertTrue(result["ready"])
            self.assertEqual(result["questions"], [])
            self.assertEqual(result["kit"]["inputs"][0]["type"], "file")
            step = result["kit"]["steps"][0]
            self.assertEqual(step["type"], "file_push")
            self.assertEqual(step["config"]["source"], "{{local_file}}")
            self.assertEqual(step["config"]["destination"], "amp-1.0-snapshot.jar")
            self.assertNotIn("SSH", result["implementationSummary"])
            self.assertIn("绝对不要询问", fake.prompt)

    def test_selected_client_file_keeps_exact_local_source_and_same_name_destination(self):
        candidate = BridgeWS._kit_builtin_file_push_candidate(
            "把本地文件同步到当前 Session",
            [r"C:\build\amp-1.0-snapshot.jar"],
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["inputs"], [])
        self.assertEqual(candidate["steps"][0]["config"]["source"], r"C:\build\amp-1.0-snapshot.jar")
        self.assertEqual(candidate["steps"][0]["config"]["destination"], "amp-1.0-snapshot.jar")


class WorkspaceKitVersionTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _session(bridge: BridgeWS, session_id: str, workspace: Path) -> None:
        bridge._active_sessions[session_id] = Session(
            id=session_id, title="Kit versions", created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=str(workspace), backend_id="fake",
        )

    async def test_implementation_versions_are_safe_and_switchable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-versions", workspace)
            created = json.loads(bridge._rpc_kitCreate("kit-versions", json.dumps({
                "title": "Versioned", "command": "Write-Output one",
            })))
            kit_id = created["kit"]["id"]
            self.assertEqual(created["kit"]["versions"][0]["version"], "1.0")

            title_only = json.loads(bridge._rpc_kitUpdate(
                "kit-versions", kit_id, json.dumps({"title": "Renamed"}),
            ))
            self.assertEqual(len(title_only["kit"]["versions"]), 1)

            blocked = json.loads(bridge._rpc_kitUpdate(
                "kit-versions", kit_id, json.dumps({"command": "Write-Output two"}),
            ))
            self.assertEqual(blocked["status"], "error")
            self.assertIn("先停用", blocked["message"])

            json.loads(bridge._rpc_kitUpdate("kit-versions", kit_id, json.dumps({"enabled": False})))
            updated = json.loads(bridge._rpc_kitUpdate(
                "kit-versions", kit_id, json.dumps({"command": "Write-Output two"}),
            ))
            self.assertEqual([v["version"] for v in updated["kit"]["versions"]], ["1.0", "1.1"])
            first_id = updated["kit"]["versions"][0]["id"]
            activated = json.loads(bridge._rpc_kitVersionActivate("kit-versions", kit_id, first_id))
            self.assertEqual(activated["status"], "ok")
            self.assertEqual(activated["kit"]["command"], "Write-Output one")
            self.assertFalse(activated["kit"]["enabled"])

    async def test_ai_optimization_is_candidate_until_user_finalizes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-optimize", workspace)
            created = json.loads(bridge._rpc_kitCreate("kit-optimize", json.dumps({
                "title": "Optimize me", "command": "Write-Output one", "enabled": False,
            })))
            kit_id = created["kit"]["id"]
            fake = _FakeKitCompilerBackend({
                "reply": "已把过程拆为执行和复核。",
                "ready": True,
                "warnings": [],
                "questions": [],
                "proposal": {
                    "implementationSummary": "执行后复核输出",
                    "executionTarget": "executor",
                    "shell": "powershell",
                    "cwd": ".",
                    "command": "Write-Output optimized",
                    "assertions": [{"type": "stdout_contains", "expected": "optimized"}],
                    "outputs": [{"key": "result", "source": "stdout", "type": "text"}],
                    "schedule": {"mode": "manual", "intervalSeconds": 300},
                },
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake) as factory:
                asked = json.loads(await bridge._rpc_kitOptimizeAsk(
                    "kit-optimize", kit_id, "增加可靠的执行后复核", "review-backend",
                ))

            self.assertEqual(asked["status"], "ok")
            assistant = asked["message"]
            self.assertTrue(assistant["ready"])
            factory.assert_called_once_with("review-backend")
            persisted = bridge._kit_get("kit-optimize").kits[0]
            self.assertEqual(persisted.command, "Write-Output one")
            self.assertEqual(len(persisted.versions), 1)

            finalized = json.loads(bridge._rpc_kitOptimizeFinalize(
                "kit-optimize", kit_id, assistant["id"], "复核版",
            ))
            self.assertEqual(finalized["status"], "ok")
            self.assertEqual(finalized["version"]["version"], "1.1")
            persisted = bridge._kit_get("kit-optimize").kits[0]
            self.assertEqual(persisted.command, "Write-Output optimized")
            self.assertEqual(persisted.active_version_id, finalized["version"]["id"])
            final_message = next(item for item in persisted.optimization_messages if item.id == assistant["id"])
            self.assertEqual(final_message.finalized_version_id, finalized["version"]["id"])

            compact = bridge._kit_payload(bridge._kit_get("kit-optimize"))["kits"][0]
            self.assertNotIn("snapshot", compact["versions"][0])
            self.assertEqual(compact["optimizationMessages"], [])

    async def test_ai_candidate_can_be_saved_without_switching_active_version(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-candidate", workspace)
            created = json.loads(bridge._rpc_kitCreate("kit-candidate", json.dumps({
                "title": "Keep running", "command": "Write-Output current", "enabled": True,
            })))
            kit_id = created["kit"]["id"]
            active_id = created["kit"]["activeVersionId"]
            fake = _FakeKitCompilerBackend({
                "reply": "候选已准备好，可先保存到版本库。",
                # 模型常因存在普通风险提示而保守地返回 ready=false；本地
                # 分级校验不应因此锁死一个结构和安全检查均通过的候选。
                "ready": False,
                "warnings": ["构建日志会保留在工作区", "构建最多运行 6 小时"],
                "blockingIssues": [],
                "questions": [],
                "proposal": {
                    "executionTarget": "executor",
                    "shell": "powershell",
                    "cwd": ".",
                    "command": "Write-Output candidate",
                    "assertions": [{"type": "stdout_contains", "expected": "candidate"}],
                    "schedule": {"mode": "manual", "intervalSeconds": 300},
                },
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                asked = json.loads(await bridge._rpc_kitOptimizeAsk(
                    "kit-candidate", kit_id, "生成下一候选", "review-backend",
                ))

            self.assertTrue(asked["message"]["ready"])
            self.assertEqual(len(asked["message"]["warnings"]), 2)
            self.assertEqual(asked["message"]["blockingIssues"], [])

            # 模拟升级前已保存的“warning 即阻断”旧候选；重新打开优化面板
            # 应自动按当前规则重验，而不是要求用户重新对话。
            persisted = bridge._kit_get("kit-candidate").kits[0]
            old_message = next(
                item for item in persisted.optimization_messages
                if item.id == asked["message"]["id"]
            )
            old_message.ready = False
            old_message.readiness_version = 0
            bridge._kit_save(bridge._kit_get("kit-candidate"), emit=False)
            refreshed = json.loads(bridge._rpc_kitOptimizeGet("kit-candidate", kit_id))
            refreshed_message = next(
                item for item in refreshed["messages"] if item["id"] == asked["message"]["id"]
            )
            self.assertTrue(refreshed_message["ready"])
            self.assertEqual(refreshed_message["readinessVersion"], 2)

            saved = json.loads(bridge._rpc_kitOptimizeFinalize(
                "kit-candidate", kit_id, asked["message"]["id"], "候选版", False,
            ))

            self.assertEqual(saved["status"], "ok")
            self.assertFalse(saved["version"]["isActive"])
            persisted = bridge._kit_get("kit-candidate").kits[0]
            self.assertEqual(len(persisted.versions), 2)
            self.assertEqual(persisted.active_version_id, active_id)
            self.assertEqual(persisted.command, "Write-Output current")
            self.assertTrue(persisted.enabled)

            blocked = json.loads(bridge._rpc_kitVersionActivate(
                "kit-candidate", kit_id, saved["version"]["id"],
            ))
            self.assertEqual(blocked["status"], "error")
            self.assertIn("先停用", blocked["message"])

    async def test_ai_optimization_declared_blocker_prevents_version_save(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-blocker", workspace)
            created = json.loads(bridge._rpc_kitCreate("kit-blocker", json.dumps({
                "title": "Needs identity", "command": "Write-Output current", "enabled": False,
            })))
            kit_id = created["kit"]["id"]
            fake = _FakeKitCompilerBackend({
                "reply": "命令结构有效，但目标进程归属仍需确认。",
                "ready": False,
                "warnings": ["预计耗时较长"],
                "blockingIssues": ["尚不能证明目标 PID 属于这个 Kit 启动的进程树"],
                "questions": [],
                "proposal": {
                    "executionTarget": "executor",
                    "shell": "powershell",
                    "cwd": ".",
                    "command": "Write-Output candidate",
                    "assertions": [{"type": "exit_code", "expected": 0}],
                    "schedule": {"mode": "manual", "intervalSeconds": 300},
                },
            })
            with patch.object(bridge, "_new_backend_instance", return_value=fake):
                asked = json.loads(await bridge._rpc_kitOptimizeAsk(
                    "kit-blocker", kit_id, "优化关闭流程", "review-backend",
                ))

            assistant = asked["message"]
            self.assertFalse(assistant["ready"])
            self.assertEqual(assistant["warnings"], ["预计耗时较长"])
            self.assertIn("目标 PID", assistant["blockingIssues"][0])
            rejected = json.loads(bridge._rpc_kitOptimizeFinalize(
                "kit-blocker", kit_id, assistant["id"], "不应保存", False,
            ))
            self.assertEqual(rejected["status"], "error")
            self.assertIn("目标 PID", rejected["message"])


class WorkspaceKitExecutionTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _session(bridge: BridgeWS, session_id: str, workspace: Path) -> None:
        bridge._active_sessions[session_id] = Session(
            id=session_id, title="Kit orchestration", created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=str(workspace), backend_id="codex-office",
        )

    async def test_cancel_stale_run_without_task_is_immediate_and_idempotent(self):
        """异常/重启丢失内存 Task 后，停止仍须解除 sidecar 的永久 running。"""
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            session_id = "kit-stale-cancel"
            self._session(bridge, session_id, workspace)
            kit = WorkspaceKit.from_dict({
                "id": "stale-kit", "title": "stale", "command": "echo ok",
            })
            run = KitRun(
                id="stale-run", kit_id=kit.id, session_id=session_id,
                status="running", started_at=time.time(),
                steps=[
                    KitStepRun(
                        id="current", type="command", target="executor",
                        title="current", status="running",
                    ),
                    KitStepRun(
                        id="later", type="command", target="executor",
                        title="later", status="pending",
                    ),
                ],
            )
            state = bridge._kit_get(session_id)
            state.kits.append(kit)
            state.runs.append(run)
            bridge._kit_save(state, emit=False)

            stopped = json.loads(bridge._rpc_kitCancel(session_id, run.id))
            stopped_again = json.loads(bridge._rpc_kitCancel(session_id, run.id))

            self.assertEqual(stopped["statusNow"], "cancelled")
            self.assertEqual(stopped_again["statusNow"], "cancelled")
            self.assertEqual(run.status, "cancelled")
            self.assertEqual(run.steps[0].status, "cancelled")
            self.assertEqual(run.steps[1].status, "skipped")
            self.assertIsNotNone(run.ended_at)
            self.assertNotIn(run.id, bridge._kit_cancel_requests)

    async def test_cancel_before_task_first_runs_cleans_registry(self):
        """覆盖 create_task 后、协程首次调度前点击停止的竞态。"""
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            session_id = "kit-prestart-cancel"
            self._session(bridge, session_id, workspace)
            created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps({
                "title": "prestart", "command": "echo should-not-run",
            })))
            started = json.loads(bridge._rpc_kitRun(
                session_id, created["kit"]["id"], "{}",
            ))
            run_id = started["run"]["id"]
            task = bridge._kit_tasks[run_id]

            stopped = json.loads(bridge._rpc_kitCancel(session_id, run_id))
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.sleep(0)

            run = bridge._kit_get(session_id).runs[-1]
            self.assertEqual(stopped["statusNow"], "cancelled")
            self.assertEqual(run.status, "cancelled")
            self.assertNotIn(run_id, bridge._kit_tasks)
            self.assertNotIn(run_id, bridge._kit_cancel_requests)

    async def test_cancel_running_executor_command_stops_process_tree(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            session_id = "kit-process-cancel"
            self._session(bridge, session_id, workspace)
            shell = "powershell" if os.name == "nt" else "bash"
            command = "Start-Sleep -Seconds 30" if os.name == "nt" else "sleep 30"
            created = json.loads(bridge._rpc_kitCreate(session_id, json.dumps({
                "title": "long", "shell": shell, "command": command,
                "timeoutSeconds": 60,
            })))
            started = json.loads(bridge._rpc_kitRun(
                session_id, created["kit"]["id"], "{}",
            ))
            run_id = started["run"]["id"]
            task = bridge._kit_tasks[run_id]
            for _ in range(200):
                if run_id in bridge._kit_processes:
                    break
                await asyncio.sleep(0.01)
            self.assertIn(run_id, bridge._kit_processes)
            proc = bridge._kit_processes[run_id]

            stopped = json.loads(bridge._rpc_kitCancel(session_id, run_id))
            await asyncio.wait_for(task, timeout=8)

            run = bridge._kit_get(session_id).runs[-1]
            self.assertEqual(stopped["statusNow"], "cancelled")
            self.assertEqual(run.status, "cancelled")
            self.assertIsNotNone(proc.returncode)

    async def test_steps_stop_after_first_failure(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "step-failure", workspace)
            if os.name == "nt":
                shell, fail, write = "powershell", "Write-Error fail; exit 7", "Set-Content skipped.txt yes"
            else:
                shell, fail, write = "bash", "exit 7", "printf yes > skipped.txt"
            created = json.loads(bridge._rpc_kitCreate("step-failure", json.dumps({
                "title": "ordered",
                "steps": [
                    {"id": "one", "type": "command", "target": "executor", "title": "fail",
                     "shell": shell, "command": fail, "assertions": [{"type": "exit_code", "expected": 0}]},
                    {"id": "two", "type": "command", "target": "executor", "title": "must skip",
                     "shell": shell, "command": write},
                ],
            })))
            started = json.loads(bridge._rpc_kitRun("step-failure", created["kit"]["id"], "{}"))

            await bridge._kit_tasks[started["run"]["id"]]
            run = bridge._kit_get("step-failure").runs[-1]

            self.assertEqual(run.status, "failed")
            self.assertEqual(run.steps[0].status, "failed")
            self.assertEqual(run.steps[1].status, "skipped")
            self.assertFalse((workspace / "skipped.txt").exists())

    async def test_kit_call_expands_and_runs_in_order(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-call", workspace)
            if os.name == "nt":
                shell, child_command = "powershell", "Write-Output child"
            else:
                shell, child_command = "bash", "printf child"
            child = json.loads(bridge._rpc_kitCreate("kit-call", json.dumps({
                "title": "child", "shell": shell, "command": child_command,
                "assertions": [{"type": "stdout_contains", "expected": "child"}],
            })))["kit"]
            parent = json.loads(bridge._rpc_kitCreate("kit-call", json.dumps({
                "title": "parent",
                "steps": [{"id": "call", "type": "kit_call", "title": "invoke child", "kitId": child["id"]}],
                "assertions": [{"type": "stdout_contains", "expected": "child"}],
            })))["kit"]
            started = json.loads(bridge._rpc_kitRun("kit-call", parent["id"], "{}"))

            await bridge._kit_tasks[started["run"]["id"]]
            run = bridge._kit_get("kit-call").runs[-1]

            self.assertEqual(run.status, "succeeded")
            self.assertEqual([step.type for step in run.steps], ["kit_call", "command"])
            self.assertTrue(all(step.status == "succeeded" for step in run.steps))
            self.assertIn("child", run.stdout)

    async def test_kit_call_cycle_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "kit-cycle", workspace)
            a = json.loads(bridge._rpc_kitCreate("kit-cycle", json.dumps({
                "title": "A", "command": "echo A",
            })))["kit"]
            b = json.loads(bridge._rpc_kitCreate("kit-cycle", json.dumps({
                "title": "B", "steps": [{"id": "to-a", "type": "kit_call", "kitId": a["id"]}],
            })))["kit"]

            updated = json.loads(bridge._rpc_kitUpdate("kit-cycle", a["id"], json.dumps({
                "command": "", "steps": [{"id": "to-b", "type": "kit_call", "kitId": b["id"]}],
            })))

            self.assertEqual(updated["status"], "error")
            self.assertIn("循环", updated["message"])

    async def test_client_file_push_is_atomic_and_hash_checked(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp) / "data")},
        ):
            bridge = BridgeWS()
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            self._session(bridge, "file-push", workspace)
            created = json.loads(bridge._rpc_kitCreate("file-push", json.dumps({
                "title": "deploy",
                "steps": [{
                    "id": "push", "type": "file_push", "title": "push artifact",
                    "config": {"source": "C:/client/dist/app.jar", "destination": "deploy/app.jar", "overwrite": True},
                }],
            })))["kit"]
            started = json.loads(bridge._rpc_kitRun("file-push", created["id"], "{}"))
            run_id = started["run"]["id"]
            for _ in range(100):
                run = bridge._kit_get("file-push").runs[-1]
                if run.status == "waiting_client":
                    break
                await __import__("asyncio").sleep(0.01)
            self.assertEqual(run.status, "waiting_client")
            content = b"deterministic deployment artifact"
            digest = hashlib.sha256(content).hexdigest()
            transfer_id = "kit_test_transfer_1234"
            self.assertEqual(json.loads(bridge._rpc_kitClientFileStart(
                "file-push", run_id, run.steps[0].id, transfer_id, len(content), digest,
            ))["status"], "ok")
            self.assertEqual(json.loads(bridge._rpc_kitClientFileChunk(
                "file-push", run_id, run.steps[0].id, transfer_id, 0,
                base64.b64encode(content).decode("ascii"),
            ))["status"], "ok")
            self.assertEqual(json.loads(bridge._rpc_kitClientFileFinish(
                "file-push", run_id, run.steps[0].id, transfer_id,
            ))["status"], "ok")

            await bridge._kit_tasks[run_id]
            run = bridge._kit_get("file-push").runs[-1]
            self.assertEqual(run.status, "succeeded")
            self.assertEqual((workspace / "deploy" / "app.jar").read_bytes(), content)

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

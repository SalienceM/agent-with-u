"""Session 级 Workspace Kit 状态、执行记录与数据市场。

Kit 是附着在 Session 上的标准化微任务：它有明确输入、执行过程、判言、结果视图
和可被其他 Kit 消费的输出。状态单独保存在 ``workspace-kits`` sidecar 中，避免与
持续写入的聊天 transcript 竞争。
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import paths


RUN_STATUSES = {
    "queued", "running", "evaluating", "succeeded", "failed", "error", "cancelled",
}
FINAL_RUN_STATUSES = {"succeeded", "failed", "error", "cancelled"}
CONTROL_MODES = {"ai", "human", "shared"}
SHELLS = {"powershell", "cmd", "bash"}


def _now() -> float:
    return time.time()


def _id() -> str:
    return str(uuid.uuid4())


def _dict_list(value: Any) -> list[dict]:
    return [dict(item) for item in (value or []) if isinstance(item, dict)]


def _safe_text(value: Any, limit: int = 200_000) -> str:
    return str(value or "")[:limit]


def _normalized_env_key(value: str) -> str:
    key = re.sub(r"[^A-Za-z0-9_]", "_", value or "").strip("_").upper()
    return key or "VALUE"


@dataclass
class WorkspaceKit:
    id: str
    title: str = "未命名 Kit"
    description: str = ""
    command: str = ""
    shell: str = "powershell"
    cwd: str = "."
    timeout_seconds: int = 300
    inputs: list[dict] = field(default_factory=list)
    assertions: list[dict] = field(default_factory=lambda: [
        {"type": "exit_code", "expected": 0, "label": "进程正常退出"},
    ])
    outputs: list[dict] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    schedule: dict = field(default_factory=lambda: {
        "mode": "manual", "intervalSeconds": 300, "nextRunAt": None,
    })
    view: dict = field(default_factory=lambda: {
        "default": "summary", "showLogs": True, "showData": True, "showTerminal": True,
    })
    enabled: bool = True
    control_mode: str = "shared"
    last_run_id: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "command": self.command,
            "shell": self.shell,
            "cwd": self.cwd,
            "timeoutSeconds": self.timeout_seconds,
            "inputs": self.inputs,
            "assertions": self.assertions,
            "outputs": self.outputs,
            "dependencies": self.dependencies,
            "schedule": self.schedule,
            "view": self.view,
            "enabled": self.enabled,
            "controlMode": self.control_mode,
            "lastRunId": self.last_run_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WorkspaceKit":
        shell = str(data.get("shell") or "powershell").lower()
        if shell not in SHELLS:
            shell = "powershell"
        control_mode = str(data.get("controlMode") or "shared").lower()
        if control_mode not in CONTROL_MODES:
            control_mode = "shared"
        assertions = _dict_list(data.get("assertions"))
        if not assertions:
            assertions = [{"type": "exit_code", "expected": 0, "label": "进程正常退出"}]
        schedule = dict(data.get("schedule") or {})
        mode = "interval" if schedule.get("mode") == "interval" else "manual"
        try:
            interval = max(10, int(schedule.get("intervalSeconds") or 300))
        except (TypeError, ValueError):
            interval = 300
        schedule = {
            "mode": mode,
            "intervalSeconds": interval,
            "nextRunAt": schedule.get("nextRunAt"),
        }
        view = {
            "default": str((data.get("view") or {}).get("default") or "summary"),
            "showLogs": bool((data.get("view") or {}).get("showLogs", True)),
            "showData": bool((data.get("view") or {}).get("showData", True)),
            "showTerminal": bool((data.get("view") or {}).get("showTerminal", True)),
        }
        try:
            timeout = min(86_400, max(1, int(data.get("timeoutSeconds") or 300)))
        except (TypeError, ValueError):
            timeout = 300
        return cls(
            id=str(data.get("id") or _id()),
            title=_safe_text(data.get("title") or "未命名 Kit", 160),
            description=_safe_text(data.get("description"), 4_000),
            command=_safe_text(data.get("command"), 100_000),
            shell=shell,
            cwd=_safe_text(data.get("cwd") or ".", 2_000),
            timeout_seconds=timeout,
            inputs=_dict_list(data.get("inputs")),
            assertions=assertions,
            outputs=_dict_list(data.get("outputs")),
            dependencies=[str(x) for x in (data.get("dependencies") or []) if str(x).strip()],
            schedule=schedule,
            view=view,
            enabled=bool(data.get("enabled", True)),
            control_mode=control_mode,
            last_run_id=str(data.get("lastRunId") or ""),
            created_at=float(data.get("createdAt") or _now()),
            updated_at=float(data.get("updatedAt") or _now()),
        )

    def apply_patch(self, patch: dict) -> None:
        merged = self.to_dict()
        merged.update(patch or {})
        merged["id"] = self.id
        merged["createdAt"] = self.created_at
        updated = WorkspaceKit.from_dict(merged)
        self.__dict__.update(updated.__dict__)
        self.updated_at = _now()


@dataclass
class KitAssertionResult:
    type: str
    label: str
    passed: bool
    expected: Any = None
    actual: Any = None
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "label": self.label,
            "passed": self.passed,
            "expected": self.expected,
            "actual": self.actual,
            "message": self.message,
        }


@dataclass
class KitRun:
    id: str
    kit_id: str
    session_id: str
    trigger: str = "manual"
    owner: str = "human"
    status: str = "queued"
    verdict: str = "pending"
    inputs: dict = field(default_factory=dict)
    command: str = ""
    cwd: str = ""
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    assertions: list[KitAssertionResult] = field(default_factory=list)
    artifact_ids: list[str] = field(default_factory=list)
    error: str = ""
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kitId": self.kit_id,
            "sessionId": self.session_id,
            "trigger": self.trigger,
            "owner": self.owner,
            "status": self.status,
            "verdict": self.verdict,
            "inputs": self.inputs,
            "command": self.command,
            "cwd": self.cwd,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "assertions": [item.to_dict() for item in self.assertions],
            "artifactIds": self.artifact_ids,
            "error": self.error,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitRun":
        status = str(data.get("status") or "queued")
        if status not in RUN_STATUSES:
            status = "error"
        return cls(
            id=str(data.get("id") or _id()),
            kit_id=str(data.get("kitId") or ""),
            session_id=str(data.get("sessionId") or ""),
            trigger=str(data.get("trigger") or "manual"),
            owner=str(data.get("owner") or "human"),
            status=status,
            verdict=str(data.get("verdict") or "pending"),
            inputs=dict(data.get("inputs") or {}),
            command=_safe_text(data.get("command"), 100_000),
            cwd=_safe_text(data.get("cwd"), 2_000),
            exit_code=data.get("exitCode"),
            stdout=_safe_text(data.get("stdout")),
            stderr=_safe_text(data.get("stderr")),
            assertions=[
                KitAssertionResult(
                    type=str(x.get("type") or ""),
                    label=str(x.get("label") or x.get("type") or "判言"),
                    passed=bool(x.get("passed")),
                    expected=x.get("expected"),
                    actual=x.get("actual"),
                    message=str(x.get("message") or ""),
                )
                for x in _dict_list(data.get("assertions"))
            ],
            artifact_ids=[str(x) for x in (data.get("artifactIds") or [])],
            error=_safe_text(data.get("error"), 20_000),
            started_at=data.get("startedAt"),
            ended_at=data.get("endedAt"),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class KitArtifact:
    id: str
    session_id: str
    kit_id: str
    run_id: str
    key: str
    label: str
    type: str = "text"
    value: Any = None
    path: str = ""
    media_type: str = "text/plain"
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sessionId": self.session_id,
            "kitId": self.kit_id,
            "runId": self.run_id,
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "value": self.value,
            "path": self.path,
            "mediaType": self.media_type,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitArtifact":
        return cls(
            id=str(data.get("id") or _id()),
            session_id=str(data.get("sessionId") or ""),
            kit_id=str(data.get("kitId") or ""),
            run_id=str(data.get("runId") or ""),
            key=str(data.get("key") or "result"),
            label=str(data.get("label") or data.get("key") or "结果"),
            type=str(data.get("type") or "text"),
            value=data.get("value"),
            path=str(data.get("path") or ""),
            media_type=str(data.get("mediaType") or "text/plain"),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class WorkspaceKitState:
    session_id: str
    kits: list[WorkspaceKit] = field(default_factory=list)
    runs: list[KitRun] = field(default_factory=list)
    artifacts: list[KitArtifact] = field(default_factory=list)
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        latest: dict[str, dict] = {}
        for artifact in self.artifacts:
            current = latest.get(artifact.key)
            if current is None or float(current.get("createdAt") or 0) < artifact.created_at:
                latest[artifact.key] = artifact.to_dict()
        return {
            "sessionId": self.session_id,
            "kits": [item.to_dict() for item in self.kits],
            "runs": [item.to_dict() for item in self.runs],
            "artifacts": [item.to_dict() for item in self.artifacts],
            "dataMarket": list(latest.values()),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WorkspaceKitState":
        return cls(
            session_id=str(data.get("sessionId") or ""),
            kits=[WorkspaceKit.from_dict(x) for x in _dict_list(data.get("kits"))],
            runs=[KitRun.from_dict(x) for x in _dict_list(data.get("runs"))],
            artifacts=[KitArtifact.from_dict(x) for x in _dict_list(data.get("artifacts"))],
            created_at=float(data.get("createdAt") or _now()),
            updated_at=float(data.get("updatedAt") or _now()),
        )

    def latest_artifact(self, key: str) -> Optional[KitArtifact]:
        matches = [item for item in self.artifacts if item.key == key]
        return max(matches, key=lambda item: item.created_at) if matches else None

    def compact(self) -> None:
        """限制 sidecar 增长；保留最近运行及每个数据键的近期版本。"""
        self.runs = self.runs[-100:]
        kept: list[KitArtifact] = []
        counts: dict[str, int] = {}
        for item in reversed(self.artifacts):
            count = counts.get(item.key, 0)
            if count < 20:
                kept.append(item)
                counts[item.key] = count + 1
        self.artifacts = list(reversed(kept))[-300:]


class WorkspaceKitStore:
    def __init__(self) -> None:
        self._dir = paths.sub("workspace-kits")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, session_id: str) -> Path:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)
        return self._dir / f"{safe_id}.json"

    def load(self, session_id: str) -> Optional[WorkspaceKitState]:
        path = self._path(session_id)
        if not path.exists():
            return None
        try:
            state = WorkspaceKitState.from_dict(json.loads(path.read_text(encoding="utf-8")))
            state.session_id = session_id
            return state
        except Exception as exc:
            print(f"[WorkspaceKitStore] failed to load {session_id}: {exc}")
            return None

    def create(self, session_id: str) -> WorkspaceKitState:
        state = WorkspaceKitState(session_id=session_id)
        self.save(state)
        return state

    def list_session_ids(self) -> list[str]:
        result: list[str] = []
        for path in self._dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                session_id = str(data.get("sessionId") or "").strip()
                if session_id:
                    result.append(session_id)
            except Exception:
                continue
        return result

    def save(self, state: WorkspaceKitState) -> None:
        state.updated_at = _now()
        state.compact()
        payload = json.dumps(state.to_dict(), ensure_ascii=False, indent=2)
        target = self._path(state.session_id)
        tmp = target.with_suffix(".json.tmp")
        with self._lock:
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(target)

    def delete(self, session_id: str) -> None:
        try:
            self._path(session_id).unlink(missing_ok=True)
        except Exception:
            pass


def render_kit_command(kit: WorkspaceKit, inputs: dict) -> tuple[str, dict[str, str]]:
    """把 ``{{input}}`` 替换为对应 shell 的环境变量引用，并返回安全环境变量。"""
    command = kit.command
    env: dict[str, str] = {}
    for item in kit.inputs:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        env_key = f"KIT_INPUT_{_normalized_env_key(key)}"
        value = inputs.get(key, item.get("default", ""))
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        env[env_key] = str(value if value is not None else "")
        if kit.shell == "cmd":
            reference = f"%{env_key}%"
        elif kit.shell == "bash":
            reference = f'"${env_key}"'
        else:
            reference = f"$env:{env_key}"
        command = command.replace("{{" + key + "}}", reference)
    return command, env


def resolve_kit_inputs(
    kit: WorkspaceKit, supplied: dict, state: WorkspaceKitState,
) -> tuple[dict, list[str]]:
    resolved = dict(supplied or {})
    errors: list[str] = []
    for item in kit.inputs:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        if key not in resolved or resolved[key] in (None, ""):
            source_key = str(item.get("sourceKey") or "").strip()
            artifact = state.latest_artifact(source_key) if source_key else None
            if artifact is not None:
                resolved[key] = artifact.value if artifact.value is not None else artifact.path
            elif "default" in item:
                resolved[key] = item.get("default")
        if bool(item.get("required")) and resolved.get(key) in (None, ""):
            errors.append(f"缺少必填输入：{item.get('label') or key}")
    for dependency in kit.dependencies:
        if state.latest_artifact(dependency) is None:
            errors.append(f"缺少数据依赖：{dependency}")
    return resolved, errors


def evaluate_assertions(
    assertions: list[dict],
    *,
    exit_code: Optional[int],
    stdout: str,
    stderr: str,
    working_dir: Path,
) -> list[KitAssertionResult]:
    specs = assertions or [{"type": "exit_code", "expected": 0, "label": "进程正常退出"}]
    results: list[KitAssertionResult] = []
    for spec in specs:
        kind = str(spec.get("type") or "exit_code")
        label = str(spec.get("label") or kind)
        expected = spec.get("expected")
        actual: Any = None
        passed = False
        message = ""
        try:
            if kind == "exit_code":
                expected = int(0 if expected is None else expected)
                actual = exit_code
                passed = exit_code == expected
            elif kind == "stdout_contains":
                expected = str(expected or "")
                actual = expected in stdout
                passed = bool(actual)
            elif kind == "stderr_contains":
                expected = str(expected or "")
                actual = expected in stderr
                passed = bool(actual)
            elif kind in {"stdout_regex", "stderr_regex"}:
                expected = str(expected or "")
                source = stdout if kind == "stdout_regex" else stderr
                passed = re.search(expected, source, flags=re.MULTILINE) is not None
                actual = "matched" if passed else "not matched"
            elif kind == "json_valid":
                json.loads(stdout)
                passed = True
                actual = "valid JSON"
            elif kind == "file_exists":
                expected = str(expected or spec.get("path") or "")
                root = working_dir.resolve()
                candidate = (root / expected).resolve()
                if candidate != root and root not in candidate.parents:
                    message = "文件判言路径超出 Kit 工作目录"
                else:
                    actual = candidate.exists()
                    passed = bool(actual)
            else:
                message = f"不支持的判言类型：{kind}"
        except Exception as exc:
            message = str(exc)
        results.append(KitAssertionResult(
            type=kind,
            label=label,
            passed=passed,
            expected=expected,
            actual=actual,
            message=message,
        ))
    return results


def build_artifacts(
    kit: WorkspaceKit,
    run: KitRun,
    *,
    working_dir: Path,
) -> list[KitArtifact]:
    artifacts: list[KitArtifact] = []
    for spec in kit.outputs:
        key = str(spec.get("key") or "").strip()
        if not key:
            continue
        source = str(spec.get("source") or "stdout")
        kind = str(spec.get("type") or ("file" if source == "file" else "text"))
        value: Any = None
        path = ""
        media_type = str(spec.get("mediaType") or "text/plain")
        if source == "stderr":
            value = run.stderr
        elif source == "json":
            try:
                value = json.loads(run.stdout)
                kind = "json"
                media_type = "application/json"
            except Exception:
                continue
        elif source == "file":
            relative = str(spec.get("path") or "")
            root = working_dir.resolve()
            candidate = (root / relative).resolve()
            if candidate != root and root not in candidate.parents:
                continue
            if not candidate.exists():
                continue
            path = str(candidate)
            value = path
            kind = "file"
        else:
            value = run.stdout
        artifacts.append(KitArtifact(
            id=_id(),
            session_id=run.session_id,
            kit_id=kit.id,
            run_id=run.id,
            key=key,
            label=str(spec.get("label") or key),
            type=kind,
            value=value,
            path=path,
            media_type=media_type,
        ))
    return artifacts

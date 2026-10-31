"""Kit 构建的单次登记回执；不发布、不安装、不以退出码代替制品证据。"""
from __future__ import annotations

import hashlib
import asyncio
import json
import os
import secrets
from pathlib import Path
from typing import Any

from .release_center import DEFAULT_SCAN_ROOTS, ReleaseCenterManager, _read_version_file, sha256_file

RECEIPT_ENV = "AWU_KIT_BUILD_RECEIPT"
NONCE_ENV = "AWU_KIT_BUILD_NONCE"
MAX_RECEIPT_BYTES = 1024 * 1024


async def begin_capture(manager: ReleaseCenterManager, project: Path, run_id: str, step_id: str) -> BuildCapture:
    """取消等待者不能丢失仍在建立的项目锁。尚未启动命令时等准备结束再清理。"""
    task = asyncio.create_task(asyncio.to_thread(BuildCapture, manager, project, run_id, step_id))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        def release(done: asyncio.Task) -> None:
            if not done.cancelled() and done.exception() is None:
                done.result().close()
        task.add_done_callback(release)
        raise


def _read(path: Path) -> dict[str, Any]:
    if path.is_symlink() or path.stat().st_size > MAX_RECEIPT_BYTES:
        raise ValueError("Kit 构建回执无效")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Kit 构建回执无效")
    return value


def _write_new(path: Path, value: dict[str, Any]) -> None:
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_RECEIPT_BYTES:
        raise ValueError("Kit 构建回执超过限额")
    # 只发布一次，不能用另一构建覆盖既有回执。
    with path.open("xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def register_build_receipt(candidate: dict[str, Any], env: dict[str, str] | None = None) -> None:
    """由配套登记脚本调用；普通非 Kit 构建不写额外回执。"""
    env = os.environ if env is None else env
    raw = env.get(RECEIPT_ENV, "")
    if not raw:
        return
    request_path = Path(raw)
    request = _read(request_path)
    if (request.get("schemaVersion") != 1
            or not secrets.compare_digest(str(request.get("nonce", "")), env.get(NONCE_ENV, ""))
            or Path(str(candidate.get("projectRoot", ""))).resolve() != Path(request["projectRoot"])):
        raise ValueError("Kit 构建登记身份不匹配")
    _write_new(request_path.with_suffix(".result.json"), {
        "schemaVersion": 1, "runId": request["runId"], "stepId": request["stepId"],
        "nonce": request["nonce"], "candidate": candidate,
    })


class BuildCapture:
    """短期项目锁和构建前快照，归属本次命令直到结束。"""

    def __init__(self, manager: ReleaseCenterManager, project: Path, run_id: str, step_id: str):
        self.manager = manager
        self.project = project.resolve()
        self.run_id, self.step_id = run_id, step_id
        self.nonce = secrets.token_hex(24)
        folder = manager.root / "kit-builds"
        folder.mkdir(parents=True, exist_ok=True)
        self.request_path = folder / (self.nonce + ".json")
        self.lock_path = folder / (hashlib.sha256(os.path.normcase(str(self.project)).encode()).hexdigest() + ".lock")
        self.closed = False
        try:
            _write_new(self.lock_path, {"nonce": self.nonce, "runId": run_id, "stepId": step_id})
        except FileExistsError as exc:
            raise ValueError("该项目有未结束或退出未确认的 Kit 构建，不会并发覆盖制品") from exc
        try:
            self.before_version, _ = _read_version_file(self.project)
            self.before = {item["path"]: item["sha256"] for item in manager._discover_artifacts(
                self.project, manager._config().get("scanRoots") or DEFAULT_SCAN_ROOTS, 0)}
            _write_new(self.request_path, {
                "schemaVersion": 1, "projectRoot": str(self.project),
                "runId": run_id, "stepId": step_id, "nonce": self.nonce,
            })
        except BaseException:
            self.close()
            raise

    def environment(self) -> dict[str, str]:
        return {RECEIPT_ENV: str(self.request_path), NONCE_ENV: self.nonce}

    def complete(self) -> dict[str, Any]:
        try:
            result = _read(self.request_path.with_suffix(".result.json"))
        except FileNotFoundError as error:
            raise ValueError("构建未登记本次新制品；退出成功不能代替构建回执") from error
        if any(result.get(key) != value for key, value in (
                ("schemaVersion", 1), ("runId", self.run_id), ("stepId", self.step_id), ("nonce", self.nonce))):
            raise ValueError("Kit 构建回执不属于当前步骤")
        candidate = result.get("candidate")
        if not isinstance(candidate, dict) or Path(str(candidate.get("projectRoot", ""))).resolve() != self.project:
            raise ValueError("Kit 构建项目身份不匹配")
        version, _ = _read_version_file(self.project)
        if (not candidate.get("buildId") or candidate.get("buildId") != version.get("buildId")
                or candidate.get("buildId") == self.before_version.get("buildId")):
            raise ValueError("Kit 构建没有生成属于本次的版本标识")
        artifacts = []
        for item in candidate.get("artifacts", []):
            path = Path(item["path"])
            if path.is_symlink() or not path.resolve().is_relative_to(self.project):
                raise ValueError("Kit 构建制品路径越界")
            if not path.is_file() or path.stat().st_size != item.get("size") or sha256_file(path) != item.get("sha256"):
                raise ValueError("Kit 构建制品在登记后已改变")
            if item.get("fresh") is False or self.before.get(str(path.resolve())) == item.get("sha256"):
                continue
            artifacts.append(item)
        if not artifacts:
            raise ValueError("Kit 构建没有可验证的新制品")
        return {"schemaVersion": 1, "runId": self.run_id, "stepId": self.step_id,
                "candidate": {**candidate, "artifacts": artifacts}}

    def close(self) -> None:
        if not self.closed:
            # 只释放自身锁；重启后的未知锁不可自动借用。
            if self.lock_path.exists() and _read(self.lock_path).get("nonce") == self.nonce:
                self.lock_path.unlink()
            self.closed = True

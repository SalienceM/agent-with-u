"""安装责任账本。先 durable intent，后副作用；未知交接永不自动释放或重放。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from .release_center import _process_file_lock

PROTOCOL = 1
IDENTITY_KEYS = ("ownerId", "deviceId", "instanceId", "sessionId", "runId", "stepId")
HANDOFF_PHASES = {"handing_off", "waiting_restart", "verifying", "result_unknown"}
TERMINAL_PHASES = {"succeeded", "failed", "cancelled"}


class JournalError(RuntimeError):
    pass


def fingerprint(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def durable_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    if len(data) > 1024 * 1024:
        raise JournalError("更新记录超过限额")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def read_record(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    if (path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400
            or path.parent.resolve() != path.parent.absolute() or path.stat().st_size > 1024 * 1024):
        raise JournalError("更新记录路径或大小无效")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (ValueError, OSError) as exc:
        raise JournalError("更新记录损坏；保持保护，请人工核对") from exc


class InstallJournal:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.folder = self.root / "kit-installs"
        self.folder.mkdir(parents=True, exist_ok=True)
        if self.folder.resolve() != self.folder:
            raise JournalError("更新账本不能重定向到其他目录")
        self.slot = self.folder / "reservation.json"
        self.lock = self.folder / "node.lock"

    def path(self, request_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", request_id):
            raise JournalError("安装请求 ID 无效")
        return self.folder / (request_id + ".json")

    def active(self) -> dict[str, Any]:
        with _process_file_lock(self.lock):
            slot = read_record(self.slot)
            if slot:
                # 终态已落盘、释放前崩溃：只清理匹配终态，缺失记录继续保留占用。
                record = read_record(self.path(str(slot.get("requestId") or "")))
                if record.get("identity") == slot.get("identity") and record.get("phase") in TERMINAL_PHASES:
                    self.slot.unlink()
                    return {}
            return slot

    def require_slot(self, request_id: str = "") -> None:
        active = self.active()
        if active and active.get("requestId") != request_id:
            raise JournalError("该节点已有更新预留或未知交接，不能覆盖或并发更新")
        if request_id and not active:
            raise JournalError("更新预留已失效")

    def reserve(self, request_id: str, identity: dict[str, str], *, kind: str = "kit") -> dict[str, Any]:
        path = self.path(request_id)
        if kind not in {"kit", "normal"} or (kind == "kit" and (
                set(identity) != set(IDENTITY_KEYS) or not all(isinstance(v, str) and 0 < len(v) <= 300 for v in identity.values()))):
            raise JournalError("安装请求归属无效")
        with _process_file_lock(self.lock):
            active = read_record(self.slot)
            wanted = {"schemaVersion": PROTOCOL, "requestId": request_id, "kind": kind, "identity": identity}
            if active:
                if active != wanted:
                    raise JournalError("该节点已有其他更新预留")
                record = read_record(path)
                if not record:
                    raise JournalError("更新预留落盘结果未知；只允许人工核对")
                return record
            if path.exists():
                raise JournalError("安装请求已使用，不能重放")
            # 先占用再写 intent。第二次写失败保留 slot，不让别的操作覆盖未知状态。
            durable_json(self.slot, wanted)
            record = {**wanted, "phase": "preparing", "createdAt": time.time(), "updatedAt": time.time()}
            durable_json(path, record)
            return record

    def get(self, request_id: str, identity: dict[str, str] | None = None) -> dict[str, Any]:
        record = read_record(self.path(request_id))
        if (not record or record.get("requestId") != request_id or record.get("schemaVersion") != PROTOCOL
                or identity is not None and record.get("identity") != identity):
            raise JournalError("安装记录不存在或归属不匹配")
        return record

    def update(self, request_id: str, identity: dict[str, str], patch: dict[str, Any]) -> dict[str, Any]:
        if set(patch) & {"requestId", "identity", "schemaVersion", "kind", "createdAt"}:
            raise JournalError("不能改写安装归属")
        with _process_file_lock(self.lock):
            record = self.get(request_id, identity)
            if record["phase"] in TERMINAL_PHASES:
                raise JournalError("安装记录已结束")
            if (record.get("confirmationId") and patch.get("phase", record["phase"])
                    not in HANDOFF_PHASES):
                raise JournalError("已确认交接不能回退到可重放状态")
            record.update(patch, updatedAt=time.time())
            durable_json(self.path(request_id), record)
            return record

    def freeze(self, request_id: str, identity: dict[str, str], plan: dict[str, Any]) -> dict[str, Any]:
        with _process_file_lock(self.lock):
            record = self.get(request_id, identity)
            if record["phase"] not in {"preparing", "staging", "waiting_approval", "blocked"}:
                raise JournalError("交接后的计划不可更改")
            frozen = {**plan, "identity": identity, "requestId": request_id, "protocol": PROTOCOL}
            record.update(phase="waiting_approval", plan=frozen, planFingerprint=fingerprint(frozen), updatedAt=time.time())
            durable_json(self.path(request_id), record)
            return record

    def confirm(self, request_id: str, identity: dict[str, str], plan_fingerprint: str,
                confirmation_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", confirmation_id):
            raise JournalError("确认 requestId 无效")
        with _process_file_lock(self.lock):
            record = self.get(request_id, identity)
            if (record.get("planFingerprint") != plan_fingerprint or not plan_fingerprint
                    or fingerprint(record.get("plan") or {}) != plan_fingerprint):
                raise JournalError("安装计划已变化，请重新核对")
            prior = record.get("confirmationId")
            if prior:
                if prior != confirmation_id:
                    raise JournalError("该安装请求已经确认，不能再次交接")
                return record
            if record["phase"] != "waiting_approval":
                raise JournalError("安装当前不在等待确认状态")
            record.update(phase="handing_off", confirmationId=confirmation_id, confirmedAt=time.time(), updatedAt=time.time())
            durable_json(self.path(request_id), record)
            return record

    def release(self, request_id: str, identity: dict[str, str], phase: str = "cancelled") -> dict[str, Any]:
        """仅交接前释放。交接后由绑定回执+启动验收的 reconcile 专用路径收口。"""
        with _process_file_lock(self.lock):
            record = self.get(request_id, identity)
            if record["phase"] in HANDOFF_PHASES or record.get("confirmationId"):
                raise JournalError("已交接或结果未知，不能保证取消；请只读核对安装结果")
            if phase not in TERMINAL_PHASES:
                raise JournalError("无效结束状态")
            if record["phase"] not in TERMINAL_PHASES:
                record.update(phase=phase, updatedAt=time.time())
                durable_json(self.path(request_id), record)
            if read_record(self.slot).get("requestId") == request_id:
                self.slot.unlink()
            return record

    def reconcile(self, request_id: str, identity: dict[str, str], *,
                  desktop: dict[str, Any] | None = None, backend: dict[str, Any] | None = None,
                  ready: bool = False, now: float | None = None) -> dict[str, Any]:
        """只读外部证据，不启动助手/安装/重启；有界启动验收更新本请求投影。"""
        now = time.time() if now is None else now
        with _process_file_lock(self.lock):
            record = self.get(request_id, identity)
            if record["phase"] not in HANDOFF_PHASES:
                return record
            unreadable_result = False
            try:
                result = read_record(self.path(request_id).with_suffix(".result.json"))
            except JournalError:
                result, unreadable_result = {}, True
            expected = {"protocol": PROTOCOL, "requestId": request_id, "identity": identity,
                        "planFingerprint": record["planFingerprint"]}
            valid = (bool(result) and fingerprint(record.get("plan") or {}) == record["planFingerprint"]
                     and all(result.get(k) == v for k, v in expected.items()))
            phase, message = "waiting_restart", "等待匹配的安装回执和本地桌面重连"
            if record["phase"] == "result_unknown":
                phase, message = "result_unknown", "安装交接结果未知；请只读核对原请求，不会自动重装"
            if unreadable_result:
                phase, message = "result_unknown", "安装回执不完整或不可读；保留保护，请只读核对"
            terminal = False
            if valid:
                record["receipt"] = result
                if result.get("installation") == "failed" or (
                        result.get("installation") == "succeeded" and result.get("restart") == "failed"):
                    phase, message, terminal = "failed", str(result.get("error") or "安装或重启失败"), True
                elif result.get("installation") == "unknown":
                    phase, message = "result_unknown", "安装器退出未确认；不能重放或释放预留"
                elif result.get("installation") == "succeeded" and result.get("restart") == "started":
                    target = record["plan"].get("release") or {}
                    actual = (desktop or {}).get("release") or {}
                    desktop_matches = ((desktop or {}).get("instanceId") == identity["instanceId"]
                                       and (desktop or {}).get("deviceId") == identity["deviceId"]
                                       and (desktop or {}).get("protocol") == PROTOCOL)
                    versions_match = all(target.get(k) and target[k] == actual.get(k) == (backend or {}).get(k)
                                         for k in ("buildId", "sequence", "version", "packageVersion"))
                    if ready and desktop_matches and versions_match:
                        phase, message, terminal = "succeeded", "安装回执、桌面和 Backend 完整版本及本地连接均已核对", True
                        record["verification"] = {"desktop": actual, "backend": backend, "verifiedAt": now}
                    elif ready:
                        message = "桌面、Backend 或安装实例与目标不匹配"
            if not terminal and now - float(record.get("confirmedAt") or now) >= 180:
                phase, message = "result_unknown", "启动验收超时；请显式只读核对，不会重新安装"
            record.update(phase=phase, message=message, updatedAt=now)
            durable_json(self.path(request_id), record)
            if terminal and read_record(self.slot).get("requestId") == request_id:
                self.slot.unlink()
            return record

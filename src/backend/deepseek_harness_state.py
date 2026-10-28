"""AWU 管理的 Harness home/归属回执；不在用户 ~/.dsh 中查找或回退。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from . import paths
from .deepseek_harness_config import COMMIT, VERSION, PERMISSION_MODES


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def config_fingerprint(config: Any, *, runtime: dict[str, Any], constraints: str = "") -> str:
    # 不写配置原文，连可被用户用于存密钥的 env/headers 也只参与摘要。
    return digest({"schema": 1, "version": VERSION, "commit": COMMIT,
                   "config": config.to_dict(), "runtime": runtime, "constraints": constraints})


def reject_links(path: Path) -> None:
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Harness 管理目录不允许符号链接或 reparse point")


def atomic_json(path: Path, value: Any) -> None:
    reject_links(path)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".awu-", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


@dataclass(frozen=True)
class HarnessLayout:
    root: Path
    home: Path
    runs: Path
    identity: str
    guard_root: Path
    owner: str
    executor: str
    backend: str
    session: str

    @property
    def activity_file(self) -> Path:
        return self.guard_root / "active.json"

    @classmethod
    def for_session(cls, *, owner: str, executor: str, backend: str, session: str,
                    context: str | None = None) -> "HarnessLayout":
        for value in (owner, executor, backend, session):
            if not isinstance(value, str) or not value or len(value) > 1000:
                raise ValueError("Harness 需要明确的用户/执行器/Backend/Session 身份")
        if context is not None and not re.fullmatch(r"awu-[a-f0-9]{32}", context):
            raise ValueError("Harness 隔离上下文 ID 无效")
        identity = digest([owner, executor, backend, session] + ([context] if context else []))
        # 用户提供的身份只参与哈希，不能成为相对路径/文件名。
        base = paths.sub("deepseek-harness").absolute()
        reject_links(base)
        root = base / identity
        reject_links(root)
        guard_root = base / "activity" / digest([owner, executor, session])
        reject_links(guard_root)
        return cls(root, root / "home", root / "runs", identity, guard_root, owner, executor, backend, session)

    def create(self) -> None:
        for path in (self.root, self.home, self.runs, self.guard_root):
            reject_links(path)
            path.mkdir(mode=0o700, parents=True, exist_ok=True)

    def read_metadata(self, *, cwd: str, native_id: str | None) -> dict[str, Any]:
        file = self.root / "session.json"
        reject_links(file)
        if not file.exists():
            if native_id:
                raise ValueError("Harness 原生关联元数据缺失，不能创建替代会话")
            return {"schema": 1, "identity": self.identity, "cwd": cwd, "version": VERSION,
                    "commit": COMMIT, "nativeId": "awu-" + uuid.uuid4().hex}
        if file.stat().st_size > 8192:
            raise ValueError("Harness 原生关联元数据超出限额")
        meta = json.loads(file.read_text(encoding="utf-8"))
        if (not isinstance(meta, dict) or meta.get("schema") != 1 or meta.get("identity") != self.identity
                or meta.get("version") != VERSION or meta.get("commit") != COMMIT
                or meta.get("cwd") != cwd or not isinstance(meta.get("nativeId"), str)
                or not re.fullmatch(r"awu-[a-f0-9]{32}", meta["nativeId"])):
            raise ValueError("Harness 原生关联身份/版本/工作目录不匹配，禁止替代或自动迁移")
        if native_id and native_id != meta["nativeId"]:
            raise ValueError("Harness 原生 Session ID 不匹配")
        return meta

    def save_metadata(self, meta: dict[str, Any]) -> None:
        atomic_json(self.root / "session.json", meta)


class HarnessReservation:
    """进程内注册表之外还有 OS 文件锁和持久未知退出标记。"""
    def __init__(self, layout: HarnessLayout) -> None:
        self.layout = layout
        self.handle: BinaryIO | None = None
        self.acquired = False

    def acquire(self) -> None:
        self.layout.create()
        target = self.layout.guard_root / "owner.lock"
        reject_links(target)
        handle = target.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if target.stat().st_size == 0:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise RuntimeError("Harness Session 已被另一个运行占用") from exc
        self.handle = handle
        active = self.layout.activity_file
        try:
            reject_links(active)
            if active.exists():
                raise RuntimeError("Harness 上次进程退出未确认；保留活动保护，不能重放或启动替代运行")
        except BaseException:
            self.release(confirmed=True)
            raise
        self.acquired = True

    def mark_active(self, generation: str, pid: int | None = None) -> None:
        atomic_json(self.layout.activity_file, {
            "schema": 1, "identity": self.layout.identity, "generation": generation,
            "status": "running" if pid else "starting", "pid": pid,
        })

    def release(self, *, confirmed: bool) -> None:
        if not confirmed:
            return  # 句柄与磁盘标记均保留；取消 waiter 不等于进程退出。
        if self.acquired:
            active = self.layout.activity_file
            reject_links(active)
            active.unlink(missing_ok=True)
        if self.handle:
            self.handle.close()
            self.handle = None
        self.acquired = False


def make_profile_patch(*, native_id: str, generation: str, fingerprint: str,
                       bridge: Path, cwd: str, mode: str, skip_permissions: bool,
                       skill_dirs: list[str] | None = None, skill_names: list[str] | None = None) -> list[dict[str, Any]]:
    if mode not in PERMISSION_MODES:
        raise ValueError("Harness 访问策略无效")
    if not bridge.is_absolute() or not bridge.is_file():
        raise ValueError("Harness AWU 桥未构建或缺失")
    # JSON 是 YAML 的安全子集：没有 !!js/标签/模板插值，用户正文不写入此文件。
    return [
        {"id": "session-log-deepseek", "disabled": True},
        {"id": "session-telemetry-otel", "disabled": True},
        {"id": "workspace-dependencies", "disabled": True},
        {"id": "skill-office", "disabled": True},
        {"id": "skill-filesystem", "config": {"includeDefaultRoots": False, "watch": False,
                                              "customSkillDirs": skill_dirs or []}},
        {"id": "sandbox-policy", "config": {"mode": mode, "workspaceRoot": cwd}},
        {"id": "approval", "config": {"policy": "never" if skip_permissions else "ask"}},
        {"id": "sdk-jsonrpc-server", "disabled": True},
        {"insert": [{"id": "awu-sdk-jsonrpc-server", "name": bridge.as_uri(),
                     "inject": ["sdkAppStartup", "loader"],
                     "config": {"sessionId": native_id, "generation": generation,
                                "configFingerprint": fingerprint, "permissionMode": mode,
                                "allowedSkills": skill_names or [],
                                "approvalPolicy": "never" if skip_permissions else "ask"}}]},
    ]


def reset_context(layout: HarnessLayout, *, cwd: str) -> None:
    """仅显式 /new 调用：保留旧原生历史及关联，不把清空当作恢复失败兜底。"""
    file = layout.root / "session.json"
    reject_links(file)
    if not file.exists():
        return
    reservation = HarnessReservation(layout)
    reservation.acquire()
    try:
        if file.stat().st_size > 8192:
            raise ValueError("Harness 关联元数据超限，不能重置")
        previous = json.loads(file.read_text(encoding="utf-8"))
        previous = layout.read_metadata(cwd=previous.get("cwd", ""), native_id=None)
        archive = layout.root / "bindings"
        reject_links(archive)
        archive.mkdir(mode=0o700, exist_ok=True)
        atomic_json(archive / (previous["nativeId"] + ".json"), previous)
        layout.save_metadata({"schema": 1, "identity": layout.identity, "cwd": cwd,
            "version": VERSION, "commit": COMMIT, "nativeId": "awu-" + uuid.uuid4().hex})
    finally:
        reservation.release(confirmed=True)

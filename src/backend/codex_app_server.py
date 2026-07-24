"""Small Codex app-server client for executor-local and SSH sessions.

Codex' interactive ``--remote`` flag isn't available to ``codex exec``.  The
supported integration boundary for rich clients is the app-server JSON-RPC
protocol. This module starts it directly on an AgentWithU executor or through
an OpenSSH host alias and speaks JSONL over the process' stdio streams.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional


_SSH_HOST_RE = re.compile(r"^[A-Za-z0-9_.:@-]+$")
# app-server 的 JSONL 协议会把 thread/read 的完整历史放在单行里。
# asyncio 子进程默认只有约 64KiB，普通长会话就会触发 LimitOverrunError。
# 这里只提高单行上限，不预分配内存；实际占用仍随返回内容增长。
# Codex 的 stdout 协议是“一行一个 JSON 事件”。reasoning、完整命令输出或
# thread/read 历史都可能让单行远超 asyncio 默认约 64 KiB。app-server 与
# `codex exec --json` 必须使用同一个上限，避免两条链路表现不一致。
CODEX_JSONL_STREAM_LIMIT = 128 * 1024 * 1024
# 兼容已有引用与测试名称。
APP_SERVER_STREAM_LIMIT = CODEX_JSONL_STREAM_LIMIT

# `thread/list` 把省略/空 sourceKinds 解释为仅 `cli` + `vscode`，并不是“全部”。
# 接管列表应覆盖所有用户级根会话，包括 Codex exec 与 app-server 创建的 thread；
# subAgent* 是内部编排子线程，展示出来既嘈杂也容易接管错对象。
ATTACHABLE_THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"]


def list_ssh_hosts(config_path: Optional[Path] = None) -> list[str]:
    """Return concrete host aliases from OpenSSH config.

    Pattern-only entries aren't selectable because they don't identify a
    concrete Codex machine.  ``Include`` files are deliberately not expanded;
    users can still enter such an alias manually in the session dialog.
    """
    path = config_path or (Path.home() / ".ssh" / "config")
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2 or parts[0].lower() != "host":
            continue
        for alias in parts[1:]:
            if any(ch in alias for ch in "*?!") or not _SSH_HOST_RE.fullmatch(alias):
                continue
            key = alias.lower()
            if key not in seen:
                seen.add(key)
                result.append(alias)
    return result


def validate_ssh_host(host: str) -> str:
    host = str(host or "").strip()
    if not host or not _SSH_HOST_RE.fullmatch(host) or host.startswith("-"):
        raise ValueError("无效的 SSH Remote 主机名；请使用 ~/.ssh/config 中的具体 Host 别名")
    return host


class CodexAppServerProcess:
    """One app-server JSON-RPC connection over local or SSH stdio."""

    def __init__(self, host: str = "", command: str = "codex app-server --listen stdio://",
                 *, launch_command: Optional[list[str]] = None,
                 env: Optional[dict[str, str]] = None):
        self.host = validate_ssh_host(host) if host else ""
        self.command = str(command or "codex app-server --listen stdio://").strip()
        self.launch_command = list(launch_command or [])
        self.env = env
        self.proc: Optional[asyncio.subprocess.Process] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._stderr_tail: list[str] = []
        self._queued: list[dict[str, Any]] = []
        self._next_id = 1

    async def start(self) -> None:
        if self.launch_command:
            argv = self.launch_command
        else:
            ssh = shutil.which("ssh") or "ssh"
            argv = [ssh, "-T", self.host, self.command]
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env,
                limit=CODEX_JSONL_STREAM_LIMIT,
            )
        except FileNotFoundError as exc:
            if self.launch_command:
                raise RuntimeError("未找到 Codex CLI；请在当前执行节点安装 Codex") from exc
            raise RuntimeError("未找到 OpenSSH 客户端 ssh；请先安装 Windows OpenSSH Client") from exc
        self._stderr_task = asyncio.create_task(self._read_stderr())
        try:
            await self.request("initialize", {
                "clientInfo": {
                    "name": "agent_with_u",
                    "title": "AgentWithU",
                    "version": "2.2",
                },
                "capabilities": {"experimentalApi": True},
            }, timeout=20)
            await self.notify("initialized", {})
        except Exception:
            await self.close()
            raise

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        async for raw in self.proc.stderr:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if not line:
                continue
            self._stderr_tail.append(line)
            del self._stderr_tail[:-20]
            label = self.host or "local"
            print(f"[CodexAppServer:{label}][stderr] {line}", file=sys.stderr, flush=True)

    async def send(self, obj: dict[str, Any]) -> None:
        if not self.proc or not self.proc.stdin or self.proc.returncode is not None:
            raise RuntimeError(f"Codex app-server {self.host or 'local'} 未连接")
        payload = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.proc.stdin.write(payload)
        await self.proc.stdin.drain()

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self.send({"method": method, "params": params})

    async def respond(self, request_id: Any, *, result: Any = None, error: Any = None) -> None:
        payload: dict[str, Any] = {"id": request_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result if result is not None else {}
        await self.send(payload)

    async def _read_one(self, timeout: Optional[float] = None) -> dict[str, Any]:
        if not self.proc or not self.proc.stdout:
            raise RuntimeError("Codex app-server 尚未启动")
        try:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=timeout)
        except asyncio.TimeoutError:
            raise
        except (ValueError, asyncio.LimitOverrunError) as exc:
            raise RuntimeError(
                "Codex app-server 返回的单条 JSON 事件超过安全上限（128 MiB）。"
                "通常是单次命令输出或 thread 历史过大；请缩小输出、压缩 thread，"
                "或新建会话后重试。"
            ) from exc
        if not raw:
            rc = await self.proc.wait()
            detail = "\n".join(self._stderr_tail[-6:]).strip()
            suffix = f"：{detail}" if detail else ""
            raise RuntimeError(f"Codex app-server 已退出（code {rc}）{suffix}")
        try:
            value = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Codex app-server 返回了无效协议数据：{raw[:200]!r}") from exc
        if not isinstance(value, dict):
            raise RuntimeError("Codex app-server 返回了非对象协议消息")
        return value

    async def request(self, method: str, params: dict[str, Any], timeout: float = 30) -> Any:
        request_id = self._next_id
        self._next_id += 1
        await self.send({"method": method, "id": request_id, "params": params})
        while True:
            msg = await self._read_one(timeout)
            if msg.get("id") == request_id and ("result" in msg or "error" in msg):
                if "error" in msg:
                    err = msg.get("error") or {}
                    message = err.get("message") if isinstance(err, dict) else str(err)
                    raise RuntimeError(f"Codex app-server {method} 失败：{message or err}")
                return msg.get("result")
            self._queued.append(msg)

    async def next_message(self, timeout: Optional[float] = None) -> dict[str, Any]:
        if self._queued:
            return self._queued.pop(0)
        return await self._read_one(timeout)

    async def close(self) -> None:
        proc = self.proc
        self.proc = None
        if proc and proc.returncode is None:
            if proc.stdin:
                proc.stdin.close()
            try:
                await asyncio.wait_for(proc.wait(), timeout=1.5)
            except asyncio.TimeoutError:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=1.5)
                except asyncio.TimeoutError:
                    proc.kill()
        if self._stderr_task:
            try:
                await asyncio.wait_for(self._stderr_task, timeout=1)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._stderr_task.cancel()
            self._stderr_task = None


async def list_remote_threads(host: str, command: str = "", limit: int = 100) -> list[dict[str, Any]]:
    """List resumable threads on a Codex SSH Remote host."""
    conn = CodexAppServerProcess(host, command or "codex app-server --listen stdio://")
    await conn.start()
    try:
        result = await conn.request("thread/list", {
            "limit": max(1, min(int(limit or 100), 200)),
            "sortKey": "updated_at",
            "sortDirection": "desc",
            "sourceKinds": ATTACHABLE_THREAD_SOURCE_KINDS,
            "archived": False,
        }, timeout=30)
        data = result.get("data", []) if isinstance(result, dict) else []
        return [item for item in data if isinstance(item, dict) and item.get("id")]
    finally:
        await conn.close()


def local_app_server_command(codex_cli: str, global_args: Optional[list[str]] = None) -> list[str]:
    """Build a CreateProcess-safe local app-server command, including npm shims."""
    command = [codex_cli, *(global_args or []), "app-server", "--listen", "stdio://"]
    if sys.platform == "win32" and Path(codex_cli).suffix.lower() in {".cmd", ".bat"}:
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        return [comspec, "/d", "/s", "/c", subprocess.list2cmdline(command)]
    return command


async def list_local_threads(codex_cli: str, env: Optional[dict[str, str]] = None,
                             limit: int = 100) -> list[dict[str, Any]]:
    """List native Codex threads on the AgentWithU executor node."""
    conn = CodexAppServerProcess(
        launch_command=local_app_server_command(codex_cli), env=env,
    )
    await conn.start()
    try:
        result = await conn.request("thread/list", {
            "limit": max(1, min(int(limit or 100), 200)),
            "sortKey": "updated_at",
            "sortDirection": "desc",
            "sourceKinds": ATTACHABLE_THREAD_SOURCE_KINDS,
            "archived": False,
        }, timeout=30)
        data = result.get("data", []) if isinstance(result, dict) else []
        return [item for item in data if isinstance(item, dict) and item.get("id")]
    finally:
        await conn.close()


async def read_remote_thread(host: str, thread_id: str, command: str = "") -> dict[str, Any]:
    """Read the persisted, user-visible history for one remote thread."""
    conn = CodexAppServerProcess(host, command or "codex app-server --listen stdio://")
    await conn.start()
    try:
        result = await conn.request("thread/read", {
            "threadId": str(thread_id), "includeTurns": True,
        }, timeout=45)
        thread = result.get("thread", {}) if isinstance(result, dict) else {}
        if not isinstance(thread, dict) or not thread.get("id"):
            raise RuntimeError("远端 Codex 未返回 thread 内容")
        return thread
    finally:
        await conn.close()


async def read_local_thread(codex_cli: str, thread_id: str,
                            env: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """Read one native Codex thread on the current executor node."""
    conn = CodexAppServerProcess(
        launch_command=local_app_server_command(codex_cli), env=env,
    )
    await conn.start()
    try:
        result = await conn.request("thread/read", {
            "threadId": str(thread_id), "includeTurns": True,
        }, timeout=45)
        thread = result.get("thread", {}) if isinstance(result, dict) else {}
        if not isinstance(thread, dict) or not thread.get("id"):
            raise RuntimeError("本节点 Codex 未返回 thread 内容")
        return thread
    finally:
        await conn.close()

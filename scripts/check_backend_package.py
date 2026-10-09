"""最终冻结制品门禁：自检、正常启动、认证 ping、所属进程清理和身份记录。"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import sys
import tempfile
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.backend.owned_process_tree import OwnedProcessTree

LIMIT = 32768


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def isolated_environment(root: Path) -> dict[str, str]:
    # 白名单继承：不携带模型、Relay、代理、Python 路径和桌面凭据。
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS"}}
    for name in ("home", "appdata", "localappdata", "data", "work", "tmp"):
        (root / name).mkdir()
    (root / ".awu-package-probe").touch()
    env.update(HOME=str(root / "home"), USERPROFILE=str(root / "home"),
               APPDATA=str(root / "appdata"), LOCALAPPDATA=str(root / "localappdata"),
               TEMP=str(root / "tmp"), TMP=str(root / "tmp"), TMPDIR=str(root / "tmp"),
               AGENT_WITH_U_DATA_ROOT=str(root / "data"),
               AGENT_WITH_U_PACKAGE_PROBE_ROOT=str(root), PYTHONNOUSERSITE="1")
    if os.name == "nt":
        env["PATH"] = str(Path(env["SYSTEMROOT"]) / "System32")
    else:
        env["PATH"] = "/usr/bin:/bin"
    return env


def reserve_ports() -> tuple[int, list[socket.socket]]:
    for _ in range(100):
        held: list[socket.socket] = []
        try:
            first = socket.socket()
            held.append(first)
            first.bind(("127.0.0.1", 0))
            port = first.getsockname()[1]
            if port > 65000 or 44321 <= port <= 44323:
                raise OSError("reserved")
            for adjacent in (port + 1, port + 2):
                item = socket.socket()
                held.append(item)
                item.bind(("127.0.0.1", adjacent))
            return port, held
        except OSError:
            for item in held:
                item.close()
    raise RuntimeError("endpoint-unavailable")


class ProbeProcess:
    def __init__(self) -> None:
        self.proc: Any = None
        self.tree: OwnedProcessTree | None = None
        self.readers: list[asyncio.Task[Any]] = []
        self.tails = [bytearray(), bytearray()]
        self.launch_pending = False

    async def drain(self, reader: asyncio.StreamReader, index: int) -> None:
        while chunk := await reader.read(4096):
            self.tails[index].extend(chunk)
            del self.tails[index][:-LIMIT]

    async def start(self, command: list[str], env: dict[str, str], cwd: Path) -> None:
        options = {"creationflags": 0x08000000} if os.name == "nt" else {"start_new_session": True}
        self.launch_pending = True
        try:
            self.proc = await asyncio.create_subprocess_exec(*command, env=env, cwd=cwd,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, **options)
            self.launch_pending = False
        except OSError:
            self.launch_pending = False
            raise
        self.tree = OwnedProcessTree(self.proc)
        self.readers = [asyncio.create_task(self.drain(self.proc.stdout, 0)),
                        asyncio.create_task(self.drain(self.proc.stderr, 1))]
        if os.name == "nt" and not self.tree.complete:
            raise RuntimeError("ownership-unconfirmed")
        self.proc.stdin.write(b"GO\n")
        await self.proc.stdin.drain()
        self.proc.stdin.close()

    async def stop(self) -> bool:
        if self.proc is None:
            return not self.launch_pending  # 取消创建等待不证明没有进程。
        confirmed = False
        try:
            if os.name == "nt":
                confirmed = await asyncio.wait_for(self.tree.stop(), 10)
            else:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(self.proc.wait(), 5)
                try:
                    os.killpg(self.proc.pid, 0)
                except ProcessLookupError:
                    confirmed = True
        except (OSError, asyncio.TimeoutError):
            confirmed = False
        finally:
            if self.tree:
                self.tree.release()
            for reader in self.readers:
                reader.cancel()
            await asyncio.gather(*self.readers, return_exceptions=True)
        return confirmed


async def wait_ping(probe: ProbeProcess, port: int, token: str, deadline: float) -> None:
    from websockets.asyncio.client import connect
    import inspect
    options = {"proxy": None} if "proxy" in inspect.signature(connect).parameters else {}
    while time.monotonic() < deadline:
        if probe.proc.returncode is not None:
            raise RuntimeError("startup-exited")
        try:
            async with connect(f"ws://127.0.0.1:{port}/?token={token}",
                               open_timeout=1, max_size=LIMIT, **options) as ws:
                request_id = secrets.token_hex(16)
                await ws.send(json.dumps({"id": request_id, "method": "ping", "params": []}))
                response_deadline = min(deadline, time.monotonic() + 3)
                while True:
                    value = json.loads(await asyncio.wait_for(ws.recv(), max(.01, response_deadline - time.monotonic())))
                    if value.get("id") == request_id:
                        if value.get("result") != "pong" or "error" in value:
                            raise RuntimeError("rpc-mismatch")
                        if probe.proc.returncode is not None:
                            raise RuntimeError("startup-exited")
                        return
        except (OSError, TimeoutError):
            await asyncio.sleep(.15)
        except Exception as exc:
            # 握手未就绪可重试；匹配请求的错误响应必须失败。
            if isinstance(exc, RuntimeError):
                raise
            await asyncio.sleep(.15)
    raise RuntimeError("startup-timeout")


async def verify(binary: Path, *, web: bool = False, timeout: float = 60) -> dict[str, Any]:
    report: dict[str, Any] = {"ok": False, "path": str(binary), "platform": sys.platform,
                              "stages": [], "failure": "missing-binary"}
    if not binary.is_file():
        return report
    before = digest(binary)
    report["sha256"] = before
    with tempfile.TemporaryDirectory(prefix="awu-package-", ignore_cleanup_errors=True) as temporary:
        root = Path(temporary).resolve()
        env = isolated_environment(root)
        for stage in ("components", "startup"):
            probe = ProbeProcess()
            held: list[socket.socket] = []
            try:
                command = [str(binary), "--agentwithu-package-probe"]
                if stage == "components":
                    command.append("--agentwithu-package-check")
                else:
                    port, held = reserve_ports()
                    token = secrets.token_urlsafe(32)
                    command.extend(["--bind", "127.0.0.1", "--port", str(port),
                                    "--auth-token", token])
                    if web:
                        command.extend(["--web-port", str(port + 2)])
                    for item in held:
                        item.close()
                    held = []
                deadline = time.monotonic() + timeout
                await asyncio.wait_for(probe.start(command, env, root / "work"), timeout)
                if stage == "components":
                    await asyncio.wait_for(probe.proc.wait(), max(.01, deadline - time.monotonic()))
                    await asyncio.wait_for(asyncio.gather(*probe.readers), 3)
                    try:
                        payload = json.loads(probe.tails[0].decode("utf-8"))
                    except (ValueError, UnicodeError):
                        raise RuntimeError("components-exited" if probe.proc.returncode else "components-invalid-response") from None
                    report["componentFailures"] = [item for item in payload.get("failures", [])
                                                   if isinstance(item, str) and item.startswith(("module:", "resource:"))][:64]
                    if probe.proc.returncode or payload.get("ok") is not True:
                        raise RuntimeError("components-failed")
                    report["version"] = payload.get("version", "unknown")
                else:
                    await asyncio.wait_for(wait_ping(probe, port, token, deadline), max(.01, deadline - time.monotonic()))
                    if web:
                        # 正常 Web 入口必须实际完成 HTTP 启动，不调用模型/登录。
                        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port + 2), 3)
                        writer.write(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                        await writer.drain()
                        status = await asyncio.wait_for(reader.readline(), 3)
                        writer.close()
                        await writer.wait_closed()
                        if not status.startswith(b"HTTP/1.1 200"):
                            raise RuntimeError("web-http-failed")
                report["stages"].append({"stage": stage, "ok": True})
            except Exception as exc:
                category = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
                report["failure"] = category[:80]
                report["stages"].append({"stage": stage, "ok": False})
            finally:
                for item in held:
                    item.close()
                cleaned = await probe.stop()
                report["stages"].append({"stage": stage + "-cleanup", "ok": cleaned})
                if not cleaned:
                    report["failure"] = "cleanup-unconfirmed"
            if not cleaned or not report["stages"][-2]["ok"]:
                return report
    if digest(binary) != before:
        report["failure"] = "artifact-changed"
        return report
    report.update(ok=True, failure=None)
    return report


def confirm(binary: Path, report_path: Path) -> bool:
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        return (report.get("ok") is True and report.get("path") == str(binary)
                and report.get("platform") == sys.platform and report.get("sha256") == digest(binary))
    except (OSError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--web", action="store_true")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    output = args.report or binary.with_name(binary.name + ".readiness.json")
    if args.confirm:
        return 0 if confirm(binary, output) else 1
    if not 1 <= args.timeout <= 300:
        parser.error("timeout must be 1..300 seconds")
    report = asyncio.run(verify(binary, web=args.web, timeout=args.timeout))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

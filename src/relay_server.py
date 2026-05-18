"""
AgentWithU 中继服务器 S。

C–C/S 架构里的「接线员」：本身【不执行任何东西】、【不存储会话】，只在远程
UI 客户端与执行节点之间转发消息。

    UI ──wss──> 中继 S ──(单条出站连接, 按 cid 分路)──> 执行节点 C

两类连接，靠第一条消息区分角色（与 websockets 版本无关，不依赖 URL 路径）：

  执行节点  第一条 {"t":"register","deviceId","name","token"}
            维持长连接；S 通过它下发 {"t":"open"/"data"/"close"/"ping"}。
  UI 客户端 第一条 {"t":"hello","token","deviceId"}  → 接入指定设备的会话
            或     {"t":"list","token"}               → 返回在线设备列表后关闭

鉴权：v1 单租户——所有执行节点与 UI 共用一个 token（``--token`` /
``AGENT_WITH_U_RELAY_TOKEN``）。中继本身建议再套在 nginx/Authelia 后面。

运行：
    python -m src.relay_server --bind 0.0.0.0 --port 44360 --token <TOKEN>
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import uuid

import websockets

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 44360


def _log(msg: str) -> None:
    print(f"[relay-server] {msg}", file=sys.stderr, flush=True)


class ExecutorConn:
    """一个已注册执行节点的连接。"""

    def __init__(self, ws, device_id: str, name: str):
        self.ws = ws
        self.device_id = device_id
        self.name = name
        self.cids: set[str] = set()
        self._send_lock = asyncio.Lock()

    async def send(self, obj: dict) -> None:
        async with self._send_lock:
            try:
                await self.ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass


class RelayServer:
    def __init__(self, token: str):
        self._token = token
        self._devices: dict[str, ExecutorConn] = {}     # deviceId -> ExecutorConn
        self._sessions: dict[str, object] = {}          # cid -> UI websocket

    # ── 连接入口 ────────────────────────────────────────────────────
    async def handle(self, ws) -> None:
        try:
            first_raw = await asyncio.wait_for(ws.recv(), timeout=30)
        except Exception:
            return
        try:
            first = json.loads(first_raw)
        except Exception:
            await self._reject(ws, "bad handshake")
            return

        if first.get("token") != self._token:
            await self._reject(ws, "unauthorized")
            return

        t = first.get("t")
        if t == "register":
            await self._serve_executor(ws, first)
        elif t == "hello":
            await self._serve_ui(ws, first)
        elif t == "list":
            await ws.send(json.dumps({
                "t": "devices",
                "devices": [
                    {"id": d.device_id, "name": d.name}
                    for d in self._devices.values()
                ],
            }, ensure_ascii=False))
        else:
            await self._reject(ws, f"unknown role: {t!r}")

    async def _reject(self, ws, message: str) -> None:
        try:
            await ws.send(json.dumps({"t": "error", "message": message}))
        except Exception:
            pass

    # ── 执行节点侧 ──────────────────────────────────────────────────
    async def _serve_executor(self, ws, reg: dict) -> None:
        device_id = str(reg.get("deviceId") or "").strip()
        name = str(reg.get("name") or device_id)
        if not device_id:
            await self._reject(ws, "missing deviceId")
            return

        old = self._devices.get(device_id)
        if old is not None:
            # 同一设备重连：踢掉旧连接
            try:
                await old.ws.close()
            except Exception:
                pass

        conn = ExecutorConn(ws, device_id, name)
        self._devices[device_id] = conn
        await ws.send(json.dumps({"t": "registered"}, ensure_ascii=False))
        _log(f"device online: {device_id!r} ({name}) [total={len(self._devices)}]")

        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                ft = frame.get("t")
                cid = frame.get("cid")
                if ft == "data":
                    ui = self._sessions.get(cid)
                    if ui is not None:
                        await self._safe_send(ui, frame.get("msg", ""))
                elif ft == "close":
                    ui = self._sessions.pop(cid, None)
                    conn.cids.discard(cid)
                    if ui is not None:
                        try:
                            await ui.close()
                        except Exception:
                            pass
                elif ft == "pong":
                    pass
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if self._devices.get(device_id) is conn:
                del self._devices[device_id]
            # 关掉这个设备所有 UI 会话
            for cid in list(conn.cids):
                ui = self._sessions.pop(cid, None)
                if ui is not None:
                    try:
                        await ui.close()
                    except Exception:
                        pass
            _log(f"device offline: {device_id!r} [total={len(self._devices)}]")

    # ── UI 客户端侧 ─────────────────────────────────────────────────
    async def _serve_ui(self, ws, hello: dict) -> None:
        device_id = str(hello.get("deviceId") or "").strip()
        conn = self._devices.get(device_id)
        if conn is None:
            await self._reject(ws, f"device offline: {device_id}")
            return

        cid = uuid.uuid4().hex[:16]
        self._sessions[cid] = ws
        conn.cids.add(cid)
        await conn.send({"t": "open", "cid": cid, "user": hello.get("user") or "relay"})
        await ws.send(json.dumps({"t": "ready"}, ensure_ascii=False))
        _log(f"ui session {cid} -> device {device_id!r}")

        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    await conn.send({
                        "t": "data", "cid": cid,
                        "bin": base64.b64encode(raw).decode("ascii"),
                    })
                else:
                    await conn.send({"t": "data", "cid": cid, "msg": raw})
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._sessions.pop(cid, None)
            conn.cids.discard(cid)
            # 通知执行节点结束该会话（设备可能已离线）
            live = self._devices.get(device_id)
            if live is conn:
                await conn.send({"t": "close", "cid": cid})
            _log(f"ui session {cid} closed")

    @staticmethod
    async def _safe_send(ws, payload: str) -> None:
        try:
            await ws.send(payload)
        except Exception:
            pass


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AgentWithU relay server")
    p.add_argument("--bind", default=os.environ.get("AGENT_WITH_U_RELAY_BIND", DEFAULT_HOST))
    p.add_argument("--port", type=int,
                   default=int(os.environ.get("AGENT_WITH_U_RELAY_PORT", DEFAULT_PORT)))
    p.add_argument("--token", default=os.environ.get("AGENT_WITH_U_RELAY_TOKEN", ""))
    return p.parse_args()


async def _main() -> None:
    args = _parse_args()
    if not args.token:
        _log("refusing to start: no token (set --token or AGENT_WITH_U_RELAY_TOKEN)")
        sys.exit(1)

    server = RelayServer(args.token)
    _log(f"starting on ws://{args.bind}:{args.port}")
    async with websockets.serve(
        server.handle, args.bind, args.port,
        max_size=64 * 1024 * 1024, ping_interval=20, ping_timeout=60,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass

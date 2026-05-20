"""
中继链路（执行节点侧）。

AgentWithU 的 C–C/S 架构里，本模块让「执行节点」（跑 Claude CLI、读写真实
文件的本机后端）主动拨出一条长连接到公网「中继 S」并注册自己。中继把远程
UI 客户端的会话多路复用到这一条连接上：

    UI ──wss──> 中继 S ──(单条连接, 按 cid 分路)──> 执行节点

设计要点：
  * 现有 JSON-RPC over WebSocket 协议完全不变——中继只是透明管道。
  * 每个远程 UI 会话在执行节点侧表现为一个 ``RelayClientTransport``，它
    duck-type 成一个 websocket，直接喂给 ``BridgeWS.handle_client``。
  * 执行节点对中继只保持一条出站连接；多个 UI 会话靠信封里的 ``cid`` 区分。

中继帧格式（执行节点 <-> S）：
  注册:   执行节点 -> S  {"t":"register","deviceId","name","token"}
          S -> 执行节点  {"t":"registered"} | {"t":"error","message"}
  开会话: S -> 执行节点  {"t":"open","cid","user"?}
  数据:   双向          {"t":"data","cid","msg"}            (msg 为文本帧)
                        {"t":"data","cid","bin":<base64>}   (二进制帧, 如 STT 音频)
  关会话: 双向          {"t":"close","cid"}
  保活:   S -> 执行节点  {"t":"ping"}  /  执行节点 -> S {"t":"pong"}
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Optional

import websockets


_SENTINEL = object()


def _log(msg: str) -> None:
    print(f"[relay] {msg}", file=sys.stderr, flush=True)


class RelayClientTransport:
    """把一个远程 UI 会话伪装成 websocket，喂给 BridgeWS.handle_client。

    BridgeWS 只用到 websocket 的：``async for`` 收消息、``send()`` 发消息、
    以及 ``identity`` / ``identity_src`` 两个属性。这里全部实现即可。
    """

    def __init__(self, cid: str, link: "RelayLink",
                 identity: str = "relay", identity_src: str = "relay",
                 peer: str = ""):
        self.cid = cid
        self.identity = identity
        self.identity_src = identity_src
        # peer: 远程 UI 的 IP:port，由中继在 open 帧里告知。BridgeWS 用它在
        # 「正在连接本机的 UI」列表里展示来源。
        self.peer = peer
        self._link = link
        self._queue: asyncio.Queue = asyncio.Queue()
        self._closed = False

    # ── BridgeWS 调用：发送一帧给远程 UI ────────────────────────────
    async def send(self, payload: str) -> None:
        if self._closed:
            return
        await self._link._send({"t": "data", "cid": self.cid, "msg": payload})

    # ── 中继链路调用：投递一帧入站数据 ──────────────────────────────
    def feed(self, raw) -> None:
        if not self._closed:
            self._queue.put_nowait(raw)

    def close_feed(self) -> None:
        """远程 UI 断开 / 中继链路断开时调用，让 handle_client 的循环自然结束。"""
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(_SENTINEL)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._queue.get()
        if item is _SENTINEL:
            raise StopAsyncIteration
        return item


class RelayLink:
    """执行节点侧的中继客户端：拨出、注册、维持连接、按 cid 多路复用。"""

    def __init__(self, bridge, relay_url: str, device_id: str,
                 device_name: str, token: str):
        self._bridge = bridge
        self._relay_url = relay_url
        self._device_id = device_id
        self._device_name = device_name
        self._token = token
        self._ws = None
        self._send_lock = asyncio.Lock()
        self._transports: dict[str, RelayClientTransport] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def run(self) -> None:
        """永久运行：断线后指数退避重连。"""
        backoff = 1
        while True:
            try:
                await self._connect_once()
                backoff = 1
            except Exception as e:
                _log(f"link error: {e}")
            finally:
                self._teardown_all()
            _log(f"reconnecting to {self._relay_url} in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _connect_once(self) -> None:
        async with websockets.connect(
            self._relay_url, max_size=64 * 1024 * 1024,
            ping_interval=20, ping_timeout=60,
        ) as ws:
            self._ws = ws
            await ws.send(json.dumps({
                "t": "register",
                "deviceId": self._device_id,
                "name": self._device_name,
                "token": self._token,
            }, ensure_ascii=False))
            reply = json.loads(await ws.recv())
            if reply.get("t") != "registered":
                raise RuntimeError(f"register rejected: {reply.get('message', reply)}")
            _log(f"registered as device={self._device_id!r} ({self._device_name})")

            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    await self._handle_frame(json.loads(raw))
                except Exception as e:
                    _log(f"frame error: {e}")
        self._ws = None

    async def _handle_frame(self, frame: dict) -> None:
        t = frame.get("t")
        cid = frame.get("cid")
        if t == "open":
            transport = RelayClientTransport(
                cid, self, identity=frame.get("user") or "relay",
                peer=str(frame.get("peer") or ""))
            self._transports[cid] = transport
            self._tasks[cid] = asyncio.ensure_future(
                self._run_session(cid, transport))
        elif t == "data":
            transport = self._transports.get(cid)
            if transport is not None:
                if frame.get("bin") is not None:
                    transport.feed(base64.b64decode(frame["bin"]))
                else:
                    transport.feed(frame.get("msg", ""))
        elif t == "close":
            transport = self._transports.pop(cid, None)
            if transport is not None:
                transport.close_feed()
        elif t == "ping":
            await self._send({"t": "pong"})

    async def _run_session(self, cid: str, transport: RelayClientTransport) -> None:
        """把这个远程 UI 会话当作普通客户端交给 BridgeWS 处理。"""
        try:
            await self._bridge.handle_client(transport)
        except Exception as e:
            _log(f"session {cid} error: {e}")
        finally:
            self._transports.pop(cid, None)
            self._tasks.pop(cid, None)
            await self._send({"t": "close", "cid": cid})

    async def _send(self, obj: dict) -> None:
        ws = self._ws
        if ws is None:
            return
        async with self._send_lock:
            try:
                await ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

    def _teardown_all(self) -> None:
        """连接断开：结束所有会话，让 handle_client 循环退出。"""
        for transport in list(self._transports.values()):
            transport.close_feed()
        self._transports.clear()
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()

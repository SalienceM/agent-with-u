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
import os
import sys
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

import websockets

from . import paths


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
                 peer: str = "", username: str = "", display_name: str = "",
                 can_claim_legacy: bool = False):
        self.cid = cid
        self.identity = identity
        self.identity_src = identity_src
        self.username = username
        self.display_name = display_name
        # 只能由 Relay 根据“设备主用户”关系注入；UI 自报字段不会到达这里。
        self.can_claim_legacy = bool(can_claim_legacy)
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
        self.connected = False
        self.last_error = ""
        self._registered = asyncio.Event()

    async def run(self) -> None:
        """永久运行：断线后指数退避重连。"""
        backoff = 1
        while True:
            try:
                await self._connect_once()
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = str(e)
                _log(f"link error: {e}")
            finally:
                self.connected = False
                self._teardown_all()
            _log(f"reconnecting to {self._relay_url} in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def wait_until_registered(self, timeout: float = 8.0) -> bool:
        """等待首次注册成功；超时只表示仍在重试，不会停止后台连接。"""
        try:
            await asyncio.wait_for(self._registered.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _connect_once(self) -> None:
        try:
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
                self.connected = True
                self.last_error = ""
                self._registered.set()
                _log(f"registered as device={self._device_id!r} ({self._device_name})")

                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    try:
                        await self._handle_frame(json.loads(raw))
                    except Exception as e:
                        _log(f"frame error: {e}")
        finally:
            self._ws = None
            self.connected = False

    async def _handle_frame(self, frame: dict) -> None:
        t = frame.get("t")
        cid = frame.get("cid")
        if t == "open":
            transport = RelayClientTransport(
                cid, self, identity=frame.get("user") or "relay",
                peer=str(frame.get("peer") or ""),
                username=str(frame.get("username") or ""),
                display_name=str(frame.get("displayName") or ""),
                can_claim_legacy=bool(frame.get("canClaimLegacy", False)))
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


class RelayRuntimeManager:
    """管理当前 Backend 作为 Relay 执行节点的运行期注册。

    桌面壳仍可通过环境变量在进程启动时注入配置；Web/Docker 部署则可通过
    受权限保护的 RPC 保存配置并立即重连。敏感的 Relay 主 Token 只写在服务端
    数据目录，状态响应永远只返回 ``hasToken``。
    """

    _SCHEMA = 1

    def __init__(
        self,
        bridge,
        *,
        device_id: str,
        device_name: str,
        initial_url: str = "",
        initial_token: str = "",
        config_path: Optional[Path] = None,
        link_factory: Callable[..., RelayLink] = RelayLink,
    ):
        self._bridge = bridge
        self._device_id = str(device_id or "").strip()
        self._default_device_name = str(device_name or self._device_id).strip()
        self._config_path = config_path or paths.sub("relay-node.json")
        self._link_factory = link_factory
        self._link: Optional[RelayLink] = None
        self._task: Optional[asyncio.Task] = None
        self._last_error = ""
        # 同一物理节点可能同时打开多个控制 UI；全局 Relay 配置与热重连必须串行，
        # 否则两个保存动作会争用同一个临时文件并互相取消刚创建的连接。
        self._config_lock = asyncio.Lock()

        env_url = str(initial_url or "").strip()
        env_token = str(initial_token or "").strip()
        saved = self._load_saved()
        # 明确的启动参数/环境变量优先。Docker Compose 可能只保留 URL、而 Token
        # 来自 Web UI；不能因为一个不完整的环境变量就丢掉持久卷中的另一半配置。
        # 只有 URL 与已保存 URL 相同才复用旧 Token，避免把 Token 误发给新 Relay。
        if env_url or env_token:
            saved_url = str((saved or {}).get("url") or "").strip()
            saved_token = str((saved or {}).get("token") or "").strip()
            resolved_url = env_url or saved_url
            same_saved_relay = bool(saved_url and resolved_url == saved_url)
            resolved_token = env_token or (saved_token if same_saved_relay else "")
            used_saved = bool(
                (not env_url and resolved_url)
                or (not env_token and resolved_token)
            )
            self._config = {
                "enabled": bool(resolved_url),
                "url": resolved_url,
                "token": resolved_token,
                "deviceName": str(
                    ((saved or {}).get("deviceName") if same_saved_relay else "")
                    or self._default_device_name
                ).strip()[:128],
            }
            self._source = "environment+saved" if used_saved else "environment"
        elif saved:
            self._config = saved
            self._source = "saved"
        else:
            self._config = {
                "enabled": False,
                "url": "",
                "token": "",
                "deviceName": self._default_device_name,
            }
            self._source = "default"

        # 环境变量提供的 Relay 配置过去只存在于当前容器。在线升级器重建容器
        # 后这些变量若未被 Compose 再次注入，节点就会掉出纳管。有效配置立即写入
        # /app/data/relay-node.json，后续可从持久卷自动恢复。
        if (
            self._config.get("enabled")
            and self._config.get("url")
            and self._config.get("token")
        ):
            try:
                self._validate_url(str(self._config["url"]))
                self._persist()
            except (OSError, ValueError) as error:
                _log(f"cannot persist effective Relay node configuration: {error}")

    @staticmethod
    def _validate_url(value: str) -> str:
        url = str(value or "").strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
            raise ValueError("Relay 地址必须是完整的 ws:// 或 wss:// 地址")
        return url

    def _load_saved(self) -> Optional[dict]:
        try:
            raw = json.loads(self._config_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or raw.get("schemaVersion") != self._SCHEMA:
                return None
            return {
                "enabled": bool(raw.get("enabled")),
                "url": str(raw.get("url") or "").strip(),
                "token": str(raw.get("token") or "").strip(),
                "deviceName": str(
                    raw.get("deviceName") or self._default_device_name
                ).strip()[:128],
            }
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None

    def _persist(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": self._SCHEMA,
            "enabled": bool(self._config.get("enabled")),
            "url": str(self._config.get("url") or ""),
            "token": str(self._config.get("token") or ""),
            "deviceId": self._device_id,
            "deviceName": str(self._config.get("deviceName") or ""),
            "updatedAt": int(time.time()),
        }
        temporary = self._config_path.with_suffix(self._config_path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, self._config_path)
        try:
            self._config_path.chmod(0o600)
        except OSError:
            pass

    def status(self) -> dict:
        link = self._link
        error = str(getattr(link, "last_error", "") or self._last_error)
        return {
            "supported": True,
            "enabled": bool(self._config.get("enabled")),
            "connected": bool(link and link.connected),
            "url": str(self._config.get("url") or ""),
            "hasToken": bool(self._config.get("token")),
            "deviceId": self._device_id,
            "deviceName": str(
                self._config.get("deviceName") or self._default_device_name
            ),
            "source": self._source,
            "lastError": error,
        }

    async def start(self) -> dict:
        async with self._config_lock:
            await self._restart_link()
            return self.status()

    async def stop(self) -> None:
        async with self._config_lock:
            await self._stop_link()

    async def _stop_link(self) -> None:
        task = self._task
        self._task = None
        self._link = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def _restart_link(self) -> None:
        await self._stop_link()
        self._last_error = ""
        if not self._config.get("enabled"):
            return
        url = str(self._config.get("url") or "").strip()
        token = str(self._config.get("token") or "").strip()
        if not url or not token:
            self._last_error = "Relay 已启用，但地址或主 Token 未配置"
            return
        try:
            url = self._validate_url(url)
        except ValueError as error:
            self._last_error = str(error)
            return
        self._link = self._link_factory(
            self._bridge,
            url,
            self._device_id,
            str(self._config.get("deviceName") or self._default_device_name),
            token,
        )
        self._task = asyncio.create_task(self._link.run())

    async def configure(self, config: dict) -> dict:
        if not isinstance(config, dict):
            raise ValueError("Relay 节点配置必须是对象")
        async with self._config_lock:
            enabled = bool(config.get("enabled"))
            url = str(config.get("url") or self._config.get("url") or "").strip()
            supplied_token = str(config.get("token") or "").strip()
            token = supplied_token or str(self._config.get("token") or "").strip()
            device_name = str(
                config.get("deviceName") or self._config.get("deviceName")
                or self._default_device_name
            ).strip()[:128]
            if enabled:
                url = self._validate_url(url)
                if not token:
                    raise ValueError("启用 Relay 纳管时必须填写主 Token")
            self._config = {
                "enabled": enabled,
                "url": url,
                "token": token,
                "deviceName": device_name or self._default_device_name,
            }
            self._source = "saved"
            self._persist()
            await self._restart_link()
            # 给快速可达的 Relay 一个短暂注册窗口；离线 Relay 不阻塞保存，后台继续重试。
            if self._link is not None:
                await self._link.wait_until_registered(timeout=1.5)
            return self.status()

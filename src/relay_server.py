"""
AgentWithU 中继服务器 S。

C–C/S 架构里的「接线员」：本身【不执行任何东西】、【不存储会话】，只在远程
UI 客户端与执行节点之间转发消息。

    UI ──wss──> 中继 S ──(单条出站连接, 按 cid 分路)──> 执行节点 C

两类连接，靠第一条消息区分角色（与 websockets 版本无关，不依赖 URL 路径）：

  执行节点  第一条 {"t":"register","deviceId","name","token"}
            维持长连接；S 通过它下发 {"t":"open"/"data"/"close"/"ping"}。
  UI 客户端 第一条 {"t":"hello","token","deviceId"}  → 接入指定设备的会话
            或     {"t":"list","token"}               → 返回获授权在线设备
            或     {"t":"profile","token"}            → 验证并读取当前用户

鉴权：执行节点继续使用 Relay 主 token；启用用户文件后，UI 使用各自的用户
token，Relay 注入可信 ``userId``，且只能列出/接入该用户获授权的执行端。
用户文件不存在时继续兼容原有单 token 模式；文件一旦创建便 fail-closed。

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
from pathlib import Path

import websockets

try:
    from .relay_users import RelayUserError, RelayUserStore, default_users_file
except ImportError:  # 兼容 ``python src/relay_server.py`` 的最小部署方式
    from relay_users import RelayUserError, RelayUserStore, default_users_file

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
    def __init__(self, token: str, users_file: Path | str | None = None):
        self._token = token
        self._users = RelayUserStore(users_file)
        self._devices: dict[str, ExecutorConn] = {}     # deviceId -> ExecutorConn
        self._sessions: dict[str, object] = {}          # cid -> UI websocket
        self._session_users: dict[str, str] = {}        # cid -> stable userId

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

        t = first.get("t")
        if t == "register":
            if first.get("token") != self._token:
                await self._reject(ws, "unauthorized")
                return
            await self._serve_executor(ws, first)
            return

        user = self._authenticate_ui(first.get("token"))
        if user is None:
            await self._reject(ws, "unauthorized")
            return
        profile = self._public_profile(user)
        if t == "hello":
            await self._serve_ui(ws, first, user)
        elif t == "list":
            await ws.send(json.dumps({
                "t": "devices",
                "devices": [
                    {
                        "id": d.device_id,
                        "name": d.name,
                        "isDefaultOwner": bool(
                            self._users.enabled
                            and self._users.user_is_default_for_device(user, d.device_id)
                        ),
                    }
                    for d in self._devices.values()
                    if self._can_access(user, d)
                ],
                "profile": profile,
            }, ensure_ascii=False))
        elif t == "profile":
            await ws.send(json.dumps({"t": "profile", "profile": profile}, ensure_ascii=False))
        elif t == "profile.update":
            if not self._users.enabled:
                await self._reject(ws, "legacy Relay identity is read-only")
                return
            try:
                updated = self._users.update_profile(
                    str(user.get("userId") or ""),
                    first.get("profile") if isinstance(first.get("profile"), dict) else {},
                )
            except RelayUserError as exc:
                await self._reject(ws, str(exc))
                return
            await ws.send(json.dumps(
                {"t": "profile.updated", "profile": updated}, ensure_ascii=False
            ))
        else:
            await self._reject(ws, f"unknown role: {t!r}")

    def _authenticate_ui(self, token: object) -> dict | None:
        """验证 UI token；无用户配置时保持 v1 单 token 兼容。"""
        if self._users.enabled:
            return self._users.authenticate(token)
        if token == self._token:
            return {
                "userId": "legacy",
                "username": "relay",
                "displayName": "Relay user",
                "avatarData": "",
                "avatarColor": "#64748b",
            }
        return None

    def _public_profile(self, user: dict) -> dict:
        if self._users.enabled:
            return self._users.public_profile(user)
        return {
            "userId": "legacy",
            "username": "relay",
            "displayName": "Relay user",
            "avatarData": "",
            "avatarColor": "#64748b",
            "managed": False,
        }

    def _can_access(self, user: dict, conn: ExecutorConn) -> bool:
        if not self._users.enabled:
            return True
        user_id = str(user.get("userId") or "")
        current = self._users.get_user(user_id)
        return (
            bool(user_id)
            and current is not None
            and not bool(current.get("disabled", False))
            and self._users.user_can_access(current, conn.device_id)
        )

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

        if self._users.enabled:
            users = self._users.users_for_device(device_id)
            if not users:
                await self._reject(ws, f"device is not assigned to a Relay user: {device_id}")
                return
            if not any(not bool(user.get("disabled", False)) for user in users):
                await self._reject(ws, "all users assigned to this device are disabled")
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
                    # 即便执行端持有主 token，也不能越过自己名下的 cid 给另一
                    # 执行端/用户会话注入帧。
                    if cid not in conn.cids:
                        continue
                    ui = self._sessions.get(cid)
                    if ui is not None:
                        user_id = self._session_users.get(cid, "")
                        current_user = self._users.get_user(user_id) if self._users.enabled else {}
                        if self._users.enabled and (
                            current_user is None or not self._can_access(current_user, conn)
                        ):
                            self._sessions.pop(cid, None)
                            self._session_users.pop(cid, None)
                            conn.cids.discard(cid)
                            try:
                                await ui.close()
                            except Exception:
                                pass
                            continue
                        await self._safe_send(ui, frame.get("msg", ""))
                elif ft == "close":
                    if cid not in conn.cids:
                        continue
                    ui = self._sessions.pop(cid, None)
                    self._session_users.pop(cid, None)
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
                self._session_users.pop(cid, None)
                if ui is not None:
                    try:
                        await ui.close()
                    except Exception:
                        pass
            _log(f"device offline: {device_id!r} [total={len(self._devices)}]")

    # ── UI 客户端侧 ─────────────────────────────────────────────────
    async def _serve_ui(self, ws, hello: dict, user: dict) -> None:
        device_id = str(hello.get("deviceId") or "").strip()
        conn = self._devices.get(device_id)
        if conn is None:
            await self._reject(ws, f"device offline: {device_id}")
            return
        if not self._can_access(user, conn):
            await self._reject(ws, "device is not authorized for this user")
            return

        cid = uuid.uuid4().hex[:16]
        can_claim_legacy = bool(
            self._users.enabled
            and self._users.user_is_default_for_device(user, device_id)
        )
        self._sessions[cid] = ws
        self._session_users[cid] = str(user.get("userId") or "legacy")
        conn.cids.add(cid)
        peer = ""
        try:
            addr = getattr(ws, "remote_address", None)
            if addr:
                peer = f"{addr[0]}:{addr[1]}"
        except Exception:
            pass
        await conn.send({
            "t": "open", "cid": cid,
            # 永远忽略客户端自报 user；身份只来自 Relay 验证结果。
            "user": str(user.get("userId") or "legacy"),
            "username": str(user.get("username") or "relay"),
            "displayName": str(user.get("displayName") or user.get("username") or "relay"),
            "canClaimLegacy": can_claim_legacy,
            "peer": peer,
        })
        await ws.send(json.dumps({
            "t": "ready", "profile": self._public_profile(user),
            "canClaimLegacy": can_claim_legacy,
        }, ensure_ascii=False))
        _log(f"ui session {cid} -> device {device_id!r} from {peer or '?'}")

        try:
            async for raw in ws:
                if not self._can_access(user, conn):
                    await self._reject(ws, "authorization changed; reconnect required")
                    break
                current_claim = bool(
                    self._users.enabled
                    and self._users.user_is_default_for_device(user, device_id)
                )
                if current_claim != can_claim_legacy:
                    await self._reject(ws, "default user changed; reconnect required")
                    break
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
            self._session_users.pop(cid, None)
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
    p.add_argument(
        "--users-file", default=str(default_users_file()),
        help="Relay users JSON (env: AGENT_WITH_U_RELAY_USERS_FILE)",
    )
    commands = p.add_subparsers(dest="command")
    user = commands.add_parser("user", help="manage Relay users locally")
    user_commands = user.add_subparsers(dest="user_command", required=True)

    add = user_commands.add_parser("add", help="create a user and print its one-time token")
    add.add_argument("username")
    add.add_argument("--display-name", default="")
    add.add_argument("--device", action="append", default=[], dest="devices")

    user_commands.add_parser("list", help="list users and executor grants")
    reset = user_commands.add_parser("reset-token", help="rotate a user's token")
    reset.add_argument("user")
    grant = user_commands.add_parser("grant", help="grant one executor deviceId")
    grant.add_argument("user")
    grant.add_argument("device")
    revoke = user_commands.add_parser("revoke", help="revoke one executor deviceId")
    revoke.add_argument("user")
    revoke.add_argument("device")
    set_default = user_commands.add_parser(
        "set-default", help="select the primary user allowed to claim legacy Sessions",
    )
    set_default.add_argument("user")
    set_default.add_argument("device")
    clear_default = user_commands.add_parser(
        "clear-default", help="remove the primary user selection for one executor",
    )
    clear_default.add_argument("device")
    for name in ("enable", "disable", "delete"):
        command = user_commands.add_parser(name, help=f"{name} a Relay user")
        command.add_argument("user")
    return p.parse_args()


def _run_user_command(args: argparse.Namespace) -> None:
    store = RelayUserStore(args.users_file)
    command = args.user_command
    if command == "add":
        profile, token = store.create_user(
            args.username, display_name=args.display_name, device_ids=args.devices
        )
        result = {"user": profile, "token": token}
    elif command == "list":
        result = {"users": store.list_users(), "usersFile": str(store.path)}
    elif command == "reset-token":
        profile, token = store.reset_token(args.user)
        result = {"user": profile, "token": token}
    elif command == "grant":
        result = {"user": store.set_device(args.user, args.device, granted=True)}
    elif command == "revoke":
        result = {"user": store.set_device(args.user, args.device, granted=False)}
    elif command == "set-default":
        result = {"user": store.set_default_user(args.user, args.device)}
    elif command == "clear-default":
        result = {"deviceId": store.clear_default_user(args.device)}
    elif command == "enable":
        result = {"user": store.set_disabled(args.user, False)}
    elif command == "disable":
        result = {"user": store.set_disabled(args.user, True)}
    elif command == "delete":
        result = {"user": store.delete_user(args.user)}
    else:  # pragma: no cover - argparse 保证不会进入
        raise RelayUserError(f"unknown user command: {command}")
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


async def _main() -> None:
    args = _parse_args()
    if args.command == "user":
        try:
            _run_user_command(args)
        except RelayUserError as exc:
            _log(f"user command failed: {exc}")
            raise SystemExit(2) from exc
        return
    if not args.token:
        _log("refusing to start: no token (set --token or AGENT_WITH_U_RELAY_TOKEN)")
        sys.exit(1)

    server = RelayServer(args.token, args.users_file)
    mode = "multi-user" if server._users.enabled else "legacy single-token"
    _log(f"starting on ws://{args.bind}:{args.port} [{mode}; users={args.users_file}]")
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

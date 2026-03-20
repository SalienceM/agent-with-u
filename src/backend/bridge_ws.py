"""
BridgeWS: Qt-free WebSocket bridge，替代 QWebChannel，为 Tauri 架构服务。

协议：
  Client → Server: {"id": "req-1", "method": "methodName", "params": [...]}
  Server → Client: {"id": "req-1", "result": "..."}          # 请求响应
  Server → Client: {"event": "streamDelta",    "data": "..."} # 推送事件
  Server → Client: {"event": "sessionUpdated", "data": "..."} # 推送事件

sendMessage / abortMessage 是 fire-and-forget：立即返回 null，
后续通过 streamDelta 事件异步推送结果。
"""

import asyncio
import json
import logging
import sys
import time
from typing import Optional

import websockets
import websockets.exceptions

from ..types import (
    ModelBackendConfig,
    BackendType,
    ChatMessage,
    ImageAttachment,
    ToolCallInfo,
    ThinkingBlock,
    Session,
    new_id,
)
from .session_store import SessionStore
from .backends import create_backend, ModelBackend, StreamDelta
from .instance_manager import InstanceManager
from .backend_store import BackendStore
from .app_config_store import AppConfigStore

# ── 剪贴板（非 Qt，Pillow ImageGrab，仅 Windows/macOS）──────────

def _read_clipboard_image_native() -> Optional[dict]:
    try:
        from PIL import ImageGrab
        import io, base64
        img = ImageGrab.grabclipboard()
        if img is None:
            return None
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {
            "data": b64,
            "mimeType": "image/png",
            "width": img.width,
            "height": img.height,
        }
    except Exception as e:
        print(f"[bridge_ws] clipboard read failed: {e}", file=sys.stderr)
        return None


# ── 默认后端配置（与 bridge.py 保持一致）────────────────────────

# 官方账户后端固定 ID，不可删除
OFFICIAL_BACKEND_ID = "official-claude"

DEFAULT_BACKENDS = [
    ModelBackendConfig(
        id="claude-agent-sdk-default",
        type=BackendType.CLAUDE_AGENT_SDK,
        label="Claude Code (Agent SDK)",
        model=None,
        allowed_tools=["Read", "Edit", "Bash", "Glob", "Grep", "Write"],
        skip_permissions=True,
    ),
]


def compress_messages(messages: list[ChatMessage], keep_recent: int = 6) -> str:
    """压缩早期消息，保留最近 keep_recent 条原文。（与 bridge.py 相同逻辑）"""
    if len(messages) <= keep_recent:
        return "\n\n".join(f"[{m.role.upper()}]: {m.content}" for m in messages)

    early = messages[:-keep_recent]
    recent = messages[-keep_recent:]
    parts = ["[早期对话摘要]"]
    i = 0
    while i < len(early):
        msg = early[i]
        if msg.role == "user":
            s = msg.content[:200] + "..." if len(msg.content) > 200 else msg.content
            parts.append(f"- 用户：{s}")
            if i + 1 < len(early) and early[i + 1].role == "assistant":
                a = early[i + 1]
                a_s = a.content[:200] + "..." if len(a.content) > 200 else a.content
                parts.append(f"- 助手：{a_s}")
                i += 2
                continue
        i += 1

    recent_str = "\n\n".join(f"[{m.role.upper()}]: {m.content}" for m in recent)
    return "\n\n".join(["以下是之前对话的摘要:", "\n".join(parts), "\n\n最近对话:", recent_str])


# ════════════════════════════════════════════════════════════════

class BridgeWS:
    """WebSocket bridge，业务逻辑与 Bridge（Qt）完全相同，去掉 Qt 依赖。"""

    def __init__(self, cli_path: Optional[str] = None):
        self._session_store = SessionStore()
        self._backend_store = BackendStore()
        # ★ 如果检测到内置 claude CLI，注入到默认后端配置
        self._cli_path = cli_path
        self._app_config_store = AppConfigStore()
        self._backends: dict[str, ModelBackend] = {}
        stored = self._backend_store.list()
        if stored:
            self._backend_configs: list[ModelBackendConfig] = list(stored)
        else:
            # ★ 没有持久化配置时使用默认值；若检测到内置 CLI 则自动注入 cli_path
            defaults = [
                ModelBackendConfig(
                    id=c.id, type=c.type, label=c.label, model=c.model,
                    allowed_tools=c.allowed_tools, skip_permissions=c.skip_permissions,
                    cli_path=cli_path if cli_path else c.cli_path,
                )
                for c in DEFAULT_BACKENDS
            ]
            self._backend_configs = defaults

        # ★ 官方账户后端始终存在，且排在列表第一位
        if not any(c.id == OFFICIAL_BACKEND_ID for c in self._backend_configs):
            official = ModelBackendConfig(
                id=OFFICIAL_BACKEND_ID,
                type=BackendType.CLAUDE_CODE_OFFICIAL,
                label="Claude Code 官方账户",
                skip_permissions=True,
            )
            self._backend_configs.insert(0, official)
            self._backend_store.save(official)
        self._active_sessions: dict[str, Session] = {}
        self._instance_manager = InstanceManager()
        self._clients: set = set()
        # ★ Permission gate: session_id → Future[bool]
        self._permission_gates: dict[str, "asyncio.Future[bool]"] = {}

    # ── WebSocket 基础设施 ───────────────────────────────────────

    async def _broadcast(self, msg: dict):
        if not self._clients:
            return
        payload = json.dumps(msg, ensure_ascii=False)
        await asyncio.gather(*(ws.send(payload) for ws in list(self._clients)), return_exceptions=True)

    def _emit_delta(self, delta: StreamDelta):
        asyncio.ensure_future(self._broadcast({
            "event": "streamDelta",
            "data": json.dumps(delta.to_dict(), ensure_ascii=False),
        }))

    def _emit_session_updated(self, data: dict):
        asyncio.ensure_future(self._broadcast({
            "event": "sessionUpdated",
            "data": json.dumps(data, ensure_ascii=False),
        }))

    async def handle_client(self, websocket):
        self._clients.add(websocket)
        print(f"[bridge_ws] client connected (total={len(self._clients)})", file=sys.stderr, flush=True)
        try:
            async for raw in websocket:
                req_id = None
                try:
                    req = json.loads(raw)
                    req_id = req.get("id")
                    method = req.get("method", "")
                    params = req.get("params", [])
                    result = await self._dispatch(method, params)
                    await websocket.send(json.dumps({"id": req_id, "result": result}, ensure_ascii=False))
                except Exception as e:
                    print(f"[bridge_ws] dispatch error: {e}", file=sys.stderr, flush=True)
                    if req_id is not None:
                        await websocket.send(json.dumps({"id": req_id, "error": str(e)}, ensure_ascii=False))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            print(f"[bridge_ws] client disconnected (total={len(self._clients)})", file=sys.stderr, flush=True)

    async def _dispatch(self, method: str, params: list):
        handler = getattr(self, f"_rpc_{method}", None)
        if handler is None:
            return None
        if asyncio.iscoroutinefunction(handler):
            return await handler(*params)
        return handler(*params)

    # ── RPC: 剪贴板 ─────────────────────────────────────────────

    def _rpc_readClipboardImage(self) -> str:
        img = _read_clipboard_image_native()
        return json.dumps(img, ensure_ascii=False) if img else "null"

    # ── RPC: 聊天 ────────────────────────────────────────────────

    def _rpc_sendMessage(self, payload_json: str) -> None:
        """Fire-and-forget：立即返回 null，后台异步推送 streamDelta。"""
        asyncio.ensure_future(self._handle_send_message(payload_json))
        return None

    def _rpc_abortMessage(self, backend_id: str) -> None:
        backend = self._backends.get(backend_id)
        if backend:
            backend.abort()
        return None

    # ── RPC: 命令 ────────────────────────────────────────────────

    def _rpc_executeCommand(self, payload_json: str) -> str:
        payload = json.loads(payload_json)
        command = payload.get("command", "")
        session_id = payload.get("sessionId", "")

        if command == "compact":
            session = self._active_sessions.get(session_id)
            if not session:
                return json.dumps({"status": "error", "message": "会话未找到"})
            if len(session.messages) <= 6:
                return json.dumps({"status": "skip", "message": "消息数量较少，无需压缩"})
            keep_count = 6
            removed = len(session.messages) - keep_count
            note = ChatMessage(id=new_id(), role="assistant",
                               content=f"[已压缩 {removed} 条早期消息]", timestamp=time.time())
            session.messages = [note] + session.messages[-keep_count:]
            session.updated_at = time.time()
            self._session_store.save(session, async_=True)
            self._emit_session_updated({"type": "session_compacted", "sessionId": session_id})
            return json.dumps({"status": "ok", "removed": removed, "remaining": len(session.messages)})

        elif command == "clear":
            session = self._active_sessions.get(session_id)
            if session:
                session.messages = []
                session.updated_at = time.time()
                self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"})

        elif command == "set_auto_continue":
            session = self._active_sessions.get(session_id)
            if session:
                session.auto_continue = payload.get("args", {}).get("enabled", True)
            return json.dumps({"status": "ok", "autoContinue": session.auto_continue if session else True})

        return json.dumps({"status": "error", "message": f"未知命令: {command}"})

    # ── RPC: 会话管理 ────────────────────────────────────────────

    def _rpc_createSession(self, working_dir: str, backend_id: str) -> str:
        session = Session(
            id=new_id(), title="新会话",
            created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=working_dir, backend_id=backend_id,
        )
        self._active_sessions[session.id] = session
        self._session_store.save(session, async_=True)
        return json.dumps(session.to_dict(), ensure_ascii=False)

    def _rpc_listSessions(self) -> str:
        return json.dumps(self._session_store.list(), ensure_ascii=False)

    def _rpc_loadSession(self, sid: str) -> str:
        session = self._active_sessions.get(sid) or self._session_store.load(sid)
        if session:
            self._active_sessions[sid] = session
            return json.dumps(session.to_dict(), ensure_ascii=False)
        return "null"

    def _rpc_deleteSession(self, sid: str) -> bool:
        self._active_sessions.pop(sid, None)
        self._instance_manager.delete(sid)
        return self._session_store.delete(sid)

    def _rpc_migrateSession(self, payload_json: str) -> str:
        payload = json.loads(payload_json)
        source_id = payload.get("sourceSessionId")
        target_backend_id = payload.get("targetBackendId")
        if not source_id or not target_backend_id:
            return json.dumps({"status": "error", "message": "Missing parameters"})

        source = self._active_sessions.get(source_id) or self._session_store.load(source_id)
        if not source:
            return json.dumps({"status": "error", "message": "Source session not found"})

        target_config = next((c for c in self._backend_configs if c.id == target_backend_id), None)
        if not target_config:
            return json.dumps({"status": "error", "message": f"Target backend not found: {target_backend_id}"})

        compressed = None
        if len(source.messages) > 10:
            compressed = compress_messages(source.messages, keep_recent=6)

        new_session = Session(
            id=new_id(), title=source.title,
            created_at=time.time(), updated_at=time.time(),
            messages=list(source.messages), backend_id=target_backend_id,
            working_dir=source.working_dir, auto_continue=source.auto_continue,
            max_continuations=source.max_continuations, agent_session_id=None,
        )
        self._active_sessions[new_session.id] = new_session
        self._session_store.save(new_session, async_=True)
        return json.dumps({
            "status": "ok", "newSessionId": new_session.id,
            "messageCount": len(new_session.messages),
            "compressedHistory": compressed is not None,
        }, ensure_ascii=False)

    # ── RPC: 后端配置 ────────────────────────────────────────────

    def _rpc_getBackends(self) -> str:
        result = []
        for c in self._backend_configs:
            d = c.to_dict()
            if c.id == OFFICIAL_BACKEND_ID:
                d["pinned"] = True   # 前端用于区分固定后端
            result.append(d)
        return json.dumps(result, ensure_ascii=False)

    def _rpc_saveBackend(self, config_json: str) -> None:
        data = json.loads(config_json)
        if data["id"] == OFFICIAL_BACKEND_ID:
            # 官方后端：只允许修改 env（代理）和 skipPermissions，其他字段保持固定
            existing = next((c for c in self._backend_configs if c.id == OFFICIAL_BACKEND_ID), None)
            config = ModelBackendConfig(
                id=OFFICIAL_BACKEND_ID,
                type=BackendType.CLAUDE_CODE_OFFICIAL,
                label="Claude Code 官方账户",
                skip_permissions=data.get("skipPermissions", True),
                env=data.get("env") or None,
                cli_path=existing.cli_path if existing else None,
            )
        else:
            config = ModelBackendConfig(
                id=data["id"], type=BackendType(data["type"]), label=data["label"],
                base_url=data.get("baseUrl"), model=data.get("model"), api_key=data.get("apiKey"),
                working_dir=data.get("workingDir"), allowed_tools=data.get("allowedTools"),
                skip_permissions=data.get("skipPermissions", True), env=data.get("env"),
            )
        self._backend_store.save(config)
        idx = next((i for i, c in enumerate(self._backend_configs) if c.id == config.id), -1)
        if idx >= 0:
            self._backend_configs[idx] = config
        else:
            self._backend_configs.append(config)
        self._backends.pop(config.id, None)
        return None

    def _rpc_deleteBackend(self, config_id: str) -> None:
        if config_id == OFFICIAL_BACKEND_ID:
            return None   # 官方后端不可删除
        self._backend_store.delete(config_id)
        self._backend_configs = [c for c in self._backend_configs if c.id != config_id]
        self._backends.pop(config_id, None)
        return None

    def _rpc_openLoginTerminal(self, backend_id: str = "") -> str:
        """打开终端，设好代理，启动 claude 交互模式，提示用户输入 /login。"""
        return self._open_claude_terminal(
            backend_id,
            extra_hint_lines=["echo [AgentWithU] 请输入 /login 并按回车开始登录", "echo."],
            bat_name="agentwithu_login.bat",
        )

    def _rpc_getClaudeSettings(self) -> str:
        """读取 ~/.claude/settings.json，返回 model 等字段供前端显示。"""
        from pathlib import Path as _Path
        settings_path = _Path.home() / ".claude" / "settings.json"
        try:
            if settings_path.exists():
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                return json.dumps({
                    "model": data.get("model") or "",
                }, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] getClaudeSettings error: {e}", file=sys.stderr)
        return json.dumps({"model": ""})

    def _rpc_openModelTerminal(self, backend_id: str = "") -> str:
        """打开终端，启动 claude，提示用户用 /model 换模型。"""
        hint_lines = [
            "echo [AgentWithU] 输入 /model 【模型名】 并按回车切换模型",
            "echo [AgentWithU] 常用: claude-opus-4-6 / claude-sonnet-4-6 / claude-haiku-4-5-20251001",
            "echo.",
        ]
        return self._open_claude_terminal(backend_id, hint_lines, bat_name="agentwithu_model.bat")

    def _open_claude_terminal(self, backend_id: str, extra_hint_lines: list, bat_name: str = "agentwithu_terminal.bat") -> str:
        """公共方法：设代理 → 打印提示 → 启动 claude 交互模式。"""
        import subprocess as _sp
        import sys as _sys
        import shutil as _shutil
        import urllib.request as _ur
        import tempfile as _tmp
        import os as _os

        https_proxy = ""
        cli_path = "claude"
        config = next((c for c in self._backend_configs if c.id == backend_id), None)
        if config:
            if config.env:
                https_proxy = config.env.get("HTTPS_PROXY", "") or config.env.get("https_proxy", "")
            if config.cli_path:
                cli_path = config.cli_path
        if not https_proxy:
            try:
                sys_proxies = _ur.getproxies()
                https_proxy = sys_proxies.get("https") or sys_proxies.get("http") or ""
            except Exception:
                pass

        if _sys.platform == "win32":
            bat_lines = ["@echo off"]
            if https_proxy:
                bat_lines.append(f"set HTTPS_PROXY={https_proxy}")
                bat_lines.append(f"set HTTP_PROXY={https_proxy}")
                bat_lines.append(f"echo [AgentWithU] 已设置代理: {https_proxy}")
            else:
                bat_lines.append("echo [AgentWithU] 未检测到代理，若连接失败请先开启 VPN/代理")
            bat_lines.extend(extra_hint_lines)
            bat_lines.append(cli_path)

            bat_path = _os.path.join(_os.environ.get("TEMP", _tmp.gettempdir()), bat_name)
            try:
                with open(bat_path, "w", encoding="gbk", errors="replace") as f:
                    f.write("\r\n".join(bat_lines) + "\r\n")
            except Exception as e:
                return json.dumps({"status": "error", "message": f"写入脚本失败: {e}"})
            _sp.Popen(['cmd.exe', '/K', bat_path], creationflags=_sp.CREATE_NEW_CONSOLE)
        else:
            set_proxy = f'export HTTPS_PROXY="{https_proxy}"; export HTTP_PROXY="{https_proxy}"; ' if https_proxy else ""
            hints = "; ".join(extra_hint_lines)
            cmd_body = f'{set_proxy}{hints}; {cli_path}; exec bash'
            launched = False
            for term, args in [
                ('gnome-terminal', ['--', 'bash', '-c', cmd_body]),
                ('xterm',          ['-e', 'bash', '-c', cmd_body]),
                ('konsole',        ['--noclose', '-e', 'bash', '-c', cmd_body]),
                ('open',           ['-a', 'Terminal', '--args', '-c', cmd_body]),
            ]:
                if _shutil.which(term):
                    _sp.Popen([term] + args)
                    launched = True
                    break
            if not launched:
                return json.dumps({"status": "error", "message": "未找到可用终端"})

        return json.dumps({"status": "ok"})

    # ── RPC: 数据导入导出 ────────────────────────────────────────

    async def _rpc_exportData(self, target_path: str) -> str:
        try:
            import tarfile, tempfile
            from pathlib import Path
            with tempfile.TemporaryDirectory() as tmpdir:
                tmppath = Path(tmpdir)
                sessions_tar = tmppath / "sessions.tar.gz"
                if not self._session_store.export_all(str(sessions_tar)):
                    return json.dumps({"status": "error", "message": "导出会话失败"}, ensure_ascii=False)
                backends_json = tmppath / "backends.json"
                self._backend_store.export_config(str(backends_json))
                with tarfile.open(target_path, "w:gz") as tar:
                    tar.add(sessions_tar, arcname="sessions.tar.gz")
                    tar.add(backends_json, arcname="backends.json")
            return json.dumps({"status": "ok", "message": "导出成功"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    async def _rpc_importData(self, source_path: str) -> str:
        try:
            import tarfile, tempfile
            from pathlib import Path
            with tempfile.TemporaryDirectory() as tmpdir:
                tmppath = Path(tmpdir)
                with tarfile.open(source_path, "r:gz") as tar:
                    tar.extractall(tmpdir)
                sessions_count = 0
                sessions_tar = tmppath / "sessions.tar.gz"
                if sessions_tar.exists():
                    before = len(self._session_store.list())
                    if self._session_store.import_all(str(sessions_tar)):
                        sessions_count = len(self._session_store.list()) - before
                backends_count = 0
                backends_json = tmppath / "backends.json"
                if backends_json.exists():
                    before = len(self._backend_store.list())
                    if self._backend_store.import_config(str(backends_json)):
                        backends_count = len(self._backend_store.list()) - before
                    stored = self._backend_store.list()
                    if stored:
                        self._backend_configs = list(stored)
            return json.dumps({
                "status": "ok", "message": "导入成功",
                "sessions": sessions_count, "backends": backends_count,
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ── RPC: 应用配置 ────────────────────────────────────────────

    def _rpc_getAppConfig(self) -> str:
        return json.dumps(self._app_config_store.get_all(), ensure_ascii=False)

    def _rpc_setAppConfig(self, config_json: str) -> str:
        try:
            self._app_config_store.set_all(json.loads(config_json))
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ── RPC: Claude OAuth Token 获取 ────────────────────────────

    async def _rpc_startOAuthFlow(self) -> str:
        """
        自行实现 OAuth PKCE 流程（不依赖 claude CLI setup-token，
        避免非 TTY 环境下 redirect_uri 缺失的问题）。

        流程:
          1. 生成 PKCE code_verifier / code_challenge
          2. 在本地随机端口启动 HTTP 回调服务器
          3. 构造完整 OAuth URL（含 redirect_uri）并打开浏览器
          4. 等待浏览器回调（最长 5 分钟）
          5. 用 authorization_code 换 access_token
          6. 保存到 ~/.claude/.credentials.json 并返回 token

        返回 JSON: {"token": "sk-ant-oat01-...", "error": null}
                or {"token": null, "error": "错误信息"}
        """
        import secrets
        import hashlib
        import base64
        import socket
        import time
        import urllib.parse
        import webbrowser
        import threading
        from pathlib import Path
        from http.server import HTTPServer, BaseHTTPRequestHandler

        # OAuth 配置（来自 claude CLI 源码 gq8 常量）
        CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
        AUTH_URL = "https://claude.ai/oauth/authorize"
        TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
        SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers"
        TIMEOUT = 300  # 5 分钟

        # 1. 生成 PKCE
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b"=").decode()
        state = secrets.token_urlsafe(32)

        # 2. 找可用本地端口
        with socket.socket() as _s:
            _s.bind(("127.0.0.1", 0))
            port = _s.getsockname()[1]

        redirect_uri = f"http://localhost:{port}/callback"

        # 3. 构造完整 OAuth URL
        auth_url = AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": SCOPES,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        })

        # 4. 启动本地回调服务器（只接收一个请求）
        callback_result: dict = {}
        callback_event = threading.Event()
        _state = state  # 闭包捕获

        class _CallbackHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):  # 静默日志
                pass

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                qs = urllib.parse.parse_qs(parsed.query)
                code = (qs.get("code") or [None])[0]
                ret_state = (qs.get("state") or [None])[0]
                error = (qs.get("error") or [None])[0]

                if error:
                    callback_result["error"] = error
                elif ret_state != _state:
                    callback_result["error"] = "state 不匹配，疑似 CSRF"
                elif code:
                    callback_result["code"] = code
                else:
                    callback_result["error"] = "回调中无授权码"

                body = b"<html><body><h2>Login successful!</h2><p>You can close this tab now.</p></body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                callback_event.set()

        server = HTTPServer(("127.0.0.1", port), _CallbackHandler)

        def _serve():
            server.handle_request()
            server.server_close()

        threading.Thread(target=_serve, daemon=True).start()

        # 5. 打开浏览器
        print(f"[OAuth] 打开授权页面: {auth_url}", file=sys.stderr, flush=True)
        webbrowser.open(auth_url)

        # 6. 等待回调（asyncio 非阻塞）
        loop = asyncio.get_event_loop()
        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, lambda: callback_event.wait(TIMEOUT)),
                timeout=TIMEOUT + 5,
            )
        except asyncio.TimeoutError:
            return json.dumps({"token": None, "error": "登录超时（5 分钟），请重试"}, ensure_ascii=False)

        if "error" in callback_result:
            return json.dumps({"token": None, "error": f"OAuth 错误: {callback_result['error']}"}, ensure_ascii=False)

        code = callback_result.get("code")
        if not code:
            return json.dumps({"token": None, "error": "未收到授权码"}, ensure_ascii=False)

        # 7. 用 code 换 access_token
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    TOKEN_URL,
                    json={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": redirect_uri,
                        "client_id": CLIENT_ID,
                        "code_verifier": code_verifier,
                        "state": state,
                    },
                    headers={"Content-Type": "application/json"},
                )
            if resp.status_code != 200:
                return json.dumps({
                    "token": None,
                    "error": f"Token 交换失败 ({resp.status_code}): {resp.text[:300]}",
                }, ensure_ascii=False)

            data = resp.json()
            access_token: Optional[str] = data.get("access_token")
            if not access_token:
                return json.dumps({"token": None, "error": f"响应中无 access_token: {str(data)[:300]}"}, ensure_ascii=False)

            # 8. 构造 OAuth 数据并保存到 ~/.claude/.credentials.json
            # Claude Code CLI 期望格式: {"claudeAiOauth": {"accessToken": ..., "refreshToken": ..., "expiresAt": ms, "scopes": [...]}}
            expires_at_ms = int(time.time() * 1000) + int(data.get("expires_in", 28800)) * 1000
            oauth_data: dict = {
                "accessToken": access_token,
                "expiresAt": expires_at_ms,
                "scopes": [s for s in SCOPES.split() if s],
            }
            if "refresh_token" in data:
                oauth_data["refreshToken"] = data["refresh_token"]

            creds_path = Path.home() / ".claude" / ".credentials.json"
            creds_path.parent.mkdir(parents=True, exist_ok=True)
            # 读旧文件只保留非 OAuth 字段，清除旧格式的顶层 accessToken/refreshToken/expiresAt
            creds: dict = {}
            if creds_path.exists():
                try:
                    old = json.loads(creds_path.read_text(encoding="utf-8"))
                    # 保留非 OAuth 顶层字段（如 otelLevel 等），删除旧格式 OAuth 字段
                    creds = {k: v for k, v in old.items()
                             if k not in ("accessToken", "refreshToken", "expiresAt", "claudeAiOauth")}
                except Exception:
                    pass
            creds["claudeAiOauth"] = oauth_data
            creds_path.write_text(json.dumps(creds, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[OAuth] Token 已保存到 {creds_path} (claudeAiOauth 格式)", file=sys.stderr, flush=True)

            # 返回 plain access_token，前端存入 ANTHROPIC_AUTH_TOKEN，每次调用显式传递
            return json.dumps({"token": access_token, "error": None}, ensure_ascii=False)

        except Exception as e:
            return json.dumps({"token": None, "error": f"Token 交换异常: {e}"}, ensure_ascii=False)

    # ── 权限门控 RPC ─────────────────────────────────────────────

    def _rpc_grantPermission(self, session_id: str, granted: bool) -> None:
        """前端响应权限请求：granted=True 继续执行，False 取消。"""
        gate = self._permission_gates.get(session_id)
        if gate and not gate.done():
            gate.set_result(granted)

    async def _await_permission_grant(
        self,
        session_id: str,
        message_id: str,
        tools: list,
        timeout: float = 300.0,
    ) -> bool:
        """
        向所有已连接客户端推送 permissionRequest 事件，
        挂起当前 coroutine 直到前端调用 grantPermission 或超时。
        """
        loop = asyncio.get_event_loop()
        gate: "asyncio.Future[bool]" = loop.create_future()
        self._permission_gates[session_id] = gate

        await self._broadcast({
            "event": "permissionRequest",
            "data": json.dumps({
                "sessionId": session_id,
                "messageId": message_id,
                "tools": [tc.to_dict() for tc in tools],
            }, ensure_ascii=False),
        })
        try:
            return await asyncio.wait_for(asyncio.shield(gate), timeout=timeout)
        except asyncio.TimeoutError:
            logging.warning(f"[bridge_ws] Permission request timed out for session {session_id}")
            return False
        finally:
            self._permission_gates.pop(session_id, None)

    # ════════════════════════════════════════════════════════════
    #  核心：带自动续跑的流式发送（与 bridge.py _async_send 相同逻辑）
    # ════════════════════════════════════════════════════════════

    def _get_backend(self, config_id: str) -> ModelBackend:
        if config_id in self._backends:
            return self._backends[config_id]
        config = next((c for c in self._backend_configs if c.id == config_id), None)
        if not config:
            raise ValueError(f"未找到后端配置: {config_id}")
        backend = create_backend(config)
        self._backends[config_id] = backend
        return backend

    async def _handle_send_message(self, payload_json: str):
        payload = json.loads(payload_json)
        session_id = payload["sessionId"]
        content = payload["content"]
        backend_id = payload["backendId"]
        raw_images = payload.get("images")
        auto_continue = payload.get("autoContinue", True)
        # skip_permissions 优先级：前端 payload 显式值 > backend 配置 > 默认 True
        if "skipPermissions" in payload:
            skip_permissions = bool(payload["skipPermissions"])
        else:
            backend_cfg = next((c for c in self._backend_configs if c.id == backend_id), None)
            skip_permissions = getattr(backend_cfg, "skip_permissions", True)
        working_dir = payload.get("workingDir")

        images = [ImageAttachment(**img) for img in raw_images] if raw_images else None

        session = self._active_sessions.get(session_id)
        if not session:
            session = self._session_store.load(session_id)
            if not session:
                session = Session(
                    id=session_id, title=content[:50] or "新会话",
                    created_at=time.time(), updated_at=time.time(),
                    messages=[], working_dir=working_dir or ".", backend_id=backend_id,
                )
            self._active_sessions[session_id] = session

        if backend_id and backend_id != session.backend_id:
            session.backend_id = backend_id
            session.agent_session_id = None

        session.auto_continue = auto_continue

        user_msg = ChatMessage(id=new_id(), role="user", content=content, images=images)
        session.messages.append(user_msg)

        assistant_id = payload.get("messageId") or new_id()
        assistant_msg = ChatMessage(
            id=assistant_id, role="assistant", content="",
            backend_id=backend_id, streaming=True,
        )
        session.messages.append(assistant_msg)

        await self._async_send(
            session, content, images, backend_id, assistant_id,
            auto_continue=auto_continue, skip_permissions=skip_permissions,
        )

    async def _async_send(
        self,
        session: Session,
        content: str,
        images: Optional[list[ImageAttachment]],
        backend_id: str,
        message_id: str,
        auto_continue: bool = True,
        skip_permissions: bool = True,
    ):
        backend = self._get_backend(backend_id)
        assistant_msg = session.messages[-1]
        max_continuations = session.max_continuations

        all_text: list[str] = []
        all_thinking: list[str] = []
        all_tool_calls: list[ToolCallInfo] = []
        total_input_tokens = 0
        total_output_tokens = 0

        current_content = content
        current_images = images
        success = True
        retry_count = 0
        max_retry = 0  # 暂时禁用 resume_failed 重试（逻辑待整理）

        for iteration in range(max_continuations + 1):
            iter_text: list[str] = []
            iter_thinking: list[str] = []
            iter_tools: list[ToolCallInfo] = []
            iter_usage: Optional[dict] = None
            retry_state = {"without_session": False}

            def on_delta(delta: StreamDelta):
                nonlocal iter_usage
                if delta.type == "done":
                    if delta.usage:
                        iter_usage = delta.usage
                    return
                if delta.type == "resume_failed":
                    retry_state["without_session"] = True
                    return
                if delta.type == "text_delta" and delta.text:
                    iter_text.append(delta.text)
                elif delta.type == "thinking" and delta.text:
                    iter_thinking.append(delta.text)
                elif delta.type == "tool_start" and delta.tool_call:
                    tc = ToolCallInfo(
                        id=delta.tool_call.get("id", ""),
                        name=delta.tool_call.get("name", "unknown"),
                        input=delta.tool_call.get("input"),
                        output=None,
                        status=delta.tool_call.get("status", "running"),
                    )
                    iter_tools.append(tc)
                elif delta.type == "tool_input" and delta.tool_call:
                    input_delta = delta.tool_call.get("inputDelta", "")
                    if iter_tools and input_delta:
                        iter_tools[-1].input = (iter_tools[-1].input or "") + input_delta
                elif delta.type == "tool_result" and delta.tool_call:
                    tc_id = delta.tool_call.get("id", "")
                    for tc in iter_tools:
                        if tc.id == tc_id:
                            tc.output = delta.tool_call.get("output")
                            tc.status = delta.tool_call.get("status", "done")
                            # ★ 从 Edit 工具的 input JSON 中提取 diff 数据
                            if tc.name in ("Edit", "MultiEdit") and tc.input:
                                try:
                                    inp = json.loads(tc.input)
                                    old_str = inp.get("old_string", "")
                                    new_str = inp.get("new_string", "")
                                    if old_str or new_str:
                                        tc.diff_path = inp.get("file_path", "")
                                        tc.diff_before = old_str
                                        tc.diff_after = new_str
                                        # 把 diff 注入 delta 传给前端
                                        delta.tool_call = {
                                            **delta.tool_call,
                                            "diff": {
                                                "path": tc.diff_path,
                                                "old": old_str,
                                                "new": new_str,
                                            },
                                        }
                                except Exception:
                                    pass
                            break
                self._emit_delta(delta)

            try:
                has_agent_session = bool(session.agent_session_id)
                need_compress = len(session.messages) > 10 and not has_agent_session
                send_content = current_content

                if iteration == 0:
                    if need_compress:
                        compressed = compress_messages(session.messages[:-1], keep_recent=6)
                        send_content = (
                            f"以下是之前对话的摘要，供你参考：\n\n{compressed}"
                            f"\n\n---\n\n请继续回答用户的问题：\n{current_content}"
                        )
                    msgs_for_backend = session.messages[:-1]
                else:
                    if retry_state["without_session"] and need_compress:
                        compressed = compress_messages(session.messages[:-1], keep_recent=6)
                        send_content = (
                            f"以下是之前对话的摘要，供你参考：\n\n{compressed}"
                            f"\n\n---\n\n请继续回答用户的问题：\n{current_content}"
                        )
                    msgs_for_backend = list(session.messages[:-1])
                    if all_text:
                        msgs_for_backend.append(ChatMessage(id=new_id(), role="assistant", content="".join(all_text)))
                    msgs_for_backend.append(ChatMessage(id=new_id(), role="user", content=current_content))

                use_agent_session = session.agent_session_id
                result = await backend.send_message(
                    messages=msgs_for_backend, content=send_content,
                    images=current_images, session_id=session.id, message_id=message_id,
                    on_delta=on_delta, agent_session_id=use_agent_session,
                    working_dir=session.working_dir, skip_permissions=skip_permissions,
                )

                if use_agent_session and result.get("agentSessionId") != use_agent_session:
                    session.agent_session_id = None
                    retry_state["without_session"] = True

                if not retry_state["without_session"]:
                    all_text.extend(iter_text)
                    all_thinking.extend(iter_thinking)
                    all_tool_calls.extend(iter_tools)
                    if iter_usage:
                        total_input_tokens += iter_usage.get("inputTokens", 0)
                        total_output_tokens += iter_usage.get("outputTokens", 0)
                    if result.get("agentSessionId"):
                        session.agent_session_id = result["agentSessionId"]

                stop_reason = result.get("stopReason", "end_turn")

                if retry_state["without_session"] and retry_count < max_retry:
                    retry_count += 1
                    session.agent_session_id = None
                    continue

                if stop_reason == "max_tokens" and auto_continue and iteration < max_continuations:
                    # ★ 权限门控：未跳过确认时，auto-continue 前请求用户确认
                    if not skip_permissions and iter_tools:
                        granted = await self._await_permission_grant(
                            session.id, message_id, iter_tools
                        )
                        if not granted:
                            self._emit_delta(StreamDelta(
                                session.id, message_id, "text_delta",
                                text="\n\n> ⛔ **Auto-continue cancelled by user.**\n",
                            ))
                            break
                    indicator = f"\n\n> ⟳ **Auto-continuing** ({iteration + 2}/{max_continuations + 1})...\n\n"
                    self._emit_delta(StreamDelta(session.id, message_id, "text_delta", text=indicator))
                    all_text.append(indicator)
                    current_content = "Continue exactly from where you left off. Do not repeat any content you already generated."
                    current_images = None
                    continue
                else:
                    break

            except Exception as e:
                all_text.extend(iter_text)
                all_thinking.extend(iter_thinking)
                all_tool_calls.extend(iter_tools)
                self._emit_delta(StreamDelta(session.id, message_id, "error", error=str(e)))
                success = False
                break

        assistant_msg.content = "".join(all_text)
        assistant_msg.streaming = False
        if all_tool_calls:
            assistant_msg.tool_calls = all_tool_calls
        if all_thinking:
            assistant_msg.thinking_blocks = [ThinkingBlock(content="".join(all_thinking))]

        final_usage = None
        if total_input_tokens or total_output_tokens:
            final_usage = {"inputTokens": total_input_tokens, "outputTokens": total_output_tokens}
            assistant_msg.usage = final_usage

        if success:
            self._emit_delta(StreamDelta(session.id, message_id, "done", usage=final_usage))

        session.updated_at = time.time()
        if session.title in ("新会话", "New session", "") and content:
            session.title = content[:50]
        self._session_store.save(session, async_=True)

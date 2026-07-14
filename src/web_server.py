"""Small authenticated HTTP server for the portable single-binary web build."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import mimetypes
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .backend.device_auth import DeviceAuthStore, SESSION_COOKIE, cookie_value


log = logging.getLogger(__name__)

MAX_HEADER_BYTES = 64 * 1024
MAX_BODY_BYTES = 64 * 1024


def _login_page(status: dict | None = None) -> bytes:
    status = status or {}
    blocked = bool(status.get("blocked"))
    remaining = int(status.get("remainingAttempts", 3))
    blocked_until = float(status.get("blockedUntil", 0))
    initial_message = (
        f"此 IP 已暂停访问，解除时间：{blocked_until:.0f}"
        if blocked else f"剩余尝试次数：{remaining}"
    )
    disabled = "disabled" if blocked else ""
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentWithU 设备验证</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5edf8;font-family:system-ui,"Microsoft YaHei",sans-serif}}
.card{{width:min(420px,calc(100vw - 32px));padding:34px;border:1px solid #24344d;border-radius:20px;background:rgba(20,30,48,.96);box-shadow:0 24px 80px #0008}}
.logo{{font-weight:800;font-size:25px;color:#67e8f9}}h1{{font-size:19px;margin:24px 0 8px}}p{{color:#96a7bd;line-height:1.7;font-size:14px}}
input{{width:100%;margin:18px 0 12px;padding:15px;text-align:center;letter-spacing:.22em;text-transform:uppercase;font-size:20px;border:1px solid #344966;border-radius:11px;background:#090f1a;color:#fff;outline:none}}
input:focus{{border-color:#22d3ee;box-shadow:0 0 0 3px #22d3ee22}}button{{width:100%;padding:13px;border:0;border-radius:11px;background:#0891b2;color:white;font-weight:700;cursor:pointer}}button:disabled{{opacity:.45;cursor:not-allowed}}
#msg{{min-height:22px;margin-top:14px;color:#fda4af;font-size:13px}}.hint{{border-top:1px solid #26364d;margin-top:20px;padding-top:16px;font-size:12px;color:#71839a}}
</style></head><body><main class="card"><div class="logo">AgentWithU</div><h1>输入本次启动的 Device 码</h1>
<p>Device 码显示在服务器启动窗口中。验证后，本浏览器会保持登录 12 小时。</p>
<form id="form"><input id="code" autocomplete="one-time-code" maxlength="9" placeholder="XXXX-XXXX" {disabled}><button {disabled}>进入 AgentWithU</button></form>
<div id="msg">{html.escape(initial_message)}</div><div class="hint">连续输错 3 次后，该 IP 将被暂停服务并写入安全审计记录。</div></main>
<script>const f=document.getElementById('form'),m=document.getElementById('msg'),c=document.getElementById('code');
f.addEventListener('submit',async e=>{{e.preventDefault();m.textContent='验证中…';try{{const r=await fetch('/device-auth/login',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{code:c.value}})}});const d=await r.json();if(r.ok)location.replace('/');else{{m.textContent=d.blocked?'此 IP 已暂停访问':`Device 码错误，剩余 ${{d.remainingAttempts}} 次`;if(d.blocked){{c.disabled=true;f.querySelector('button').disabled=true}}}}}}catch(e){{m.textContent='无法连接服务器'}}}});c?.focus();</script>
</body></html>"""
    return page.encode("utf-8")


class PortableWebServer:
    def __init__(
        self,
        *,
        bind_host: str,
        port: int,
        ws_port: int,
        web_root: Path,
        auth: DeviceAuthStore,
        bridge,
        public_ws_url: str = "",
    ) -> None:
        self.bind_host = bind_host
        self.port = int(port)
        self.ws_port = int(ws_port)
        self.web_root = Path(web_root).resolve()
        self.auth = auth
        self.bridge = bridge
        self.public_ws_url = public_ws_url.strip()

    async def start(self):
        if not (self.web_root / "index.html").is_file():
            raise RuntimeError(f"frontend dist not found: {self.web_root}")
        server = await asyncio.start_server(self._handle, self.bind_host, self.port)
        log.info("[web] UI listening on http://%s:%s", self.bind_host, self.port)
        return server

    @staticmethod
    def _peer_ip(writer: asyncio.StreamWriter) -> str:
        peer = writer.get_extra_info("peername")
        return str(peer[0]) if peer else "unknown"

    @staticmethod
    def _parse_headers(raw: bytes) -> tuple[str, str, dict[str, str]]:
        lines = raw.decode("iso-8859-1", errors="replace").split("\r\n")
        first = lines[0].split(" ", 2)
        if len(first) < 2:
            raise ValueError("bad request line")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            key, sep, value = line.partition(":")
            if sep:
                headers[key.strip().lower()] = value.strip()
        return first[0].upper(), first[1], headers

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw_headers = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
            if len(raw_headers) > MAX_HEADER_BYTES:
                await self._respond(writer, 431, b"headers too large")
                return
            method, target, headers = self._parse_headers(raw_headers[:-4])
            length = min(int(headers.get("content-length", "0") or 0), MAX_BODY_BYTES + 1)
            if length > MAX_BODY_BYTES:
                await self._respond(writer, 413, b"body too large")
                return
            body = await asyncio.wait_for(reader.readexactly(length), timeout=15) if length else b""
            await self._route(writer, method, target, headers, body)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError):
            await self._respond(writer, 400, b"bad request")
        except Exception as exc:
            log.exception("[web] request failed: %s", exc)
            await self._respond(writer, 500, b"internal server error")
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def _route(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        target: str,
        headers: dict[str, str],
        body: bytes,
    ) -> None:
        parsed = urlsplit(target)
        path = unquote(parsed.path or "/")
        ip = self.auth.client_ip(
            self._peer_ip(writer),
            headers.get("x-real-ip", ""),
            headers.get("x-forwarded-for", ""),
        )
        token = cookie_value(headers.get("cookie"))
        authenticated = self.auth.validate(ip, token)

        if path == "/health":
            await self._json(writer, 200, {"ok": True})
            return
        if path == "/device-auth/status":
            status = self.auth.public_status(ip, authenticated=authenticated)
            await self._json(writer, 200, status)
            return
        if path == "/device-auth/login" and method == "POST":
            try:
                if "application/json" in headers.get("content-type", ""):
                    code = str(json.loads(body.decode("utf-8")).get("code", ""))
                else:
                    code = (parse_qs(body.decode("utf-8")).get("code") or [""])[0]
            except (ValueError, UnicodeDecodeError, AttributeError):
                code = ""
            ok, raw_token, status = self.auth.login(ip, code)
            extra = {}
            if ok and raw_token:
                extra["Set-Cookie"] = (
                    f"{SESSION_COOKIE}={raw_token}; Path=/; Max-Age={self.auth.session_seconds}; "
                    "HttpOnly; SameSite=Strict"
                )
            await self._json(writer, 200 if ok else (403 if status.get("blocked") else 401), status, extra)
            return
        if path == "/device-auth/logout" and method == "POST":
            self.auth.logout(token)
            await self._json(writer, 200, {"ok": True}, {
                "Set-Cookie": f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
            })
            return

        if not authenticated:
            if path in ("/", "/index.html"):
                await self._respond(writer, 200, _login_page(self.auth.public_status(ip)), "text/html; charset=utf-8")
            else:
                await self._respond(writer, 401, b"device login required")
            return

        if path.startswith("/api/"):
            result = await self.bridge._route_http_api(method, target, body, ip)
            if len(result) == 3:
                status, content_type, payload = result
            else:
                status, text = result
                content_type, payload = "text/plain; charset=utf-8", text.encode("utf-8")
            await self._respond(writer, int(status), payload, content_type)
            return

        if path in ("/", "/index.html"):
            index = (self.web_root / "index.html").read_text(encoding="utf-8")
            ws_url = self.public_ws_url or self._ws_url(headers.get("host", ""))
            runtime = "<script>window.__AGENT_WITH_U_WS_URL__=" + json.dumps(ws_url) + ";</script>"
            index = index.replace("</head>", runtime + "</head>", 1)
            await self._respond(writer, 200, index.encode("utf-8"), "text/html; charset=utf-8")
            return

        relative = path.lstrip("/")
        candidate = (self.web_root / relative).resolve()
        if self.web_root not in candidate.parents or not candidate.is_file():
            await self._respond(writer, 404, b"not found")
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        await self._respond(writer, 200, candidate.read_bytes(), content_type, {
            "Cache-Control": "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache",
        })

    def _ws_url(self, host_header: str) -> str:
        try:
            hostname = urlsplit("//" + host_header).hostname or "127.0.0.1"
        except ValueError:
            hostname = "127.0.0.1"
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        return f"ws://{hostname}:{self.ws_port}"

    @staticmethod
    async def _json(writer, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
        await PortableWebServer._respond(
            writer, status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8", headers,
        )

    @staticmethod
    async def _respond(
        writer: asyncio.StreamWriter,
        status: int,
        body: bytes,
        content_type: str = "text/plain; charset=utf-8",
        headers: dict[str, str] | None = None,
    ) -> None:
        reasons = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                   404: "Not Found", 413: "Payload Too Large", 431: "Request Header Fields Too Large",
                   500: "Internal Server Error"}
        lines = [
            f"HTTP/1.1 {status} {reasons.get(status, 'OK')}",
            f"Content-Type: {content_type}",
            f"Content-Length: {len(body)}",
            "X-Content-Type-Options: nosniff",
            "X-Frame-Options: DENY",
            "Referrer-Policy: no-referrer",
            "Cache-Control: no-store",
            "Connection: close",
        ]
        for key, value in (headers or {}).items():
            lines.append(f"{key}: {value}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1") + body)
        await writer.drain()

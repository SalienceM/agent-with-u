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
from .backends import create_backend, ModelBackend, StreamDelta, PermissionRequest
from .instance_manager import InstanceManager
from .backend_store import BackendStore
from .app_config_store import AppConfigStore
from .skill_store import SkillStore
from .prompt_store import PromptStore

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
        self._skill_store = SkillStore()
        self._prompt_store = PromptStore()
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
        # ★ Skip rest flags: session_id → True if user selected "skip rest"
        self._skip_rest_sessions: set[str] = set()

    # ── Python-Script Skill 执行器 ────────────────────────────────────

    async def _execute_python_script_skill(
        self, skill_name: str, payload: dict
    ) -> tuple[int, str]:
        """
        执行孵化库中 call.py 类型的 Skill。

        安全设计：
          - 凭据从本地存储读取，通过 SKILL_SECRETS 环境变量注入进程
          - 凭据不经过 LLM，不写入日志
          - 调用参数（args/prompt）通过 stdin 以 JSON 传入
          - 执行结果从 stdout 读取（纯文本或 JSON）

        call.py 协议：
          stdin:  JSON 行 {"skill": "...", "args": "...", ...}
          stdout: 结果文本（返回给 LLM）
          env:    SKILL_SECRETS={"USERNAME":"...","PASSWORD":"..."}
        """
        from pathlib import Path as _Path
        import asyncio as _asyncio

        skill_dir = _Path.home() / ".agent-with-u" / "skill-library" / skill_name
        call_py = skill_dir / "call.py"
        if not call_py.exists():
            return 404, f"Skill '{skill_name}' 缺少 call.py"

        # 从本地安全存储获取凭据（不传给 LLM）
        secrets = self._skill_store.get_secrets(skill_name)
        env = {
            **__import__("os").environ,
            "SKILL_SECRETS": json.dumps(secrets, ensure_ascii=False),
            "SKILL_NAME": skill_name,
            "SKILL_DIR": str(skill_dir),
        }

        stdin_data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        try:
            proc = await _asyncio.create_subprocess_exec(
                __import__("sys").executable, str(call_py),
                stdin=_asyncio.subprocess.PIPE,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.PIPE,
                env=env,
                cwd=str(skill_dir),
            )
            stdout, stderr = await _asyncio.wait_for(
                proc.communicate(stdin_data), timeout=60
            )
            if stderr:
                print(f"[bridge_ws] python-script skill '{skill_name}' stderr: "
                      f"{stderr.decode('utf-8', errors='replace')[:500]}",
                      file=sys.stderr, flush=True)
            if proc.returncode != 0:
                err = stderr.decode("utf-8", errors="replace")[:300]
                return 500, f"Skill '{skill_name}' 执行失败（exit {proc.returncode}）: {err}"
            return 200, stdout.decode("utf-8", errors="replace")
        except _asyncio.TimeoutError:
            return 504, f"Skill '{skill_name}' 执行超时（60s）"
        except Exception as e:
            return 500, f"Skill '{skill_name}' 执行异常: {e}"

    # ── 内置 Skill 处理器 ─────────────────────────────────────────

    async def _builtin_web_search(self, query: str) -> tuple[int, str]:
        """内置网页搜索（DuckDuckGo HTML 版，纯服务端渲染，无 JS 依赖）。"""
        import re as _re
        if not query:
            return 400, "搜索关键词为空"
        print(f"[bridge_ws] builtin web-search: q={query!r}", file=sys.stderr, flush=True)
        try:
            import httpx as _httpx
            import urllib.request as _ur
            proxy_url = None
            try:
                sys_proxies = _ur.getproxies()
                proxy_url = sys_proxies.get("https") or sys_proxies.get("http")
            except Exception:
                pass
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            }
            client_kwargs: dict = {"timeout": 30.0, "follow_redirects": True}
            if proxy_url:
                client_kwargs["proxy"] = proxy_url
            async with _httpx.AsyncClient(**client_kwargs) as client:
                resp = await client.post(
                    "https://html.duckduckgo.com/html/",
                    data={"q": query},
                    headers=headers,
                )
                if resp.status_code != 200:
                    return 500, f"搜索失败: HTTP {resp.status_code}"
                html = resp.text
            print(f"[bridge_ws] DuckDuckGo response: {len(html)} chars",
                  file=sys.stderr, flush=True)
            # DuckDuckGo HTML 结构：<div class="result ..."> 内含 <a class="result__a" href="...">标题</a> + <a class="result__snippet">摘要</a>
            results: list[str] = []
            blocks = _re.findall(r'<div[^>]*class="[^"]*result [^"]*"[^>]*>(.*?)</div>\s*</div>', html, _re.DOTALL)
            if not blocks:
                blocks = _re.findall(r'class="result__body">(.*?)</div>', html, _re.DOTALL)
            for block in blocks[:8]:
                # 标题 + URL
                title_m = _re.search(r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', block, _re.DOTALL)
                if not title_m:
                    title_m = _re.search(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', block, _re.DOTALL)
                if not title_m:
                    continue
                url = title_m.group(1)
                title = _re.sub(r'<[^>]+>', '', title_m.group(2)).strip()
                # 摘要
                snippet = ""
                snippet_m = _re.search(r'class="result__snippet[^"]*"[^>]*>(.*?)</[as]>', block, _re.DOTALL)
                if snippet_m:
                    snippet = _re.sub(r'<[^>]+>', '', snippet_m.group(1)).strip()[:200]
                if title and url and not url.startswith('javascript'):
                    # DuckDuckGo URL 可能是重定向格式
                    if '//duckduckgo.com/l/?' in url:
                        import urllib.parse as _up
                        parsed = _up.parse_qs(_up.urlparse(url).query)
                        url = parsed.get('uddg', [url])[0]
                    results.append(f"**{title}**\n{snippet}\n🔗 {url}")
            if not results:
                print(f"[bridge_ws] No results found. HTML sample: {html[:1500]}",
                      file=sys.stderr, flush=True)
                return 200, "未找到相关搜索结果。"
            return 200, "\n\n".join(f"{i}. {r}" for i, r in enumerate(results, 1))
        except Exception as e:
            return 500, f"搜索失败: {e}"

    async def _builtin_web_fetch(self, url: str) -> tuple[int, str]:
        """内置 URL 内容抓取，替代 Claude 的 WebFetch（第三方模型不兼容）。"""
        import re as _re
        if not url or not url.startswith("http"):
            return 400, "请提供有效的 URL"
        print(f"[bridge_ws] builtin web-fetch: url={url[:100]}", file=sys.stderr, flush=True)
        try:
            import httpx as _httpx
            import urllib.request as _ur
            proxy_url = None
            try:
                proxy_url = _ur.getproxies().get("https") or _ur.getproxies().get("http")
            except Exception:
                pass
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            }
            client_kwargs: dict = {"timeout": 30.0, "follow_redirects": True}
            if proxy_url:
                client_kwargs["proxy"] = proxy_url
            async with _httpx.AsyncClient(**client_kwargs) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    return 500, f"抓取失败: HTTP {resp.status_code}"
                html = resp.text
            # 提取正文文本：去掉 script/style/nav/header/footer，保留 body 文本
            # 去除 script 和 style 块
            text = _re.sub(r'<script[^>]*>.*?</script>', '', html, flags=_re.DOTALL | _re.IGNORECASE)
            text = _re.sub(r'<style[^>]*>.*?</style>', '', text, flags=_re.DOTALL | _re.IGNORECASE)
            text = _re.sub(r'<nav[^>]*>.*?</nav>', '', text, flags=_re.DOTALL | _re.IGNORECASE)
            text = _re.sub(r'<header[^>]*>.*?</header>', '', text, flags=_re.DOTALL | _re.IGNORECASE)
            text = _re.sub(r'<footer[^>]*>.*?</footer>', '', text, flags=_re.DOTALL | _re.IGNORECASE)
            # 去除所有 HTML 标签
            text = _re.sub(r'<[^>]+>', ' ', text)
            # 清理空白
            text = _re.sub(r'\s+', ' ', text).strip()
            # 截断避免过长
            if len(text) > 8000:
                text = text[:8000] + "\n\n...(内容已截断)"
            if not text:
                return 200, "页面内容为空或无法解析。"
            print(f"[bridge_ws] web-fetch result: {len(text)} chars", file=sys.stderr, flush=True)
            return 200, text
        except Exception as e:
            return 500, f"抓取失败: {e}"

    # ── HTTP API（供 Backend Skill 的 SKILL.md 通过 curl 回调）─────

    _HTTP_API_PORT = 44322  # Backend Skill HTTP 回调端口（WebSocket 端口 + 1）

    async def start_http_api(self):
        """启动轻量 HTTP server，供 Backend Skill 的 curl 回调。"""
        server = await asyncio.start_server(
            self._handle_http_connection, "127.0.0.1", self._HTTP_API_PORT,
        )
        print(f"[bridge_ws] HTTP API server started on http://127.0.0.1:{self._HTTP_API_PORT}",
              file=sys.stderr, flush=True)
        return server

    async def _handle_http_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """处理单个 HTTP 连接（极简 HTTP/1.1 解析）。"""
        try:
            # 读取请求行
            request_line = await asyncio.wait_for(reader.readline(), timeout=30)
            if not request_line:
                writer.close()
                return
            request_str = request_line.decode("utf-8", errors="replace").strip()
            parts = request_str.split(" ", 2)
            if len(parts) < 2:
                writer.close()
                return
            method, path = parts[0], parts[1]

            # 读取 headers
            content_length = 0
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=10)
                if not line or line == b"\r\n" or line == b"\n":
                    break
                header = line.decode("utf-8", errors="replace").strip().lower()
                if header.startswith("content-length:"):
                    content_length = int(header.split(":", 1)[1].strip())

            # 读取 body
            body = b""
            if content_length > 0:
                body = await asyncio.wait_for(reader.readexactly(content_length), timeout=120)

            # 路由 — 返回 (status, content_type, body_bytes)
            result = await self._route_http_api(method, path, body)
            if len(result) == 3:
                status, content_type, resp_bytes = result
            else:
                status, resp_text = result
                content_type = "text/plain; charset=utf-8"
                resp_bytes = resp_text.encode("utf-8")

            # 发送响应
            response = (
                f"HTTP/1.1 {status} OK\r\n"
                f"Content-Type: {content_type}\r\n"
                f"Content-Length: {len(resp_bytes)}\r\n"
                f"Access-Control-Allow-Origin: *\r\n"
                f"Connection: close\r\n"
                f"\r\n"
            ).encode("utf-8") + resp_bytes
            writer.write(response)
            await writer.drain()
        except Exception as e:
            print(f"[bridge_ws] HTTP API error: {e}", file=sys.stderr, flush=True)
        finally:
            writer.close()

    async def _route_http_api(self, method: str, path: str, body: bytes) -> tuple[int, str]:
        """路由 HTTP 请求到对应处理函数。"""
        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(path)

        if parsed.path == "/api/skill-call" and method == "POST":
            try:
                payload = json.loads(body.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return 400, "Invalid JSON body"
            return await self._handle_skill_call(payload)

        if parsed.path == "/api/skill-call" and method == "GET":
            params = parse_qs(parsed.query)
            payload = {
                "skill": (params.get("skill") or [""])[0],
                "prompt": (params.get("prompt") or [""])[0],
            }
            return await self._handle_skill_call(payload)

        # ★ 图片文件 HTTP 服务：/api/skill-images/<filename>
        if parsed.path.startswith("/api/skill-images/"):
            return self._serve_skill_image(parsed.path)

        return 404, "Not found"

    def _serve_skill_image(self, path: str) -> tuple[int, str, bytes]:
        """提供图片文件的二进制内容（浏览器 img 标签可直接加载）。"""
        from pathlib import Path as _Path

        filename = path.split("/api/skill-images/")[-1]
        if not filename or ".." in filename:
            return 400, "text/plain", b"Invalid filename"
        img_path = _Path.home() / ".agent-with-u" / "skill-images" / filename
        if not img_path.exists():
            return 404, "text/plain", f"Image not found: {filename}".encode()
        img_bytes = img_path.read_bytes()
        ext = img_path.suffix.lstrip(".").lower()
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp"}.get(ext, "image/png")
        return 200, mime, img_bytes

    async def _handle_skill_call(self, payload: dict) -> tuple[int, str]:
        """执行 Backend Skill 调用。"""
        import base64 as _b64
        from pathlib import Path as _Path

        skill_name = payload.get("skill", "")
        prompt = payload.get("prompt", "")
        ref_image = payload.get("ref_image", "")  # 可选：参考图 URL
        size = payload.get("size", "")  # 可选：尺寸（比例如 "16:9" 或具体如 "1280*720"）

        _ref_preview = repr(ref_image[:80]) if ref_image else "None"
        print(f"[bridge_ws] skill-call: skill={skill_name!r}, prompt={prompt!r}, "
              f"ref_image={_ref_preview}",
              file=sys.stderr, flush=True)

        if not skill_name:
            return 400, "Missing 'skill' parameter"

        skill_info = self._skill_store.get_skill(skill_name)
        if not skill_info:
            return 404, f"Skill '{skill_name}' not found"

        # ★ 内置类型：直接处理，不走 backend 路由
        skill_type = skill_info.get("type", "")
        if skill_type == "web-search":
            return await self._builtin_web_search(prompt)
        if skill_type == "web-fetch":
            url = payload.get("url", "") or prompt
            return await self._builtin_web_fetch(url)

        # ★ python-script 类型：执行孵化库中的 call.py，凭据通过环境变量传入
        if skill_type == "python-script" or skill_info.get("hasCallPy"):
            return await self._execute_python_script_skill(skill_name, payload)

        # Backend Skill：路由到目标 backend
        if not skill_info.get("backend"):
            return 404, f"Skill '{skill_name}' has no backend or type"

        target_backend_id = skill_info["backend"]
        try:
            target_backend = self._get_backend(target_backend_id)
        except Exception as e:
            return 500, f"Cannot create backend '{target_backend_id}': {e}"

        # ★ 处理参考图：从 HTTP URL 或本地 skill-images 加载
        ref_images: Optional[list[ImageAttachment]] = None
        if ref_image:
            try:
                img_b64 = ""
                mime = "image/png"
                if ref_image.startswith("http://127.0.0.1"):
                    # 本地 skill-images URL — 直接读文件
                    filename = ref_image.split("/api/skill-images/")[-1] if "/api/skill-images/" in ref_image else ""
                    if filename:
                        img_path = _Path.home() / ".agent-with-u" / "skill-images" / filename
                        if img_path.exists():
                            img_b64 = _b64.b64encode(img_path.read_bytes()).decode("ascii")
                            ext = img_path.suffix.lstrip(".").lower()
                            mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                if not img_b64 and ref_image.startswith("http"):
                    # 远程 URL — 下载
                    import httpx as _httpx
                    async with _httpx.AsyncClient(timeout=60) as hc:
                        resp = await hc.get(ref_image)
                        if resp.status_code == 200:
                            img_b64 = _b64.b64encode(resp.content).decode("ascii")
                            mime = resp.headers.get("content-type", "image/png").split(";")[0]
                if img_b64:
                    ref_images = [ImageAttachment(
                        id=new_id(), base64=img_b64, mime_type=mime,
                    )]
                    print(f"[bridge_ws] skill-call: loaded ref_image ({len(img_b64)} chars b64)",
                          file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[bridge_ws] skill-call: failed to load ref_image: {e}",
                      file=sys.stderr, flush=True)

        # ★ 动态尺寸：通过 --size 指令注入到 content 中
        # DashScope backend 会自动解析 --size 并从 prompt 中剥离
        send_content = prompt or "(empty)"
        if size:
            send_content = f"{send_content} --size {size}"

        result_parts: list[str] = []

        def on_delta(delta: StreamDelta):
            if delta.type == "text_delta" and delta.text:
                result_parts.append(delta.text)

        try:
            await target_backend.send_message(
                messages=[],
                content=send_content,
                images=ref_images,
                session_id=f"skill-call-{skill_name}",
                message_id=new_id(),
                on_delta=on_delta,
            )
        except Exception as e:
            return 500, f"Skill execution error: {e}"

        result = "".join(result_parts) or ""
        print(f"[bridge_ws] skill-call raw result ({len(result)} chars): {result[:120]!r}",
              file=sys.stderr, flush=True)

        # ★ 拦截 base64 图片数据：保存到文件，只返回干净的 markdown 图片 URL
        import base64 as _b64
        from pathlib import Path as _Path

        _B64_MARKER = ";base64,"
        saved_urls: list[str] = []

        while _B64_MARKER in result:
            marker_pos = result.find(_B64_MARKER)
            img_start = result.rfind("![", 0, marker_pos)
            if img_start < 0:
                break
            paren_open = result.find("(data:", img_start)
            if paren_open < 0 or paren_open > marker_pos:
                break
            mime_start = paren_open + len("(data:")
            mime = result[mime_start:marker_pos]
            b64_start = marker_pos + len(_B64_MARKER)
            b64_end = result.find(")", b64_start)
            if b64_end < 0:
                b64_end = len(result)
            b64_data = result[b64_start:b64_end]
            end_pos = min(b64_end + 1, len(result))

            ext = mime.split("/")[-1].replace("jpeg", "jpg") if "/" in mime else "png"
            try:
                img_bytes = _b64.b64decode(b64_data)
                tmp_dir = _Path.home() / ".agent-with-u" / "skill-images"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                img_path = tmp_dir / f"{new_id()}.{ext}"
                img_path.write_bytes(img_bytes)
                img_url = f"http://127.0.0.1:{self._HTTP_API_PORT}/api/skill-images/{img_path.name}"
                saved_urls.append(img_url)
                print(f"[bridge_ws] Saved skill image: {img_path} ({len(img_bytes)} bytes)",
                      file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[bridge_ws] Failed to save skill image: {e}",
                      file=sys.stderr, flush=True)

            result = result[:img_start] + result[end_pos:]

        # ★ 清洗返回结果：去掉 DashScope 状态文本，只返回最精简的结果
        # 避免模型从状态信息中推断文件路径或做多余操作
        if saved_urls:
            # 有图片生成时，只返回图片 markdown，不返回任何其他信息
            img_tags = "\n".join(f"![生成图像]({url})" for url in saved_urls)
            result = img_tags
        else:
            # 无图片时，去掉进度条/状态类文本
            for noise in ["🎨 正在提交图像生成任务…", "✅ 生成完成，正在下载图片…",
                          "⏳ 任务已提交，等待生成…"]:
                result = result.replace(noise, "")
            result = result.strip()

            # ★ 如果结果中有远程图片 URL（非 base64），尝试用 bridge 自身下载并缓存到本地
            # 这样即使用户浏览器无法直接访问 DashScope CDN，bridge 也可以代理
            if result and "![" in result and "http" in result:
                import re as _re
                import httpx as _httpx
                _img_match = _re.search(r'!\[[^\]]*\]\((https?://[^)]+)\)', result)
                if _img_match:
                    _remote_url = _img_match.group(1)
                    print(f"[bridge_ws] Trying to cache remote image: {_remote_url[:80]}",
                          file=sys.stderr, flush=True)
                    try:
                        async with _httpx.AsyncClient(timeout=60) as _hc:
                            _r = await _hc.get(_remote_url)
                            if _r.status_code == 200:
                                _ext = _r.headers.get("content-type", "image/png").split("/")[-1].split(";")[0]
                                _ext = _ext.replace("jpeg", "jpg")
                                tmp_dir = _Path.home() / ".agent-with-u" / "skill-images"
                                tmp_dir.mkdir(parents=True, exist_ok=True)
                                _img_path = tmp_dir / f"{new_id()}.{_ext or 'png'}"
                                _img_path.write_bytes(_r.content)
                                _local_url = f"http://127.0.0.1:{self._HTTP_API_PORT}/api/skill-images/{_img_path.name}"
                                result = f"![生成图像]({_local_url})"
                                print(f"[bridge_ws] Cached remote image → {_img_path}",
                                      file=sys.stderr, flush=True)
                    except Exception as _cache_err:
                        print(f"[bridge_ws] Failed to cache remote image: {_cache_err}",
                              file=sys.stderr, flush=True)
                        # 保留原始远程 URL

        if not result:
            result = "(no output)"
        print(f"[bridge_ws] skill-call final result: {result[:120]!r}",
              file=sys.stderr, flush=True)
        return 200, result

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
        if img is None:
            return "null"
        # 返回与 ImageAttachment dataclass 字段一致的结构，方便后端直接 ImageAttachment(**img)
        attachment = {
            "id": new_id(),
            "base64": img["data"],
            "mime_type": img["mimeType"],
            "size": 0,
            "width": img.get("width"),
            "height": img.get("height"),
        }
        return json.dumps(attachment, ensure_ascii=False)

    # ── RPC: 聊天 ────────────────────────────────────────────────

    def _rpc_sendMessage(self, payload_json: str) -> None:
        """Fire-and-forget：立即返回 null，后台异步推送 streamDelta。"""
        asyncio.ensure_future(self._handle_send_message(payload_json))
        return None

    def _rpc_abortMessage(self, session_id: str) -> None:
        """按 sessionId 取消流式输出，精确到单个 session，不影响同 backend 的其他 session。"""
        session = self._active_sessions.get(session_id)
        if session:
            backend = self._backends.get(session.backend_id)
            if backend:
                backend.abort(session_id)
        return None

    def _rpc_clearSessionContext(self, session_id: str) -> str:
        """清空 session 的消息历史和下游 agent session ID，保留 session 本身。
        用于 /new 命令：用户无感，对话窗口清空，后续对话从零开始。
        """
        session = self._active_sessions.get(session_id)
        if not session:
            session = self._session_store.load(session_id)
        if not session:
            return json.dumps({"success": False, "error": "会话未找到"}, ensure_ascii=False)
        session.messages = []
        session.agent_session_id = None
        session.updated_at = time.time()
        self._active_sessions[session_id] = session
        self._session_store.save(session, async_=True)
        self._emit_session_updated({"type": "context_cleared", "sessionId": session_id})
        print(f"[bridge_ws] clearSessionContext: {session_id}", file=sys.stderr, flush=True)
        return json.dumps({"success": True}, ensure_ascii=False)

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
                # ★ 同步保存，避免竞态条件
                self._session_store.save(session, async_=False)
            return json.dumps({"status": "ok", "autoContinue": session.auto_continue if session else True})

        elif command == "set_skip_permissions":
            session = self._active_sessions.get(session_id)
            if session:
                session.skip_permissions = payload.get("args", {}).get("enabled", True)
                # ★ 同步保存，避免竞态条件
                self._session_store.save(session, async_=False)
            return json.dumps({"status": "ok", "skipPermissions": session.skip_permissions if session else True})

        return json.dumps({"status": "error", "message": f"未知命令: {command}"})

    # ── RPC: 会话管理 ────────────────────────────────────────────

    @staticmethod
    def _default_workspace_root() -> "Path":  # type: ignore[name-defined]
        """Return the base dir that mirrors the log location (platform-aware)."""
        import os as _os
        from pathlib import Path as _Path
        if sys.platform == "win32":
            base = _Path(_os.environ.get("APPDATA", _Path.home())) / "AgentWithU"
        else:
            base = _Path.home() / ".agent-with-u"
        return base / "workspaces"

    def _resolve_working_dir(self, working_dir: str) -> str:
        """
        未显式指定目录时（空串 / '.' / './'）按时间生成一个工作目录，
        位置与日志目录同级（~/.agent-with-u/workspaces/session-YYYY-MM-DD_HH-MM-SS）。
        显式指定的路径原样返回。
        """
        from datetime import datetime
        from pathlib import Path as _Path

        raw = (working_dir or "").strip()
        if raw and raw not in (".", "./", ".\\"):
            return raw

        ts = datetime.now().strftime("session-%Y-%m-%d_%H-%M-%S")
        workspace_root = self._default_workspace_root()
        target = workspace_root / ts

        # 同一秒内重复创建时补上短后缀，避免冲突
        if target.exists():
            suffix = 1
            while True:
                candidate = workspace_root / f"{ts}-{suffix}"
                if not candidate.exists():
                    target = candidate
                    break
                suffix += 1

        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"[BridgeWS] Failed to create default workspace {target}: {e}",
                  file=sys.stderr, flush=True)
            # 兜底：返回原始值，让下游自己处理
            return raw or "."

        print(f"[BridgeWS] Auto-created default workspace: {target}",
              file=sys.stderr, flush=True)
        return str(target)

    def _rpc_createSession(self, working_dir: str, backend_id: str) -> str:
        resolved_dir = self._resolve_working_dir(working_dir)
        session = Session(
            id=new_id(), title="新会话",
            created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=resolved_dir, backend_id=backend_id,
        )
        # ★ 默认档自动绑定：新建 session 时把被标记为 isDefault 的 Prompt/Skill 全部挂上去
        try:
            defaults = self._default_abilities()
            if defaults.get("skills") or defaults.get("prompts"):
                self._apply_session_abilities(session, defaults)
                print(f"[BridgeWS] Auto-bound defaults to new session {session.id}: "
                      f"skills={defaults.get('skills')} prompts={defaults.get('prompts')}",
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[BridgeWS] Failed to auto-bind defaults: {e}", file=sys.stderr)
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

    def _rpc_updateSessionConstraints(self, session_id: str, constraints_json: str) -> str:
        try:
            constraints = json.loads(constraints_json)
            if isinstance(constraints, str):
                constraints_text = constraints
            elif isinstance(constraints, dict):
                constraints_text = constraints.get("constraints", "")
            else:
                constraints_text = ""
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            if not session:
                return json.dumps({"status": "error", "message": "Session not found"})
            session.constraints = constraints_text
            self._active_sessions[session_id] = session
            self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_renameSession(self, session_id: str, new_title: str) -> str:
        try:
            if not new_title.strip():
                return json.dumps({"status": "error", "message": "Title cannot be empty"}, ensure_ascii=False)
            ok = self._session_store.rename(session_id, new_title)
            if ok:
                session = self._active_sessions.get(session_id)
                if session:
                    session.title = new_title.strip()
                return json.dumps({"status": "ok"}, ensure_ascii=False)
            return json.dumps({"status": "error", "message": "Session not found"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

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
                allowed_tools=data.get("allowedTools"),
                mcp_servers=data.get("mcpServers") or None,
            )
        else:
            config = ModelBackendConfig(
                id=data["id"], type=BackendType(data["type"]), label=data["label"],
                base_url=data.get("baseUrl"), model=data.get("model"), api_key=data.get("apiKey"),
                working_dir=data.get("workingDir"), allowed_tools=data.get("allowedTools"),
                skip_permissions=data.get("skipPermissions", True), env=data.get("env"),
                mcp_servers=data.get("mcpServers") or None,
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

    def _rpc_getMcpServers(self) -> str:
        """读取 ~/.claude/settings.json 中的 mcpServers 配置。"""
        from pathlib import Path as _Path
        settings_path = _Path.home() / ".claude" / "settings.json"
        try:
            if settings_path.exists():
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                return json.dumps(data.get("mcpServers") or {}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] getMcpServers error: {e}", file=sys.stderr)
        return json.dumps({})

    def _rpc_saveMcpServers(self, servers_json: str) -> str:
        """将 mcpServers 写回 ~/.claude/settings.json（合并，不覆盖其他字段）。"""
        from pathlib import Path as _Path
        settings_path = _Path.home() / ".claude" / "settings.json"
        try:
            servers = json.loads(servers_json)
            if settings_path.exists():
                data = json.loads(settings_path.read_text(encoding="utf-8"))
            else:
                data = {}
                settings_path.parent.mkdir(parents=True, exist_ok=True)
            data["mcpServers"] = servers
            settings_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] saveMcpServers error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ══════════════════════════════════════════════════════════════════
    #  Skill 孵化库 RPC
    # ══════════════════════════════════════════════════════════════════

    def _rpc_listSkills(self, working_dir: str = "") -> str:
        """返回孵化库中所有 skill，附带当前工作目录的激活状态。"""
        try:
            skills = self._skill_store.list_skills(working_dir)
            return json.dumps(skills, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] listSkills error: {e}", file=sys.stderr)
            return json.dumps([])

    def _rpc_saveSkill(self, name: str, content: str) -> str:
        """保存或更新孵化库中的 skill（同步到已激活位置）。"""
        try:
            self._skill_store.save_skill(name.strip(), content)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] saveSkill error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_deleteSkill(self, name: str) -> str:
        """从孵化库删除 skill，撤销所有激活位置。"""
        try:
            self._skill_store.delete_skill(name.strip())
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] deleteSkill error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_activateSkill(self, name: str, scope: str, working_dir: str = "") -> str:
        """
        激活 skill。
          scope: "global"  → ~/.claude/skills/<name>/
          scope: "project" → <working_dir>/.claude/skills/<name>/
        """
        try:
            self._skill_store.activate(name.strip(), scope, working_dir)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] activateSkill error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_deactivateSkill(self, name: str, scope: str, working_dir: str = "") -> str:
        """停用 skill，删除目标位置的 SKILL.md。"""
        try:
            self._skill_store.deactivate(name.strip(), scope, working_dir)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] deactivateSkill error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_renameSkill(self, old_name: str, new_name: str, new_content: str) -> str:
        """重命名 skill（含内容更新，保留所有激活记录迁移到新名称）。"""
        try:
            self._skill_store.rename_skill(old_name.strip(), new_name.strip(), new_content)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] renameSkill error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ── 插件包安装 + Secrets 管理 RPC ────────────────────────────────────

    def _rpc_installSkillPackage(self, pkg_path: str, pkg_base64: str = "") -> str:
        """安装本地 .awu 插件包。
        支持两种方式：
        - pkg_path: 本地文件完整路径（Qt 原生环境）
        - pkg_base64: 文件内容的 base64 编码（浏览器环境，path 不可用时）
        """
        import tempfile, base64 as _b64
        tmp_path = None
        try:
            if pkg_base64:
                # 浏览器传来的 base64 内容，写到临时文件
                data = _b64.b64decode(pkg_base64)
                suffix = ".awu"
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
                    f.write(data)
                    tmp_path = f.name
                actual_path = tmp_path
            else:
                actual_path = pkg_path
            manifest = self._skill_store.install_package(actual_path)
            return json.dumps({"status": "ok", "manifest": manifest}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] installSkillPackage error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)
        finally:
            if tmp_path:
                import os as _os
                try: _os.unlink(tmp_path)
                except Exception: pass

    def _rpc_getSkillSecretsSchema(self, name: str) -> str:
        """获取 skill 的 secrets.schema.json（字段列表），前端据此渲染填写表单。"""
        try:
            schema = self._skill_store.get_secrets_schema(name)
            return json.dumps(schema, ensure_ascii=False)
        except Exception as e:
            return json.dumps(None)

    def _rpc_setSkillSecrets(self, name: str, secrets_json: str) -> str:
        """保存用户填写的 skill 凭据到本地安全存储（不进 LLM context）。"""
        try:
            secrets = json.loads(secrets_json)
            self._skill_store.set_secrets(name, secrets)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] setSkillSecrets error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_getSkillSecretsPresence(self, name: str) -> str:
        """返回已设置的 secrets 字段名列表（不返回值，仅供 UI 展示"已配置"状态）。"""
        try:
            secrets = self._skill_store.get_secrets(name)
            # 只返回已设置（非空）的 key 列表，不暴露值
            filled = [k for k, v in secrets.items() if v]
            return json.dumps(filled, ensure_ascii=False)
        except Exception as e:
            return json.dumps([])

    # ═══════════════════════════════════════
    #  Prompt 模板库 CRUD
    # ═══════════════════════════════════════
    def _rpc_listPrompts(self) -> str:
        try:
            return json.dumps(self._prompt_store.list_prompts(), ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] listPrompts error: {e}", file=sys.stderr)
            return json.dumps([])

    def _rpc_savePrompt(self, name: str, content: str, icon: str = "📝") -> str:
        try:
            self._prompt_store.save_prompt(name.strip(), content, icon)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_deletePrompt(self, name: str) -> str:
        try:
            self._prompt_store.delete_prompt(name.strip())
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_renamePrompt(self, old_name: str, new_name: str, content: str) -> str:
        try:
            self._prompt_store.rename_prompt(old_name.strip(), new_name.strip(), content)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_updatePromptIcon(self, name: str, icon: str) -> str:
        try:
            self._prompt_store.update_icon(name.strip(), icon)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ═══════════════════════════════════════
    #  Backend Skill 收集与执行
    # ═══════════════════════════════════════

    def _collect_backend_skills(self, session: Session) -> tuple[list[dict], Optional[dict]]:
        """
        从 session 绑定的 skills 中收集 Backend Skill（带 backend 字段的）。
        返回:
          - extra_tools: Anthropic tool definitions 列表
          - skill_map: {tool_name: {"backend_id": ..., "skill_name": ...}} 用于路由
        """
        abilities = session.abilities or {}
        skill_names = abilities.get("skills", [])
        if not skill_names:
            return [], None

        extra_tools: list[dict] = []
        skill_map: dict[str, dict] = {}

        BUILTIN_TYPES = {"web-search", "web-fetch", "python-script"}

        for sname in skill_names:
            info = self._skill_store.get_skill(sname)
            if not info:
                continue
            skill_type = info.get("type", "")
            has_backend = bool(info.get("backend"))
            is_builtin = skill_type in BUILTIN_TYPES or info.get("hasCallPy")

            # 传统指令型 Skill（无 backend、无内置类型）：跳过，走 CLI 原生发现
            if not has_backend and not is_builtin:
                continue

            description = info.get("description", f"Skill: {sname}")
            # 深拷贝 input_schema，避免后续 mutation 污染 skill_store 中的原对象
            raw_schema = info.get("inputSchema") or {"type": "object", "properties": {}}
            import copy as _copy
            input_schema = _copy.deepcopy(raw_schema)
            input_schema.setdefault("type", "object")
            input_schema.setdefault("properties", {})

            # ── 判断是否为图像生成 backend（需要注入 ref_image 支持） ──
            is_image_backend = False
            backend_id = info.get("backend", "")
            if backend_id:
                bc = next((c for c in self._backend_configs if c.id == backend_id), None)
                if bc and bc.type.value == "dashscope-image":
                    is_image_backend = True

            # ★ 图像生成 backend：强制在 tool schema 中注入 ref_image 字段，
            #   否则兼容 OpenAI function-calling 的模型（Qwen 系列）根本没有字段
            #   可以表达"传入参考图 URL"的意图。并在 description 中强化规则，
            #   让 Qwen 3.6+ 等对参数描述更严格的模型不会遗漏。
            if is_image_backend:
                props = input_schema["properties"]
                if "ref_image" not in props:
                    props["ref_image"] = {
                        "type": "string",
                        "description": (
                            "参考图片的 URL，用于图生图 / image-to-image 模式。"
                            "【强制规则】以下任一情况都必须把 URL 填入本字段，"
                            "不得留空、不得只在 prompt 里描述："
                            "(1) 本轮用户消息里含 `[用户上传图片 URL: http://127.0.0.1:...]` 标记；"
                            "(2) 用户提到『基于上图 / 在这张图上 / 改这张图 / "
                            "在上一张图基础上 / 以这张为参考 / 用这个图 / 引用上图』等；"
                            "(3) 对话历史（最近 assistant 输出）里出现过 "
                            "`http://127.0.0.1:` 开头的 `/api/skill-images/` 图片 URL。"
                            "查找顺序：先用本轮用户消息里最新的上传 URL，"
                            "找不到时回退到对话历史中最近一条 `http://127.0.0.1:` 图片 URL。"
                            "找到就原样传入本字段，不要改写、不要省略、不要截断。"
                        ),
                    }
                # 在工具描述前缀追加强制规则，OpenAI function-calling 下 description
                # 对 Qwen 的约束力比单独的参数 description 更强
                description = (
                    f"{description}\n\n"
                    "【图生图强制规则】调用本工具前必须检查是否需要携带参考图：\n"
                    "• 若本轮用户消息含 `[用户上传图片 URL: http://127.0.0.1:...]`，"
                    "必须把该 URL 作为 ref_image 参数传入。\n"
                    "• 若用户说『基于上图 / 在这张图上 / 改这张图 / 上一张基础上 / "
                    "以这张为参考』等，必须回查对话历史，取最近一条 "
                    "`http://127.0.0.1:` 开头的 `/api/skill-images/` 图片 URL 作为 ref_image。\n"
                    "• 只有用户明确表示『不参考任何图、重新画一张』时才可省略 ref_image。\n"
                    "• 严禁只把 URL 写进 prompt 文本里——必须通过 ref_image 结构化参数传入。"
                )

            tool_name = sname.replace("-", "_")  # Claude 不允许工具名含连字符
            extra_tools.append({
                "name": tool_name,
                "description": description,
                "input_schema": input_schema,
            })
            skill_map[tool_name] = {
                "backend_id": info.get("backend", ""),
                "skill_name": sname,
                "skill_type": skill_type,
                "is_image_backend": is_image_backend,
            }

        return extra_tools, skill_map if skill_map else None

    async def _execute_backend_skill(
        self, tool_name: str, tool_input: dict,
        skill_map: dict, session: Session, message_id: str,
    ) -> str:
        """
        执行一个 Backend Skill：将请求路由到目标 backend。
        返回结果文本。
        """
        mapping = skill_map.get(tool_name)
        if not mapping:
            raise ValueError(f"Unknown backend skill: {tool_name}")

        target_backend_id = mapping["backend_id"]
        target_backend = self._get_backend(target_backend_id)
        is_image_backend = mapping.get("is_image_backend", False)

        # 构建发给目标 backend 的消息内容
        prompt = tool_input.get("prompt", "")
        if not prompt:
            # 保底：如果模型没传 prompt，就把整个 tool_input（剥去 ref_image）塞进去
            _dump_input = {k: v for k, v in tool_input.items() if k != "ref_image"}
            prompt = json.dumps(_dump_input, ensure_ascii=False) if _dump_input else ""

        # ── 处理参考图参数（图生图） ──
        # OpenAI function-calling 的 Qwen 系模型会通过 ref_image 字段传入 URL。
        # 这里从 tool_input 取出，回退：prompt 里嵌入的 http://127.0.0.1:.../skill-images/ URL
        # 也会被识别为隐式参考图，避免模型不按约定填字段时完全丢失上下文。
        ref_images: Optional[list[ImageAttachment]] = None
        ref_image_url = (tool_input.get("ref_image") or "").strip()
        if is_image_backend and not ref_image_url and prompt:
            # fallback: 从 prompt 里扫描出本地图片 URL
            import re as _re
            m = _re.search(r'http://127\.0\.0\.1[^\s)\]\'"]*?/api/skill-images/[^\s)\]\'"]+', prompt)
            if m:
                ref_image_url = m.group(0)
                print(f"[bridge_ws] Backend Skill '{tool_name}': "
                      f"ref_image not in tool_input, recovered from prompt: {ref_image_url}",
                      file=sys.stderr, flush=True)

        if is_image_backend and ref_image_url:
            try:
                import base64 as _b64
                from pathlib import Path as _Path
                img_b64 = ""
                mime = "image/png"
                if ref_image_url.startswith("http://127.0.0.1") and "/api/skill-images/" in ref_image_url:
                    filename = ref_image_url.split("/api/skill-images/")[-1].split("?", 1)[0]
                    img_path = _Path.home() / ".agent-with-u" / "skill-images" / filename
                    if img_path.exists():
                        img_b64 = _b64.b64encode(img_path.read_bytes()).decode("ascii")
                        ext = img_path.suffix.lstrip(".").lower()
                        mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                if not img_b64 and ref_image_url.startswith("http"):
                    import httpx as _httpx
                    async with _httpx.AsyncClient(timeout=60) as hc:
                        resp = await hc.get(ref_image_url)
                        if resp.status_code == 200:
                            img_b64 = _b64.b64encode(resp.content).decode("ascii")
                            mime = resp.headers.get("content-type", "image/png").split(";")[0]
                if img_b64:
                    ref_images = [ImageAttachment(
                        id=new_id(), base64=img_b64, mime_type=mime,
                    )]
                    print(f"[bridge_ws] Backend Skill '{tool_name}': loaded ref_image "
                          f"({len(img_b64)} chars b64) from {ref_image_url[:80]}",
                          file=sys.stderr, flush=True)
                else:
                    print(f"[bridge_ws] Backend Skill '{tool_name}': ref_image URL given but "
                          f"failed to load: {ref_image_url[:120]}",
                          file=sys.stderr, flush=True)
            except Exception as _e:
                print(f"[bridge_ws] Backend Skill '{tool_name}': ref_image load error: {_e}",
                      file=sys.stderr, flush=True)

        # 把 ref_image URL 从 prompt 文本里剔除，避免 DashScope 把 URL 当成描述词
        if is_image_backend and prompt:
            import re as _re
            prompt = _re.sub(
                r'http://127\.0\.0\.1[^\s)\]\'"]*?/api/skill-images/[^\s)\]\'"]+',
                '',
                prompt,
            ).strip()
        if not prompt:
            prompt = "(empty)"

        result_parts: list[str] = []

        def on_delta(delta: StreamDelta):
            if delta.type == "text_delta" and delta.text:
                result_parts.append(delta.text)

        sub_message_id = new_id()
        try:
            await target_backend.send_message(
                messages=[],
                content=prompt,
                images=ref_images,
                session_id=f"{session.id}__skill_{tool_name}",
                message_id=sub_message_id,
                on_delta=on_delta,
                working_dir=session.working_dir,
            )
        except Exception as e:
            raise RuntimeError(f"Backend skill '{tool_name}' execution failed: {e}")

        result = "".join(result_parts)
        if not result:
            result = "(no output)"

        # ★ 与 _handle_skill_call 相同的图片处理管线：
        #   base64 inline 图片 → 保存到 skill-images/ → 返回本地 URL markdown
        import base64 as _b64
        from pathlib import Path as _Path

        _B64_MARKER = ";base64,"
        saved_urls: list[str] = []

        while _B64_MARKER in result:
            marker_pos = result.find(_B64_MARKER)
            img_start = result.rfind("![", 0, marker_pos)
            if img_start < 0:
                break
            paren_open = result.find("(data:", img_start)
            if paren_open < 0 or paren_open > marker_pos:
                break
            mime_start = paren_open + len("(data:")
            mime = result[mime_start:marker_pos]
            b64_start = marker_pos + len(_B64_MARKER)
            b64_end = result.find(")", b64_start)
            if b64_end < 0:
                b64_end = len(result)
            b64_data = result[b64_start:b64_end]
            end_pos = min(b64_end + 1, len(result))

            ext = mime.split("/")[-1].replace("jpeg", "jpg") if "/" in mime else "png"
            try:
                img_bytes = _b64.b64decode(b64_data)
                tmp_dir = _Path.home() / ".agent-with-u" / "skill-images"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                img_path = tmp_dir / f"{new_id()}.{ext}"
                img_path.write_bytes(img_bytes)
                img_url = f"http://127.0.0.1:{self._HTTP_API_PORT}/api/skill-images/{img_path.name}"
                saved_urls.append(img_url)
                print(f"[bridge_ws] Backend Skill saved image: {img_path} ({len(img_bytes)} bytes)",
                      file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[bridge_ws] Backend Skill failed to save image: {e}",
                      file=sys.stderr, flush=True)

            result = result[:img_start] + result[end_pos:]

        if saved_urls:
            result = "\n".join(f"![生成图像]({url})" for url in saved_urls)
        else:
            # 去掉 DashScope 进度状态文本
            for noise in ["🎨 正在提交图像生成任务…", "✅ 生成完成，正在下载图片…",
                          "⏳ 任务已提交，等待生成…"]:
                result = result.replace(noise, "")
            result = result.strip() or "(no output)"

        print(f"[bridge_ws] Backend Skill '{tool_name}' → '{target_backend_id}': {result[:200]}",
              file=sys.stderr, flush=True)
        return result

    # ═══════════════════════════════════════
    #  Session 能力绑定
    # ═══════════════════════════════════════
    # ── Backend Skill 部署内容生成 ──────────────────────────

    def _generate_backend_skill_md(self, skill_name: str, skill_info: dict, *, is_image_backend: bool = False) -> str:
        """
        根据孵化库中的 Backend Skill 声明，生成部署版 SKILL.md。
        根据 input_schema 动态生成参数说明，适配不同 skill 类型。
        """
        description = skill_info.get("description", f"Backend Skill: {skill_name}")
        input_schema = skill_info.get("inputSchema") or {}
        python = sys.executable.replace("\\", "/")
        call_script = f".claude/skills/{skill_name}/_call.py"

        # 从 input_schema 提取参数列表
        props = input_schema.get("properties", {})
        required_list = input_schema.get("required", [])
        required = set(required_list)
        primary_field = required_list[0] if required_list else (list(props.keys())[0] if props else "prompt")
        # 构建参数说明和命令示例
        args_doc: list[str] = []
        args_example: list[str] = [f'"<{primary_field.upper()}>"']
        for pname, pdef in props.items():
            if pname == primary_field:
                continue
            pdesc = pdef.get("description", pname)
            is_req = pname in required
            tag = "必填" if is_req else "可选"
            args_doc.append(f"- {pname}（{tag}）：{pdesc}")
            args_example.append(f'"<{pname.upper()}>"')

        # 图像生成 backend：注入 ref_image 参数说明
        if is_image_backend:
            args_doc.append("- ref_image（可选）：参考图片的 URL（如用户已上传图片，应传入图片地址，用于图生图）")
            args_example.append('"<REF_IMAGE_URL>"')

        # 基本命令
        basic_cmd = f'"{python}" {call_script} "<{primary_field.upper()}>"'
        # 完整命令（含可选参数）
        full_cmd = f'"{python}" {call_script} {" ".join(args_example)}'

        extra_params = ""
        if args_doc:
            extra_params = "\n可选参数（按顺序追加）：\n" + "\n".join(args_doc) + "\n"
            extra_params += f"\n完整示例：\n```bash\n{full_cmd}\n```\n"

        ref_image_hint = ""
        if is_image_backend:
            ref_image_hint = """
**⚠️ 图生图（强制规则）**：以下任何情况都必须将图片 URL 作为最后一个参数传入：
- 用户上传了图片（消息中含图片附件）
- 用户说到"基于上图"、"引用上图"、"参考这张图"、"在这张图上"、"修改这张图"
- 用户说到"基于上面的图"、"用这个图"、"以这张为参考"、"改改这个"、"在上一张图基础上"
- 对话历史中有之前生成的图片 URL（http://127.0.0.1:xxxxx/api/skill-images/... 格式）
- 任何暗示要在现有图片基础上操作的表达

**图片 URL 查找规则**：优先用用户刚上传的图片 URL；其次用对话中最近出现的 `http://127.0.0.1` 开头的图片地址。找到就传，不要忽略。
"""

        return f"""\
---
name: {skill_name}
description: {description}
---

## Instructions

**必须使用 Bash 工具执行下方命令。**

```bash
{basic_cmd}
```
{extra_params}{ref_image_hint}
**规则：只执行一次，将命令的完整输出原文粘贴到你的回复中——包括任何 `![alt](url)` 格式的图片 markdown，必须按原样包含，不得删改、不得替换为描述文字。禁止重试、禁止评价质量、禁止额外处理。**
"""

    def _generate_backend_skill_call_py(self, skill_name: str, skill_info: dict, *, is_image_backend: bool = False) -> str:
        """生成 _call.py 调用脚本，根据 input_schema 动态构建参数映射。"""
        port = self._HTTP_API_PORT
        input_schema = skill_info.get("inputSchema") or {}
        props = input_schema.get("properties", {})
        required = input_schema.get("required", [])
        # 第一个必填参数作为 argv[1]，其他依次 argv[2], argv[3]...
        primary_field = required[0] if required else (list(props.keys())[0] if props else "prompt")
        extra_params = [p for p in props if p != primary_field]

        extra_lines = ""
        for i, pname in enumerate(extra_params, 2):
            extra_lines += f'if len(sys.argv) > {i} and sys.argv[{i}]:\n    payload["{pname}"] = sys.argv[{i}]\n'

        # 图像生成 backend：ref_image 作为最后一个可选参数注入
        ref_image_line = ""
        if is_image_backend:
            ref_image_argc = len(extra_params) + 2  # argv[1]=prompt, argv[2..N]=extra_params, argv[N+1]=ref_image
            ref_image_line = f'if len(sys.argv) > {ref_image_argc} and sys.argv[{ref_image_argc}]:\n    payload["ref_image"] = sys.argv[{ref_image_argc}]\n'

        return f'''\
import sys, json, urllib.request, urllib.error
payload = {{"skill": "{skill_name}", "{primary_field}": sys.argv[1] if len(sys.argv) > 1 else ""}}
{extra_lines}{ref_image_line}data = json.dumps(payload).encode()
req = urllib.request.Request("http://127.0.0.1:{port}/api/skill-call", data, {{"Content-Type": "application/json"}})
try:
    result = urllib.request.urlopen(req, timeout=300).read()
    sys.stdout.buffer.write(result)
    sys.stdout.buffer.write(b"\\n")
    sys.stdout.buffer.flush()
except urllib.error.URLError as e:
    sys.stderr.write(f"[_call.py] HTTP error calling skill bridge: {{e}}\\n")
    sys.stderr.flush()
    sys.stdout.write(f"(skill bridge error: {{e}})\\n")
    sys.stdout.flush()
    sys.exit(1)
'''

    def _sync_backend_skills_to_directory(self, session: Session):
        """
        将 session 绑定的 Backend Skills 部署到 working_dir/.claude/skills/，
        同时清理不再绑定的 Backend Skill。
        """
        from pathlib import Path as _Path

        working_dir = session.working_dir
        if not working_dir or working_dir == ".":
            return

        skills_dir = _Path(working_dir) / ".claude" / "skills"
        abilities = session.abilities or {}
        bound_skills = set(abilities.get("skills", []))

        # 收集当前绑定中的系统增强型 Skills（有 backend 或 type 字段）
        deployed_backend_skills: set[str] = set()
        for sname in bound_skills:
            info = self._skill_store.get_skill(sname)
            if not info:
                continue
            if not info.get("backend") and not info.get("type"):
                continue  # 传统 Skill，由用户手动激活
            # 判断是否为图像生成类 backend（需要注入 ref_image 支持）
            is_image_backend = False
            backend_id = info.get("backend", "")
            if backend_id:
                bc = next((c for c in self._backend_configs if c.id == backend_id), None)
                if bc and bc.type.value == "dashscope-image":
                    is_image_backend = True
            # 系统增强型：部署 SKILL.md + _call.py
            target = skills_dir / sname
            target.mkdir(parents=True, exist_ok=True)
            (target / "SKILL.md").write_text(
                self._generate_backend_skill_md(sname, info, is_image_backend=is_image_backend), encoding="utf-8")
            (target / "_call.py").write_text(
                self._generate_backend_skill_call_py(sname, info, is_image_backend=is_image_backend), encoding="utf-8")
            deployed_backend_skills.add(sname)
            print(f"[bridge_ws] Deployed Backend Skill '{sname}' → {target}",
                  file=sys.stderr, flush=True)

        # 清理不再绑定的 Backend Skill（通过 _call.py 存在判断是否为系统部署的）
        if skills_dir.exists():
            for skill_dir in skills_dir.iterdir():
                if not skill_dir.is_dir():
                    continue
                if skill_dir.name in deployed_backend_skills:
                    continue
                if skill_dir.name in bound_skills:
                    continue
                call_py = skill_dir / "_call.py"
                if call_py.exists():
                    # 系统部署的 Backend Skill，解绑后清理
                    import shutil as _shutil
                    _shutil.rmtree(skill_dir, ignore_errors=True)
                    print(f"[bridge_ws] Cleaned up unbound Backend Skill '{skill_dir.name}'",
                          file=sys.stderr, flush=True)

    def _apply_session_abilities(self, session: Session, abilities: dict) -> None:
        """
        把 abilities 绑定到 session：
          - 更新 session.abilities
          - 从绑定的 prompts + backend skills 组装 session.constraints
          - 同步部署 backend skill 文件到 working_dir/.claude/skills/

        被 _rpc_updateSessionAbilities 和 _rpc_createSession（默认档自动绑定）共用。
        """
        session.abilities = abilities
        # 从绑定的 prompts 组装 constraints 文本
        prompt_names = abilities.get("prompts", [])
        parts = []
        for pname in prompt_names:
            p = self._prompt_store.get_prompt(pname)
            if p and p.get("content"):
                parts.append(p["content"])

        # ★ Backend Skills：注入 Bash 调用提示，兼容不支持原生 Skill 工具的模型（如 Qwen 系列）
        # 这样模型即使绕过 Skill 工具也能从 constraints 里知道怎么调用
        backend_skill_hints: list[str] = []
        has_image_backend_skill = False
        for sname in abilities.get("skills", []):
            info = self._skill_store.get_skill(sname)
            if not info:
                continue
            if not info.get("backend") and not info.get("type"):
                continue  # 传统指令型 Skill，无需注入
            desc = info.get("description", sname)
            python_exe = sys.executable.replace("\\", "/")
            call_script = f".claude/skills/{sname}/_call.py"
            input_schema = info.get("inputSchema") or {}
            required_list = (input_schema.get("required") or
                             list((input_schema.get("properties") or {}).keys()))
            primary_field = required_list[0] if required_list else "prompt"

            # 判断该 skill 是否绑定到图像生成 backend
            sk_backend_id = info.get("backend", "")
            sk_is_image = False
            if sk_backend_id:
                bc = next((c for c in self._backend_configs if c.id == sk_backend_id), None)
                if bc and bc.type.value == "dashscope-image":
                    sk_is_image = True
                    has_image_backend_skill = True

            hint = (
                f'- **{sname}**：{desc}\n'
                f'  → Bash: `"{python_exe}" {call_script} "<{primary_field.upper()}>"`'
            )
            if sk_is_image:
                hint += (
                    f'\n  → 图生图（参考图）Bash: '
                    f'`"{python_exe}" {call_script} "<{primary_field.upper()}>" "<REF_IMAGE_URL>"`'
                    f'\n  → 原生工具调用时必须把参考图 URL 填入 `ref_image` 参数'
                    f'（不要只写在 prompt 里）'
                )
            backend_skill_hints.append(hint)

        if backend_skill_hints:
            skill_block = (
                "## 已绑定 Backend Skills【强制规则】\n\n"
                "以下技能已就绪，**必须直接调用，禁止用 ls/find/cat 等方式自行探索或验证**：\n\n"
                + "\n".join(backend_skill_hints)
                + "\n\n**规则：用 Bash 执行上方命令一次，将输出原样返回给用户，不要重试，不要自行判断结果。**"
            )
            if has_image_backend_skill:
                skill_block += (
                    "\n\n### 图生图（image-to-image）强制约束\n\n"
                    "当图像生成类 Skill 被调用时，**必须**遵守以下规则，违反视为错误调用：\n\n"
                    "1. **触发条件**（任一满足即必须传参考图）：\n"
                    "   - 本轮用户消息里含 `[用户上传图片 URL: http://127.0.0.1:...]` 标记；\n"
                    "   - 用户表达：『基于上图 / 基于上一张 / 在这张图上 / 改这张图 / "
                    "改改这个 / 以这张为参考 / 引用上图 / 用这个图 / 上一张基础上 / "
                    "based on the previous image』等；\n"
                    "   - 对话历史中最近一条 assistant 消息里出现过 "
                    "`http://127.0.0.1:` 开头的 `/api/skill-images/xxx` 图片 URL。\n\n"
                    "2. **传参方式**（按调用路径二选一）：\n"
                    "   - **原生 Skill/Function-calling 路径**：必须把 URL 填入 `ref_image` "
                    "结构化参数。**禁止**只把 URL 混入 prompt 字符串里交差。\n"
                    "   - **Bash 调用路径**：作为第二个位置参数传入（见上方"
                    "『图生图 Bash』示例）。\n\n"
                    "3. **URL 选取规则**：\n"
                    "   - 优先用本轮用户消息里最新的上传 URL；\n"
                    "   - 找不到时回查对话历史，取最近一条 `http://127.0.0.1:` 开头的 "
                    "`/api/skill-images/xxx` URL；\n"
                    "   - 原样复制整段 URL，不要改写、不要省略协议、不要截断路径。\n\n"
                    "4. **唯一例外**：用户明确表示『不参考任何图 / 重新画一张 / "
                    "不要用之前的图』时，才可省略参考图。\n\n"
                    "⚠️ 若存在参考图场景却没有通过结构化参数 / 位置参数传入，"
                    "生成结果会和『文生图』毫无区别，用户会把这视为严重 bug。"
                )
            parts.append(skill_block)

        # ★ 临时约束/rule（用户在"编辑会话"对话框中直接填写的文本）
        user_constraints = (abilities.get("constraints") or "").strip()
        if user_constraints:
            parts.insert(0, user_constraints)  # 置于最前，优先级最高

        session.constraints = "\n\n---\n\n".join(parts) if parts else None
        # ★ Backend Skills：自动部署到 working_dir/.claude/skills/
        self._sync_backend_skills_to_directory(session)

    def _default_abilities(self) -> dict:
        """收集当前 PromptStore/SkillStore 中所有被标记为默认档的条目。"""
        try:
            default_prompts = list(self._prompt_store.list_default_names())
        except Exception as e:
            print(f"[BridgeWS] list_default_names (prompts) failed: {e}", file=sys.stderr)
            default_prompts = []
        try:
            default_skills = list(self._skill_store.list_default_names())
        except Exception as e:
            print(f"[BridgeWS] list_default_names (skills) failed: {e}", file=sys.stderr)
            default_skills = []
        return {"skills": default_skills, "prompts": default_prompts}

    def _rpc_updateSessionAbilities(self, session_id: str, abilities_json: str) -> str:
        """绑定/解绑 skill 和 prompt 到 session。"""
        try:
            abilities = json.loads(abilities_json)
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            if not session:
                return json.dumps({"status": "error", "message": "Session not found"}, ensure_ascii=False)
            self._apply_session_abilities(session, abilities)
            self._active_sessions[session_id] = session
            self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_setPromptDefault(self, name: str, is_default: bool = True) -> str:
        """将 Prompt 标记为默认档 / 取消默认档。"""
        try:
            ok = self._prompt_store.set_default(name.strip(), bool(is_default))
            if not ok:
                return json.dumps(
                    {"status": "error", "message": f"Prompt '{name}' not found"},
                    ensure_ascii=False,
                )
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] setPromptDefault error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_setSkillDefault(self, name: str, is_default: bool = True) -> str:
        """将 Skill 标记为默认档 / 取消默认档。"""
        try:
            ok = self._skill_store.set_default(name.strip(), bool(is_default))
            if not ok:
                return json.dumps(
                    {"status": "error", "message": f"Skill '{name}' not found"},
                    ensure_ascii=False,
                )
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            print(f"[BridgeWS] setSkillDefault error: {e}", file=sys.stderr)
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    def _rpc_getDefaultAbilities(self) -> str:
        """返回当前默认档集合，前端可用于预览/提示。"""
        try:
            return json.dumps(self._default_abilities(), ensure_ascii=False)
        except Exception as e:
            return json.dumps({"skills": [], "prompts": []})

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

    def _rpc_listDirectory(self, path: str) -> str:
        """列出目录内容，供前端 @ 文件引用选择器使用。
        返回 [{name, path, isDir}, ...] 目录优先，字母序排列，跳过隐藏文件。
        """
        import os
        try:
            entries = []
            with os.scandir(path) as it:
                for entry in sorted(it, key=lambda e: (not e.is_dir(), e.name.lower())):
                    if entry.name.startswith('.'):
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": entry.path.replace("\\", "/"),
                        "isDir": entry.is_dir(),
                    })
            return json.dumps(entries, ensure_ascii=False)
        except PermissionError:
            return json.dumps({"error": "无访问权限"}, ensure_ascii=False)
        except FileNotFoundError:
            return json.dumps({"error": "目录不存在"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": str(e)}, ensure_ascii=False)

    def _rpc_getAppConfig(self) -> str:
        return json.dumps(self._app_config_store.get_all(), ensure_ascii=False)

    def _rpc_setAppConfig(self, config_json: str) -> str:
        try:
            self._app_config_store.set_all(json.loads(config_json))
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ── RPC: Claude OAuth Token 获取（已移除，使用 claude login 替代）────────
    # 注：已移除 _rpc_startOAuthFlow，用户应使用 claude login 或 /login 命令登录

    # ── 权限门控 RPC ─────────────────────────────────────────────

    def _rpc_grantPermission(self, session_id: str, granted: bool, skip_rest: bool = False) -> None:
        """前端响应权限请求：granted=True 继续执行，False 取消。
        skip_rest=True 表示后续工具自动授权（用户点击了"跳过后续确认"）。
        """
        gate = self._permission_gates.get(session_id)
        if gate and not gate.done():
            try:
                gate.set_result(granted)
            except asyncio.InvalidStateError:
                pass  # 超时已处理，忽略
        # ★ 记录 skip_rest 标志，后续权限检查时跳过
        if skip_rest and granted:
            self._skip_rest_sessions.add(session_id)
            print(f"[bridge_ws] Session {session_id} 设置 skip_rest=True", file=sys.stderr, flush=True)

    def _check_skip_permission(self, session_id: str) -> bool:
        """检查 session 是否已设置跳过权限确认。"""
        return session_id in self._skip_rest_sessions

    def _clear_skip_permission(self, session_id: str):
        """清除 session 的跳过权限标志（消息结束时调用）。"""
        self._skip_rest_sessions.discard(session_id)

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
        # ★ 清理前一个未完成的 gate，防止协程永久挂起
        old_gate = self._permission_gates.get(session_id)
        if old_gate and not old_gate.done():
            old_gate.set_result(False)
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

        # ★ 用户贴图 + session 有 Backend Skill 时：
        #   保存图片到 skill-images 并在 content 中注入 HTTP URL，
        #   让模型知道可以把这些 URL 作为 ref_image 传给 skill
        if images and session.abilities and session.abilities.get("skills"):
            import base64 as _b64
            from pathlib import Path as _Path
            has_backend_skill = any(
                (self._skill_store.get_skill(s) or {}).get("backend")
                for s in session.abilities["skills"]
            )
            if has_backend_skill:
                img_urls = []
                for img in images:
                    if img.base64:
                        try:
                            tmp_dir = _Path.home() / ".agent-with-u" / "skill-images"
                            tmp_dir.mkdir(parents=True, exist_ok=True)
                            ext = img.mime_type.split("/")[-1].replace("jpeg", "jpg")
                            img_path = tmp_dir / f"user-{new_id()}.{ext}"
                            img_path.write_bytes(_b64.b64decode(img.base64))
                            url = f"http://127.0.0.1:{self._HTTP_API_PORT}/api/skill-images/{img_path.name}"
                            img_urls.append(url)
                        except Exception as e:
                            print(f"[bridge_ws] Failed to save user image: {e}",
                                  file=sys.stderr, flush=True)
                if img_urls:
                    url_note = "\n".join(f"[用户上传图片 URL: {u}]" for u in img_urls)
                    content = f"{url_note}\n\n{content}"
                    print(f"[bridge_ws] Saved {len(img_urls)} user images for Backend Skill",
                          file=sys.stderr, flush=True)

        user_msg = ChatMessage(id=new_id(), role="user", content=content, images=images)
        session.messages.append(user_msg)

        assistant_id = payload.get("messageId") or new_id()
        assistant_msg = ChatMessage(
            id=assistant_id, role="assistant", content="",
            backend_id=backend_id, streaming=True,
        )
        session.messages.append(assistant_msg)

        # ★ 每次发消息前重新部署 Backend Skill 文件，确保 SKILL.md 始终是最新模板
        self._sync_backend_skills_to_directory(session)

        await self._async_send(
            session, content, images, backend_id, assistant_id,
            auto_continue=auto_continue, skip_permissions=skip_permissions,
            constraints=session.constraints,
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
        constraints: Optional[str] = None,
    ):
        backend = self._get_backend(backend_id)
        assistant_msg = session.messages[-1]

        # ── 收集 Backend Skills（API 类 backend 使用）──
        extra_tools, skill_map = self._collect_backend_skills(session)
        if extra_tools:
            print(f"[bridge_ws] Session {session.id}: {len(extra_tools)} Backend Skills detected: "
                  f"{[t['name'] for t in extra_tools]}", file=sys.stderr, flush=True)

        # ── 内置 Skill 类型屏蔽对应的内置工具 ──
        # 避免 Claude 的原生工具（如 WebSearch）抢先于自定义 Skill
        _BUILTIN_TOOL_BLOCKLIST: dict[str, list[str]] = {
            "web-search": ["WebSearch"],
            "web-fetch": ["WebFetch"],
        }
        abilities = session.abilities or {}
        blocked_tools: set[str] = set()
        for sname in abilities.get("skills", []):
            info = self._skill_store.get_skill(sname)
            if info and info.get("type"):
                for tool in _BUILTIN_TOOL_BLOCKLIST.get(info["type"], []):
                    blocked_tools.add(tool)
        if blocked_tools:
            print(f"[bridge_ws] Skill-blocked native tools: {blocked_tools}", file=sys.stderr, flush=True)

        async def _on_tool_call(tool_name: str, tool_input: dict) -> str:
            """Skill 工具调用回调：路由到 Backend Skill 或内置/python-script 类型。"""
            mapping = (skill_map or {}).get(tool_name, {})
            skill_type = mapping.get("skill_type", "")
            sname = mapping.get("skill_name", tool_name.replace("_", "-"))
            BUILTIN_TYPES = {"web-search", "web-fetch", "python-script"}
            if skill_type in BUILTIN_TYPES or not mapping.get("backend_id"):
                # 内置或 python-script：走 HTTP skill-call 路由
                payload = {"skill": sname, **tool_input}
                # web-search 用 prompt 字段；其他类型直接透传 tool_input
                if skill_type == "web-search" and "query" in tool_input:
                    payload["prompt"] = tool_input["query"]
                elif skill_type == "web-fetch" and "url" in tool_input:
                    payload["url"] = tool_input["url"]
                _, result_text = await self._handle_skill_call(payload)
                return result_text
            return await self._execute_backend_skill(
                tool_name, tool_input, skill_map or {}, session, message_id,
            )
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
        max_retry = 1  # session 失效时重试一次，携带历史创建新 session

        for iteration in range(max_continuations + 1):
            iter_text: list[str] = []
            iter_thinking: list[str] = []
            iter_tools: list[ToolCallInfo] = []
            iter_usage: Optional[dict] = None
            retry_state = {"without_session": False}

            def on_delta(delta: StreamDelta):
                nonlocal iter_usage
                import time as _time
                if delta.type == "done":
                    if delta.usage:
                        iter_usage = delta.usage
                    return
                if delta.type == "resume_failed":
                    print(f"[bridge_ws] 收到 resume_failed 事件", file=sys.stderr, flush=True)
                    retry_state["without_session"] = True
                    return
                # ★ resume 失败后，压制 error delta（是 SDK 异常的误报，bridge 将重试）
                if retry_state["without_session"] and delta.type == "error":
                    print(f"[bridge_ws] 压制 resume 失败引发的 error delta（将重试）", file=sys.stderr, flush=True)
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
                        start_time=_time.time(),  # ★ Record start time
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
                            # ★ Calculate duration when tool completes
                            if tc.start_time:
                                tc.duration = int((_time.time() - tc.start_time) * 1000)
                                delta.tool_call = {**(delta.tool_call or {}), "duration": tc.duration}
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
                                                "old": tc.diff_before,
                                                "new": tc.diff_after,
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
                    if retry_state["without_session"]:
                        # ★ session 过期重建：无论消息数量，始终把历史注入新 session
                        # 这样第三方 API（dashscope 等）也能保持多轮对话上下文
                        prior_msgs = session.messages[:-1]
                        if prior_msgs:
                            history_str = compress_messages(prior_msgs, keep_recent=6)
                            send_content = (
                                f"以下是之前对话的历史记录，请在此基础上继续：\n\n"
                                f"{history_str}\n\n"
                                f"---\n\n{current_content}"
                            )
                            print(f"[bridge_ws] Session 过期重建，注入 {len(prior_msgs)} 条历史消息",
                                  file=sys.stderr, flush=True)
                    elif need_compress:
                        compressed = compress_messages(session.messages[:-1], keep_recent=6)
                        send_content = (
                            f"以下是之前对话的摘要，供你参考：\n\n{compressed}"
                            f"\n\n---\n\n请继续回答用户的问题：\n{current_content}"
                        )
                    msgs_for_backend = list(session.messages[:-1])
                    if all_text:
                        msgs_for_backend.append(ChatMessage(id=new_id(), role="assistant", content="".join(all_text)))
                    msgs_for_backend.append(ChatMessage(id=new_id(), role="user", content=current_content))

                # ★ 注入会话约束：将约束作为系统提示前缀发送给 AI（不存入对话记录）
                print(f"[bridge_ws] constraints为: {repr(constraints[:200]) if constraints else None}",
                      file=sys.stderr, flush=True)
                if constraints and constraints.strip():
                    send_content = f"[会话约束/规则]\n{constraints.strip()}\n\n---\n\n{send_content}"
                    print(f"[bridge_ws] 已注入约束，send_content前100字: {send_content[:100]!r}",
                          file=sys.stderr, flush=True)
                else:
                    print(f"[bridge_ws] 无约束，send_content前100字: {send_content[:100]!r}",
                          file=sys.stderr, flush=True)

                # ★ 内置 Skill 工具屏蔽指令：告诉模型不要使用被替代的原生工具
                if blocked_tools:
                    parts = [f"[工具限制] 禁止使用以下内置工具：{', '.join(blocked_tools)}。"]
                    if "WebSearch" in blocked_tools:
                        parts.append("搜索网页请使用 Skill: web-search 技能。")
                    if "WebFetch" in blocked_tools:
                        parts.append("抓取网页内容请使用 Skill: web-fetch 技能。")
                    parts.append("按 Skill 指令用 Bash 执行命令即可。")
                    block_instruction = "".join(parts)
                    send_content = f"{block_instruction}\n\n{send_content}"

                use_agent_session = session.agent_session_id

                # ★ 权限回调：用于工具执行前的权限确认
                async def _on_permission_request(req: PermissionRequest) -> bool:
                    """处理来自 backend 的权限请求，转发给前端等待确认。"""
                    # ★ 检查是否已设置跳过权限确认
                    if session.id in self._skip_rest_sessions:
                        print(f"[bridge_ws] Session {session.id} 已设置 skip_rest，自动授权", file=sys.stderr, flush=True)
                        return True

                    # 创建 ToolCallInfo 列表
                    from ..types import ToolCallInfo
                    tools = [ToolCallInfo(
                        id=req.tool_id,
                        name=req.tool_name,
                        input=req.tool_input,
                        output=None,
                        status="pending",
                    )]
                    return await self._await_permission_grant(
                        req.session_id, req.message_id, tools
                    )

                # ★ 传递 Backend Skill 工具定义给 backend
                _send_kwargs: dict = {
                    "messages": msgs_for_backend,
                    "content": send_content,
                    "images": current_images,
                    "session_id": session.id,
                    "message_id": message_id,
                    "on_delta": on_delta,
                    "agent_session_id": use_agent_session,
                    "working_dir": session.working_dir,
                    "skip_permissions": skip_permissions,
                    "on_permission_request": _on_permission_request,
                }
                # ★ API 类 backend：注入 Backend Skill 工具定义 + tool_use 回调
                # CLI 类 backend：不需要注入，走原生 Skill 目录发现 + curl 回调
                if extra_tools and skill_map:
                    from .anthropic_api import AnthropicAPIBackend
                    from .openai_compat import OpenAICompatibleBackend
                    if isinstance(backend, (AnthropicAPIBackend, OpenAICompatibleBackend)):
                        _send_kwargs["extra_tools"] = extra_tools
                        _send_kwargs["on_tool_call"] = _on_tool_call
                result = await backend.send_message(**_send_kwargs)

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
                    print(f"[bridge_ws] 准备重试 (retry_count={retry_count})", file=sys.stderr, flush=True)
                    continue
                elif retry_state["without_session"]:
                    # 已超过最大重试次数，报告错误
                    print(f"[bridge_ws] Resume 失败且已达到最大重试次数", file=sys.stderr, flush=True)
                    self._emit_delta(StreamDelta(
                        session.id, message_id, "error",
                        error="无法恢复之前的对话会话，已尝试使用历史记录重试",
                    ))
                    success = False

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

        try:
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

            # ★ 无论成功失败都发 done，确保前端不会卡在 streaming 状态
            self._emit_delta(StreamDelta(session.id, message_id, "done", usage=final_usage if success else None))
        finally:
            # ★ 确保 skip_rest 标志始终被清除，即使异常路径也不泄漏
            self._clear_skip_permission(session.id)

        session.updated_at = time.time()
        if session.title in ("新会话", "New session", "") and content:
            session.title = content[:50]
        self._session_store.save(session, async_=True)

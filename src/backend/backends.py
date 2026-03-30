"""
ModelBackend: Abstract interface for all model backends.
"""
import os
import sys
import asyncio
import json
import subprocess
from pathlib import Path
from abc import ABC, abstractmethod
from typing import Optional, Callable, Awaitable

import httpx

from ..types import (
    ModelBackendConfig,
    BackendType,
    ChatMessage,
    ImageAttachment,
    ToolCallInfo,
    new_id,
)


# ═══════════════════════════════════════════════════════════════════════════
#  ★ 权限请求类型：用于工具执行前的权限确认
# ═══════════════════════════════════════════════════════════════════════════

class PermissionRequest:
    """工具执行前的权限请求。"""

    def __init__(self, session_id: str, message_id: str, tool_id: str, tool_name: str, tool_input: str):
        self.session_id = session_id
        self.message_id = message_id
        self.tool_id = tool_id
        self.tool_name = tool_name
        self.tool_input = tool_input
        self._event = asyncio.Event()
        self._granted: Optional[bool] = None

    def grant(self, granted: bool):
        """设置权限结果并解除等待。"""
        self._granted = granted
        self._event.set()

    async def wait_for_decision(self, timeout: float = 300.0) -> bool:
        """等待用户决策，返回是否授权。"""
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
            return self._granted or False
        except asyncio.TimeoutError:
            return False


def _exc_msg(e: Exception) -> str:
    """Return a non-empty error message for any exception."""
    msg = str(e).strip()
    return msg if msg else f"{type(e).__name__}"


class StreamDelta:
    """
    A single streaming event pushed to the frontend.

    ★ delta_type 说明：
      text_delta   - 正文文本增量
      thinking     - 思考内容增量（新增）
      tool_start   - 工具调用开始（含名称、输入）
      tool_input   - 工具输入增量（增量式场景）
      tool_result  - 工具执行结果（含输出、状态）
      done         - 流结束
      error        - 错误
    """
    def __init__(
        self,
        session_id: str,
        message_id: str,
        delta_type: str,
        text: Optional[str] = None,
        tool_call: Optional[dict] = None,
        error: Optional[str] = None,
        usage: Optional[dict] = None,
    ):
        self.session_id = session_id
        self.message_id = message_id
        self.type = delta_type
        self.text = text
        self.tool_call = tool_call
        self.error = error
        self.usage = usage

    def to_dict(self) -> dict:
        d = {
            "sessionId": self.session_id,
            "messageId": self.message_id,
            "type": self.type,
        }
        if self.text is not None:
            d["text"] = self.text
        if self.tool_call is not None:
            d["toolCall"] = self.tool_call
        if self.error is not None:
            d["error"] = self.error
        if self.usage is not None:
            d["usage"] = self.usage
        return d


class ModelBackend(ABC):
    def __init__(self, config: ModelBackendConfig):
        self.config = config
        self._cancelled_sessions: set[str] = set()  # ★ Per-session cancellation

    @abstractmethod
    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None,
    ) -> dict:
        ...

    def abort(self, session_id: Optional[str] = None):
        """Cancel a specific session, or all sessions if session_id is None."""
        if session_id:
            self._cancelled_sessions.add(session_id)
        else:
            self._cancelled_sessions.add("__ALL__")

    def is_cancelled(self, session_id: str) -> bool:
        return session_id in self._cancelled_sessions or "__ALL__" in self._cancelled_sessions

    def clear_cancelled(self, session_id: str):
        self._cancelled_sessions.discard(session_id)

    def get_env(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get environment variable from backend config, with priority order:

        1. Backend config env dict
        2. Process environment variable
        3. Default value
        """
        # First check backend config
        config_value = self.config.get_env(key)
        if config_value is not None:
            return config_value
        # Fallback to process environment
        return os.environ.get(key, default)

    def get_model(self) -> str:
        """Get model name from config or environment."""
        return self.get_env("ANTHROPIC_MODEL") or self.config.model or "default"


# ---------------------------------------------------------------------------
#  Claude Agent Backend
# ---------------------------------------------------------------------------

STREAM_CHUNK_SIZE = 4        # characters per chunk
STREAM_CHUNK_DELAY = 0.015   # seconds between chunks (~266 chars/s)


class ClaudeAgentBackend(ModelBackend):
    """
    Uses the official `claude_agent_sdk` Python package (pip install claude-agent-sdk).
    The package bundles the Claude Code CLI internally — no separate CLI installation needed.

    Image support: images are passed natively via the AsyncIterable[dict] form of
    the prompt parameter using Anthropic content blocks (type: image / source: base64).
    """

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kwargs):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

        try:
            from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
        except ImportError:
            emit("error", error=(
                "claude-agent-sdk 未安装，请运行: pip install claude-agent-sdk"
            ))
            emit("done")
            return {}

        agent_sid = agent_session_id

        print(f"[ClaudeAgent] 收到请求, agent_session_id={agent_session_id!r}",
              file=sys.stderr, flush=True)

        try:
            model = self.get_env("ANTHROPIC_MODEL") or self.config.model
            tools: list[str] = list(getattr(self.config, "allowed_tools", None) or [
                "Read", "Edit", "Bash", "Glob", "Grep", "Write"
            ])
            # ★ 始终确保 Skill 工具可用，使 ~/.claude/skills/ 和 .claude/skills/ 中的 skill 可被调用
            if "Skill" not in tools:
                tools.append("Skill")
            cwd = working_dir or getattr(self.config, "working_dir", None) or "."
            if skip_permissions is None:
                skip_permissions = getattr(self.config, "skip_permissions", True)

            # 收集环境变量传给 SDK
            # ★ 代理：先自动检测系统代理，后端配置可覆盖
            import urllib.request as _urllib_req
            env_dict: dict[str, str] = {}
            try:
                sys_proxies = _urllib_req.getproxies()
                for scheme, env_keys in [("https", ("HTTPS_PROXY",)), ("http", ("HTTP_PROXY",))]:
                    url = sys_proxies.get(scheme)
                    if url:
                        for k in env_keys:
                            env_dict.setdefault(k, url)
            except Exception:
                pass
            for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                        "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                        "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
                        "https_proxy", "http_proxy", "all_proxy", "no_proxy"):
                val = self.get_env(key)
                if val:
                    env_dict[key] = val
            print(f"[ClaudeAgent] auth: API_KEY={'yes' if 'ANTHROPIC_API_KEY' in env_dict else 'no'}"
                  f", AUTH_TOKEN={'yes' if 'ANTHROPIC_AUTH_TOKEN' in env_dict else 'no'}"
                  f", proxy={env_dict.get('HTTPS_PROXY') or env_dict.get('https_proxy') or 'none'}",
                  file=sys.stderr, flush=True)

            # ★ 权限敏感的工具列表：这些工具需要用户确认
            PERMISSION_SENSITIVE_TOOLS = {"Bash", "Edit", "Write"}

            # ★ 图片处理：使用 AsyncIterable[dict] 形式的 prompt 原生传递图片
            # SDK 支持通过 yield Anthropic content blocks 的方式直接传递图片
            has_images = bool(images)

            # ★ 权限门控状态
            _permission_event = asyncio.Event()
            _permission_granted = True
            _waiting_for_permission = False

            def _set_permission_result(granted: bool):
                """设置权限结果并解除等待。"""
                nonlocal _permission_granted
                _permission_granted = granted
                _permission_event.set()

            async def _wait_for_permission(tool_id: str, tool_name: str, tool_input: str) -> bool:
                """等待权限确认，返回是否授权。"""
                nonlocal _waiting_for_permission
                if skip_permissions:
                    return True
                if tool_name not in PERMISSION_SENSITIVE_TOOLS:
                    return True
                if not on_permission_request:
                    return True

                # 发送权限请求 delta 给前端
                emit("permission_request", tool_call={
                    "id": tool_id,
                    "name": tool_name,
                    "input": tool_input,
                })

                # 等待前端响应
                _waiting_for_permission = True
                _permission_event.clear()
                try:
                    # 创建权限请求对象
                    req = PermissionRequest(session_id, message_id, tool_id, tool_name, tool_input)
                    granted = await on_permission_request(req)
                    _permission_granted = granted
                    return granted
                finally:
                    _waiting_for_permission = False

            async def _build_prompt():
                if not has_images:
                    yield content
                    return
                import base64 as _b64
                content_blocks: list[dict] = []
                for img in images:  # type: ignore[union-attr]
                    img_b64 = img.base64
                    if not img_b64 and img.file_path and os.path.exists(img.file_path):
                        with open(img.file_path, "rb") as f:
                            img_b64 = _b64.b64encode(f.read()).decode("ascii")
                    if img_b64:
                        content_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img_b64,
                            },
                        })
                content_blocks.append({"type": "text", "text": content})
                yield {
                    "type": "user",
                    "message": {"role": "user", "content": content_blocks},
                }

            options_kwargs: dict = dict(
                allowed_tools=tools,
                cwd=cwd,
                env=env_dict,
                # ★ 始终使用 bypassPermissions，让后端自己处理权限门控
                permission_mode="bypassPermissions",
                include_partial_messages=True,
                # ★ 加载用户级和项目级 settings（~/.claude/skills/ 和 .claude/skills/）
                # 这是 Skills 系统生效的必要条件，默认 SDK 不加载任何 settings
                setting_sources=["user", "project"],
            )
            if agent_session_id:
                options_kwargs["resume"] = agent_session_id
            if model and model not in ("sonnet", "claude-sonnet", "default"):
                options_kwargs["model"] = model
            cli_path = getattr(self.config, "cli_path", None)
            if cli_path:
                options_kwargs["cli_path"] = cli_path

            mcp_servers = getattr(self.config, "mcp_servers", None)
            if mcp_servers:
                options_kwargs["mcp_servers"] = mcp_servers
                print(f"[ClaudeAgent] MCP servers: {list(mcp_servers.keys())}",
                      file=sys.stderr, flush=True)

            options = ClaudeAgentOptions(**options_kwargs)

            print(f"[ClaudeAgent] SDK query: model={model}, resume={agent_session_id!r}, "
                  f"images={len(images or [])}, cwd={cwd}",
                  file=sys.stderr, flush=True)

            _done_emitted = False
            # 无图时直接传字符串，有图时用 async generator 传 content blocks
            # SDK 对 async generator yield str 的处理与直接传 str 行为不一致
            prompt_arg = _build_prompt() if has_images else content
            async for message in sdk_query(prompt=prompt_arg, options=options):
                if self.is_cancelled(session_id):
                    break
                # result 消息已处理完毕，静默耗尽剩余消息避免 anyio cancel scope 错误
                if _done_emitted:
                    continue

                _CLASS_TYPE_MAP = {
                    "SystemMessage": "system",
                    "StreamEvent": "stream_event",
                    "AssistantMessage": "assistant",
                    "TaskStartedMessage": "task_started",
                    "UserMessage": "user",
                    "ResultMessage": "result",
                }
                _class_name = type(message).__name__
                msg_type = getattr(message, "type", None) or _CLASS_TYPE_MAP.get(_class_name, _class_name)

                # ★ StreamEvent: include_partial_messages=True 时的流式增量事件
                if msg_type == "stream_event":
                    evt = getattr(message, "event", {})
                    etype = evt.get("type", "")
                    if etype == "content_block_delta":
                        delta = evt.get("delta", {})
                        dtype = delta.get("type", "")
                        if dtype == "text_delta":
                            emit("text_delta", text=delta.get("text", ""))
                        elif dtype == "thinking_delta":
                            thinking = delta.get("thinking", "")
                            if thinking:
                                emit("thinking", text=thinking)
                        elif dtype == "input_json_delta":
                            partial = delta.get("partial_json", "")
                            if partial:
                                emit("tool_input", tool_call={"inputDelta": partial})
                    elif etype == "content_block_start":
                        block = evt.get("content_block", {})
                        if block.get("type") == "tool_use":
                            tool_id = block.get("id", "")
                            tool_name = block.get("name", "")
                            emit("tool_start", tool_call={
                                "id": tool_id,
                                "name": tool_name,
                                "input": "",
                                "status": "running",
                            })
                            # ★ 权限门控：等待用户确认
                            if not skip_permissions and tool_name in PERMISSION_SENSITIVE_TOOLS:
                                granted = await _wait_for_permission(tool_id, tool_name, "")
                                if not granted:
                                    emit("error", error=f"权限被拒绝：{tool_name} 操作已取消")
                                    self.abort(session_id)
                                    break

                elif msg_type == "system":
                    if getattr(message, "subtype", None) == "init":
                        agent_sid = getattr(message, "session_id", agent_sid)
                        print(f"[ClaudeAgent] session_id={agent_sid}",
                              file=sys.stderr, flush=True)

                elif msg_type == "assistant":
                    # include_partial_messages=True 时 assistant 消息是已完成块的汇总
                    # 流式增量已通过 stream_event 处理，此处只处理 thinking/tool_use
                    for block in getattr(message, "content", []):
                        btype = getattr(block, "type", "")
                        if btype == "thinking":
                            # thinking 不走增量，完整输出
                            thinking = getattr(block, "thinking", "")
                            if thinking:
                                emit("thinking", text=thinking)
                        elif btype == "tool_use":
                            tool_input = getattr(block, "input", {})
                            input_str = (
                                json.dumps(tool_input, ensure_ascii=False, indent=2)
                                if tool_input else ""
                            )
                            emit("tool_start", tool_call={
                                "id": getattr(block, "id", ""),
                                "name": getattr(block, "name", ""),
                                "input": input_str,
                                "status": "running",
                            })

                elif msg_type == "user":
                    for block in getattr(message, "content", []):
                        btype = (
                            getattr(block, "type", None)
                            or (block.get("type") if isinstance(block, dict) else None)
                            or ""
                        )
                        if btype == "tool_result":
                            result_content = (
                                getattr(block, "content", None)
                                or (block.get("content") if isinstance(block, dict) else None)
                                or ""
                            )
                            if isinstance(result_content, list):
                                result_content = "\n".join(
                                    (p.get("text", json.dumps(p, ensure_ascii=False))
                                     if isinstance(p, dict) else str(p))
                                    for p in result_content
                                )
                            output_str = str(result_content or "")
                            if len(output_str) > 5000:
                                output_str = output_str[:5000] + "\n... (truncated)"
                            is_error = (
                                getattr(block, "is_error", None)
                                or (block.get("is_error") if isinstance(block, dict) else None)
                                or False
                            )
                            # ★ 兼容多种属性名，确保拿到正确的 tool_use_id
                            tool_id = (
                                getattr(block, "tool_use_id", None)
                                or (block.get("tool_use_id") if isinstance(block, dict) else None)
                                or getattr(block, "tool_call_id", None)
                                or (block.get("tool_call_id") if isinstance(block, dict) else None)
                                or getattr(block, "id", None)
                                or (block.get("id") if isinstance(block, dict) else None)
                                or ""
                            )
                            print(f"[ClaudeAgent] tool_result: id={tool_id!r}, "
                                  f"status={'error' if is_error else 'done'}, len={len(output_str)}",
                                  file=sys.stderr, flush=True)
                            emit("tool_result", tool_call={
                                "id": tool_id,
                                "output": output_str,
                                "status": "error" if is_error else "done",
                            })

                elif msg_type == "result":
                    agent_sid = getattr(message, "session_id", agent_sid)
                    print(f"[ClaudeAgent] session(result): {agent_sid}",
                          file=sys.stderr, flush=True)
                    is_error = getattr(message, "is_error", False)
                    subtype = getattr(message, "subtype", "")
                    if is_error or subtype == "error_during_execution":
                        print(f"[ClaudeAgent] Resume 失败: subtype={subtype}",
                              file=sys.stderr, flush=True)
                        emit("resume_failed")
                    usage_dict: Optional[dict] = None
                    try:
                        usage = getattr(message, "usage", None)
                        if usage:
                            in_tok = getattr(usage, "input_tokens", None)
                            out_tok = getattr(usage, "output_tokens", None)
                            if in_tok is not None or out_tok is not None:
                                usage_dict = {
                                    "inputTokens": in_tok or 0,
                                    "outputTokens": out_tok or 0,
                                }
                    except Exception as ue:
                        print(f"[ClaudeAgent] usage 读取失败: {ue}",
                              file=sys.stderr, flush=True)
                    emit("done", **({"usage": usage_dict} if usage_dict else {}))
                    _done_emitted = True  # 不 break，让生成器自然耗尽以避免 anyio cancel scope 错误

                elif msg_type not in ("task_started",):
                    print(f"[ClaudeAgent] 未处理的消息类型: {msg_type}",
                          file=sys.stderr, flush=True)
            if not _done_emitted:
                emit("done")
            return {"agentSessionId": agent_sid}

        except Exception as e:
            import traceback
            traceback.print_exc()
            emit("error", error=_exc_msg(e))
            emit("done")
            return {"agentSessionId": agent_sid}


# ---------------------------------------------------------------------------
#  Claude Code Official Backend (官方 Claude.ai 账户，直接调用 claude CLI 子进程)
#  与 ClaudeAgentBackend 的区别：
#    - 专门面向 ANTHROPIC_AUTH_TOKEN（Claude.ai Pro/Max 账户 OAuth token）
#    - 绕过 claude-agent-sdk 的 token 验证层，直接调用 claude CLI 子进程
#    - 完整继承系统环境变量，不依赖 SDK 的 env 隔离
# ---------------------------------------------------------------------------

class ClaudeCodeOfficialBackend(ModelBackend):
    """
    官方 Claude.ai 账户后端。

    使用 ANTHROPIC_AUTH_TOKEN（Claude.ai Pro/Max 订阅的 OAuth token）
    直接启动 `claude` CLI 子进程并解析 stream-json 输出。

    与 ClaudeAgentBackend 的核心区别：
    - 不经过 claude-agent-sdk 的 Python 层，避免 SDK 内部 token 验证失败
    - 直接 exec claude CLI，环境变量完全透明可控
    - 适合官方账户（非 API Key 用户）使用 claude code 本地 agent 能力
    """

    @staticmethod
    def read_local_token() -> Optional[str]:
        """从 claude login 存储的凭证文件读取 accessToken。

        文件位置：~/.claude/.credentials.json
        字段：claudeAiOauth.accessToken（sk-ant-oat01-... 格式）

        返回 None 表示未登录或文件不存在。
        """
        cred_file = Path.home() / ".claude" / ".credentials.json"
        if not cred_file.exists():
            return None
        try:
            data = json.loads(cred_file.read_text(encoding="utf-8"))
            token = data.get("claudeAiOauth", {}).get("accessToken")
            if token and isinstance(token, str):
                # 简单检查过期（expiresAt 是毫秒时间戳）
                import time
                expires_at = data.get("claudeAiOauth", {}).get("expiresAt", 0)
                if expires_at and expires_at < time.time() * 1000:
                    print("[OfficialBackend] 凭证已过期，请重新运行 claude login",
                          file=sys.stderr, flush=True)
                    return None
                return token
        except Exception as e:
            print(f"[OfficialBackend] 读取凭证失败: {e}", file=sys.stderr, flush=True)
        return None

    def _resolve_cli(self) -> str:
        cli = getattr(self.config, "cli_path", None)
        if cli:
            return str(cli)
        import sys as _sys
        if _sys.platform == "win32":
            import os as _os
            appdata = _os.environ.get("APPDATA", "")
            for name in ("claude.cmd", "claude.exe", "claude"):
                p = _os.path.join(appdata, "npm", name)
                if _os.path.exists(p):
                    return p
        return "claude"

    def _build_cmd(self, content: str, agent_session_id: Optional[str], cwd: str,
                   stdin_mode: bool = False) -> list[str]:
        import os as _os
        cmd = [self._resolve_cli()]

        model = self.get_env("ANTHROPIC_MODEL") or self.config.model
        if model and model not in ("sonnet", "claude-sonnet", "default"):
            cmd.extend(["--model", model])

        if agent_session_id:
            cmd.extend(["--resume", agent_session_id])

        tools: list[str] = list(getattr(self.config, "allowed_tools", None) or [
            "Read", "Edit", "Bash", "Glob", "Grep", "Write"
        ])
        # ★ 始终确保 Skill 工具可用
        if "Skill" not in tools:
            tools.append("Skill")
        for tool in tools:
            cmd.extend(["--allowedTools", tool])

        cmd.extend(["--output-format", "stream-json", "--verbose"])

        skip_permissions = getattr(self.config, "skip_permissions", True)
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")

        # ★ MCP servers：写入临时配置文件，通过 --mcp-config 传给 CLI
        mcp_servers = getattr(self.config, "mcp_servers", None)
        if mcp_servers:
            mcp_conf_dir = Path.home() / ".agent-with-u"
            mcp_conf_dir.mkdir(parents=True, exist_ok=True)
            mcp_conf_path = mcp_conf_dir / f"mcp_{self.config.id}.json"
            mcp_conf_path.write_text(
                json.dumps({"mcpServers": mcp_servers}, ensure_ascii=False),
                encoding="utf-8",
            )
            cmd.extend(["--mcp-config", str(mcp_conf_path)])
            print(f"[OfficialBackend] MCP config: {list(mcp_servers.keys())} -> {mcp_conf_path}",
                  file=sys.stderr, flush=True)

        if stdin_mode:
            # ★ 图片模式：通过 stdin 传入 stream-json 格式的多模态消息
            # --input-format stream-json 只在 --print/-p 模式下有效
            cmd.extend(["-p", "--input-format", "stream-json"])
        else:
            cmd.extend(["-p", content])

        return cmd

    def _build_env(self) -> dict:
        """构建子进程环境：继承系统 env，自动注入系统代理，再用后端配置覆盖。

        ★ 代理策略（优先级从低到高）：
          1. urllib.request.getproxies() 读取系统代理
             （Windows 注册表 / macOS 系统设置 / env 变量，三端通吃）
          2. 后端配置 env 字段显式设置（可覆盖自动检测）

        ★ 认证策略：
          - 默认不注入 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY（依赖 `claude login` 凭证）
          - 只有当后端配置的 env 字段中显式填写了 token 时才覆盖
        """
        import os as _os
        import urllib.request as _urllib_req

        proc_env = _os.environ.copy()

        # ── 步骤1：自动注入系统代理（仅在 env 里尚无代理时才填充）──────────
        # getproxies() 会读 Windows 注册表、macOS CFPreferences、以及 *_proxy 环境变量
        # 只要代理软件开了"系统代理"模式，这里就能自动拿到
        _already_has_proxy = any(
            proc_env.get(k)
            for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
        )
        if not _already_has_proxy:
            try:
                sys_proxies = _urllib_req.getproxies()
                # getproxies() 返回形如 {"https": "http://127.0.0.1:7890", "http": "..."}
                _proxy_map = {
                    "https": ("HTTPS_PROXY", "https_proxy"),
                    "http":  ("HTTP_PROXY",  "http_proxy"),
                }
                for scheme, env_keys in _proxy_map.items():
                    url = sys_proxies.get(scheme)
                    if url:
                        for k in env_keys:
                            proc_env.setdefault(k, url)
                _detected = proc_env.get("HTTPS_PROXY") or proc_env.get("https_proxy") or "none"
                print(f"[OfficialBackend] 系统代理自动检测: {_detected}",
                      file=sys.stderr, flush=True)
            except Exception as _pe:
                print(f"[OfficialBackend] 代理检测失败（无影响）: {_pe}",
                      file=sys.stderr, flush=True)

        # ── 步骤2：后端配置 env 字段（优先级最高，可覆盖上面所有）──────────
        for key in (
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
            "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "all_proxy", "no_proxy",
        ):
            val = self.config.get_env(key)
            if val is not None:
                if val:
                    proc_env[key] = val
                else:
                    # 显式设置空字符串 = 清除该变量（用于隔离/禁用代理）
                    proc_env.pop(key, None)

        # ── 步骤3：AUTH_TOKEN 兼容处理 ──────────────────────────────────────
        # ★ 核心规则：
        #   - OAuth token（sk-ant-oat01-）只能让 CLI 自己从 ~/.claude/.credentials.json
        #     读取，手动注入会绕过 CLI 内部的 token 刷新机制，导致
        #     "Failed to authenticate" 错误。
        #   - API key（sk-ant-api03-）可以通过 ANTHROPIC_API_KEY 注入。
        #
        # 处理流程：
        #   1. 若 proc_env 里的 ANTHROPIC_AUTH_TOKEN 是 OAuth token → 清除它，让 CLI 自管理
        #   2. 若 ANTHROPIC_AUTH_TOKEN 是真正的 API key → 同步到 ANTHROPIC_API_KEY

        cfg_auth = proc_env.get("ANTHROPIC_AUTH_TOKEN", "")
        if cfg_auth:
            if cfg_auth.startswith("sk-ant-oat"):
                # OAuth token：清除，让 CLI 自己走凭证文件路径
                proc_env.pop("ANTHROPIC_AUTH_TOKEN", None)
                print("[OfficialBackend] 使用本地 claude login 凭证（由 CLI 自管理，不手动注入 OAuth token）",
                      file=sys.stderr, flush=True)
            elif cfg_auth.startswith("sk-ant-api") and not proc_env.get("ANTHROPIC_API_KEY"):
                # 真正的 API key：同步给 ANTHROPIC_API_KEY
                proc_env["ANTHROPIC_API_KEY"] = cfg_auth

        return proc_env

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None,
    ) -> dict:
        self.clear_cancelled(session_id)
        _new_agent_sid: Optional[str] = agent_session_id

        def emit(delta_type: str, **kwargs):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

        cwd = working_dir or getattr(self.config, "working_dir", None) or "."

        # ★ 图片支持：有图时用 stdin stream-json 传递多模态内容块
        # claude CLI 不支持 --image 等独立图片参数，但 --input-format stream-json
        # 允许通过 stdin 传入包含 image content block 的 JSON 消息
        _stdin_data: Optional[bytes] = None
        if images:
            import base64 as _b64
            content_blocks: list[dict] = []
            for img in images:
                img_b64 = img.base64
                if not img_b64 and img.file_path and os.path.exists(img.file_path):
                    with open(img.file_path, "rb") as f:
                        img_b64 = _b64.b64encode(f.read()).decode("ascii")
                if img_b64:
                    content_blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.mime_type or "image/png",
                            "data": img_b64,
                        },
                    })
            content_blocks.append({"type": "text", "text": content})
            stdin_msg = json.dumps({
                "type": "user",
                "message": {"role": "user", "content": content_blocks},
            }) + "\n"
            _stdin_data = stdin_msg.encode("utf-8")
            print(f"[OfficialBackend] images: {len(content_blocks) - 1} block(s), using stdin stream-json",
                  file=sys.stderr, flush=True)

        cmd = self._build_cmd(content, agent_session_id, cwd, stdin_mode=bool(_stdin_data))
        proc_env = self._build_env()

        auth_token = proc_env.get("ANTHROPIC_AUTH_TOKEN", "")
        api_key = proc_env.get("ANTHROPIC_API_KEY", "")
        print(
            f"[OfficialBackend] cwd={cwd}, resume={agent_session_id!r}, "
            f"AUTH_TOKEN={'set('+str(len(auth_token))+'chars)' if auth_token else 'NONE'}, "
            f"API_KEY={'set('+str(len(api_key))+'chars)' if api_key else 'NONE'}, "
            f"cmd={cmd[:6]}",
            file=sys.stderr, flush=True,
        )

        loop = asyncio.get_event_loop()
        msg_queue: asyncio.Queue = asyncio.Queue()

        # Windows: 不显示黑色控制台窗口
        _popen_kwargs: dict = dict(
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE if _stdin_data else None,
            env=proc_env,
            cwd=cwd,
            bufsize=1,
        )
        if sys.platform == "win32":
            # CREATE_NO_WINDOW 避免弹出 cmd 黑窗口
            _popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            # Windows 下不指定 encoding，手动 decode 避免 GBK 崩溃
        else:
            _popen_kwargs["encoding"] = "utf-8"
            _popen_kwargs["errors"] = "replace"

        def _run():
            try:
                proc = subprocess.Popen(cmd, **_popen_kwargs)
                print(f"[OfficialBackend] pid={proc.pid}", file=sys.stderr, flush=True)
                # ★ 有图片时写入 stdin 后立即关闭，触发 CLI 开始处理
                if _stdin_data and proc.stdin:
                    try:
                        proc.stdin.write(_stdin_data)
                        proc.stdin.close()
                    except Exception as _e:
                        print(f"[OfficialBackend] stdin write error: {_e}", file=sys.stderr, flush=True)
                line_count = 0
                while True:
                    raw = proc.stdout.readline()
                    if not raw:
                        break
                    # Windows 二进制模式：手动 utf-8 解码
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", errors="replace")
                    line = raw.strip()
                    if not line:
                        continue
                    line_count += 1
                    print(f"[OfficialBackend] #{line_count}: {line[:120]}", file=sys.stderr, flush=True)
                    try:
                        obj = json.loads(line)
                        loop.call_soon_threadsafe(msg_queue.put_nowait, ("json", obj))
                    except json.JSONDecodeError:
                        loop.call_soon_threadsafe(msg_queue.put_nowait, ("text", line))
                proc.wait()
                raw_err = proc.stderr.read()
                if raw_err:
                    if isinstance(raw_err, bytes):
                        raw_err = raw_err.decode("utf-8", errors="replace")
                    stderr_s = raw_err.strip()
                    if stderr_s:
                        print(f"[OfficialBackend] stderr: {stderr_s[:800]}", file=sys.stderr, flush=True)
                loop.call_soon_threadsafe(msg_queue.put_nowait, ("proc_done", proc.returncode))
            except Exception as e:
                loop.call_soon_threadsafe(msg_queue.put_nowait, ("proc_error", str(e)))
            finally:
                # ★ 显式关闭 pipe，防止 Windows 文件描述符泄漏
                try:
                    proc.stdout.close()
                except Exception:
                    pass
                try:
                    proc.stderr.close()
                except Exception:
                    pass

        fut = loop.run_in_executor(None, _run)
        _done_emitted = False
        _usage: Optional[dict] = None
        _suppress_exit_error = [False]  # auth 错误时压制 "exited with code 1" 提示

        def _process_json_obj(obj: dict):
            nonlocal _new_agent_sid, _usage
            msg_type = obj.get("type", "")

            if msg_type == "system" and obj.get("subtype") == "init":
                _new_agent_sid = obj.get("session_id", _new_agent_sid)
                print(f"[OfficialBackend] session init: {_new_agent_sid}", file=sys.stderr, flush=True)

            elif msg_type == "assistant":
                for block in obj.get("message", {}).get("content", []):
                    btype = block.get("type", "")
                    if btype == "text":
                        t = block.get("text", "")
                        if t:
                            emit("text_delta", text=t)
                    elif btype == "thinking":
                        t = block.get("thinking", "")
                        if t:
                            emit("thinking", text=t)
                    elif btype == "tool_use":
                        emit("tool_start", tool_call={
                            "id": block.get("id", ""),
                            "name": block.get("name", ""),
                            "input": json.dumps(block.get("input", {}), ensure_ascii=False),
                            "status": "running",
                        })

            elif msg_type == "tool":
                for block in obj.get("content", []):
                    if block.get("type") == "tool_result":
                        raw_content = block.get("content", "")
                        if isinstance(raw_content, list):
                            raw_content = "\n".join(
                                p.get("text", json.dumps(p)) if isinstance(p, dict) else str(p)
                                for p in raw_content
                            )
                        output_str = str(raw_content)[:5000]
                        emit("tool_result", tool_call={
                            "id": block.get("tool_use_id", ""),
                            "output": output_str,
                            "status": "error" if block.get("is_error") else "done",
                        })

            elif msg_type == "content_block_delta":
                delta = obj.get("delta", {})
                dtype = delta.get("type", "")
                if dtype == "text_delta":
                    emit("text_delta", text=delta.get("text", ""))
                elif dtype == "thinking_delta":
                    emit("thinking", text=delta.get("thinking", ""))
                elif dtype == "input_json_delta":
                    emit("tool_input", tool_call={"inputDelta": delta.get("partial_json", "")})

            elif msg_type == "content_block_start":
                block = obj.get("content_block", {})
                if block.get("type") == "tool_use":
                    emit("tool_start", tool_call={
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "input": "",
                        "status": "running",
                    })

            elif msg_type == "result":
                _new_agent_sid = obj.get("session_id", _new_agent_sid)
                is_error = obj.get("is_error", False)
                subtype = obj.get("subtype", "")
                if is_error or subtype == "error_during_execution":
                    result_text = obj.get("result", "")
                    print(f"[OfficialBackend] result error: subtype={subtype}, text={result_text[:300]}",
                          file=sys.stderr, flush=True)
                    # 判断是否为认证/网络错误（区别于 session-resume 失败）
                    _lower = result_text.lower()
                    _is_auth_or_network = any(k in _lower for k in (
                        "failed to auth", "authentication failed", "unauthorized",
                        "invalid", "login", "credential", "expired",
                        "failed to fetch", "network", "econnrefused", "enotfound",
                    ))
                    if _is_auth_or_network:
                        # 发送友好提示气泡，压制后续 "exited with code 1"
                        _suppress_exit_error[0] = True
                        emit("text_delta", text=(
                            "\n\n---\n\n"
                            "💡 **账户或网络问题，请检查：**\n\n"
                            "- **未登录 / token 已过期**：点击右上角 ⚙️ → 编辑后端 → **一键打开登录终端** 重新登录，"
                            "或在终端手动运行 `claude login`\n"
                            "- **代理未开启**：访问 Claude 服务需要代理（VPN），"
                            "请确认代理已开启并在后端配置 `HTTPS_PROXY` 字段填写代理地址（如 `http://127.0.0.1:7890`）\n"
                            "- **网络中断**：确认网络连接正常后重新发送消息\n"
                        ))
                    else:
                        emit("resume_failed")
                usage = obj.get("usage", {})
                if usage:
                    _usage = {
                        "inputTokens": usage.get("input_tokens", 0),
                        "outputTokens": usage.get("output_tokens", 0),
                    }

        try:
            TIMEOUT = 7200
            waited = 0
            POLL = 10
            while True:
                if self.is_cancelled(session_id):
                    break
                try:
                    tag, payload = await asyncio.wait_for(msg_queue.get(), timeout=POLL)
                except asyncio.TimeoutError:
                    waited += POLL
                    if waited < TIMEOUT:
                        continue
                    emit("error", error=f"Timeout after {TIMEOUT//3600}h")
                    break

                if tag == "json":
                    _process_json_obj(payload)
                elif tag == "text":
                    emit("text_delta", text=payload + "\n")
                elif tag == "proc_done":
                    rc = payload
                    if rc != 0 and not _done_emitted and not _suppress_exit_error[0]:
                        emit("error", error=f"claude exited with code {rc}")
                    break
                elif tag == "proc_error":
                    emit("error", error=str(payload))
                    break

        except Exception as e:
            import traceback
            traceback.print_exc()
            emit("error", error=_exc_msg(e))

        if not _done_emitted:
            emit("done", **(_usage and {"usage": _usage} or {}))

        await asyncio.shield(fut)   # 等待线程退出，避免资源泄漏
        return {"agentSessionId": _new_agent_sid}


# ---------------------------------------------------------------------------
#  OpenAI Compatible Backend (unchanged)
# ---------------------------------------------------------------------------

class OpenAICompatibleBackend(ModelBackend):

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        skip_permissions: Optional[bool] = None,
        **kwargs,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kw):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kw))

        try:
            api_messages = []
            for m in messages:
                if m.role == "system":
                    continue
                if m.images:
                    # 历史消息含图片，重建 multimodal content 块
                    blocks: list[dict] = []
                    for img in m.images:
                        if img.base64:
                            blocks.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:{img.mime_type};base64,{img.base64}"},
                            })
                    blocks.append({"type": "text", "text": m.content})
                    api_messages.append({"role": m.role, "content": blocks})
                else:
                    api_messages.append({"role": m.role, "content": m.content})

            current_content: list[dict] = []
            if images:
                for img in images:
                    if img.base64:
                        current_content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{img.mime_type};base64,{img.base64}"
                            },
                        })
            current_content.append({"type": "text", "text": content})
            api_messages.append({"role": "user", "content": current_content})

            base_url = self.config.base_url or "https://api.openai.com/v1"
            headers = {"Content-Type": "application/json"}
            if self.config.api_key:
                headers["Authorization"] = f"Bearer {self.config.api_key}"

            _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0]
            _MAX_RETRIES = len(_RETRY_DELAYS)
            data_emitted = False
            last_error: Optional[str] = None

            for attempt in range(_MAX_RETRIES + 1):
                if self.is_cancelled(session_id):
                    break
                if attempt > 0:
                    delay = _RETRY_DELAYS[attempt - 1]
                    print(f"[OpenAI] retry {attempt}/{_MAX_RETRIES} in {delay}s ...",
                          file=sys.stderr, flush=True)
                    await asyncio.sleep(delay)
                try:
                    async with httpx.AsyncClient(timeout=120.0) as client:
                        async with client.stream(
                            "POST",
                            f"{base_url}/chat/completions",
                            json={
                                "model": self.config.model or "gpt-4o",
                                "messages": api_messages,
                                "stream": True,
                            },
                            headers=headers,
                        ) as response:
                            if response.status_code == 429 and attempt < _MAX_RETRIES:
                                last_error = f"API error: 429 (rate limited, retrying {attempt+1}/{_MAX_RETRIES})"
                                print(f"[OpenAI] 429 rate limit, will retry", file=sys.stderr, flush=True)
                                continue
                            if response.status_code != 200:
                                emit("error", error=f"API error: {response.status_code}")
                                emit("done")
                                return {}

                            async for line in response.aiter_lines():
                                if self.is_cancelled(session_id):
                                    break
                                line = line.strip()
                                if not line.startswith("data: "):
                                    continue
                                data = line[6:]
                                if data == "[DONE]":
                                    break
                                try:
                                    parsed = json.loads(data)
                                    delta = (parsed.get("choices", [{}])[0]
                                             .get("delta", {}))
                                    if delta.get("content"):
                                        emit("text_delta", text=delta["content"])
                                        data_emitted = True
                                except (json.JSONDecodeError, IndexError):
                                    pass
                    last_error = None
                    break  # success

                except (httpx.ConnectError, httpx.NetworkError,
                        httpx.TimeoutException, httpx.RemoteProtocolError) as e:
                    if data_emitted or attempt >= _MAX_RETRIES:
                        last_error = _exc_msg(e)
                        break
                    last_error = _exc_msg(e)
                    print(f"[OpenAI] network error ({last_error}), will retry",
                          file=sys.stderr, flush=True)

            if last_error and not self.is_cancelled(session_id):
                emit("error", error=last_error)
            emit("done")
            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                emit("error", error=_exc_msg(e))
            emit("done")
            return {}


# ---------------------------------------------------------------------------
#  Anthropic API Backend (uses anthropic Python SDK, supports images natively)
# ---------------------------------------------------------------------------

class AnthropicAPIBackend(ModelBackend):
    """
    Uses the official `anthropic` Python SDK to call Claude models directly.
    Supports images natively via the Anthropic messages API format.
    No CLI dependency required.
    """

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        skip_permissions: Optional[bool] = None,
        **kwargs,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kw):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kw))

        try:
            import anthropic as _anthropic
        except ImportError:
            emit("error", error=(
                "anthropic SDK not installed. Run: pip install anthropic"
            ))
            emit("done")
            return {}

        try:
            api_key = (
                self.get_env("ANTHROPIC_API_KEY")
                or self.get_env("ANTHROPIC_AUTH_TOKEN")
                or self.config.api_key
            )
            base_url = (
                self.get_env("ANTHROPIC_BASE_URL")
                or self.config.base_url
            )
            model = (
                self.get_env("ANTHROPIC_MODEL")
                or self.config.model
                or "claude-sonnet-4-6"
            )

            # Build conversation history
            api_messages: list[dict] = []
            for m in messages:
                if m.role == "system":
                    continue
                msg_content: list | str = m.content
                # Re-attach images from history if present
                if m.images:
                    blocks: list[dict] = []
                    for img in m.images:
                        img_b64 = img.base64
                        if not img_b64 and img.file_path:
                            import base64 as _b64
                            with open(img.file_path, "rb") as f:
                                img_b64 = _b64.b64encode(f.read()).decode("ascii")
                        if img_b64:  # skip broken image attachments
                            blocks.append({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": img.mime_type,
                                    "data": img_b64,
                                },
                            })
                    if m.content:  # only add text block if non-empty
                        blocks.append({"type": "text", "text": m.content})
                    if not blocks:
                        continue  # skip message with no valid content
                    msg_content = blocks
                elif not m.content:
                    # Skip empty text messages (e.g. interrupted assistant streams)
                    continue
                api_messages.append({"role": m.role, "content": msg_content})

            # Build current user message (text + optional images)
            current_blocks: list[dict] = []
            if images:
                for img in images:
                    img_b64 = img.base64
                    if not img_b64 and img.file_path:
                        import base64 as _b64
                        with open(img.file_path, "rb") as f:
                            img_b64 = _b64.b64encode(f.read()).decode("ascii")
                    if img_b64:  # skip broken image attachments
                        current_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img_b64,
                            },
                        })
            if content:  # only add text block if non-empty
                current_blocks.append({"type": "text", "text": content})
            if not current_blocks:
                current_blocks.append({"type": "text", "text": "(image)"})
            api_messages.append({"role": "user", "content": current_blocks})

            # System prompt
            system_msgs = [m.content for m in messages if m.role == "system"]
            system_str = "\n\n".join(system_msgs) if system_msgs else None

            if api_key:
                api_key = api_key.strip()
            print(f"[AnthropicAPI] model={model}, proxy={bool(base_url)}, "
                  f"images={len(images or [])}, history_len={len(api_messages)-1}, "
                  f"api_key={'set('+str(len(api_key))+'chars, prefix='+repr(api_key[:8])+')' if api_key else 'NONE'}",
                  file=sys.stderr, flush=True)

            input_tokens = 0
            output_tokens = 0

            if base_url:
                # ── 代理模式：httpx 直接调用，完全控制请求头 ──────────────────
                # Anthropic SDK 始终发送 x-api-key；MiniMax 等代理要求 Authorization: Bearer
                req_headers: dict[str, str] = {
                    "Content-Type": "application/json",
                    "anthropic-version": "2023-06-01",
                }
                if api_key:
                    # Send both headers: some proxies (e.g. MiniMax) require both
                    req_headers["Authorization"] = f"Bearer {api_key}"
                    req_headers["x-api-key"] = api_key
                # Merge user-configured extra headers (can override defaults)
                if self.config.extra_headers:
                    req_headers.update(self.config.extra_headers)
                req_body: dict = {
                    "model": model,
                    "max_tokens": 8096,
                    "messages": api_messages,
                    "stream": True,
                }
                if system_str:
                    req_body["system"] = system_str

                url = base_url.rstrip("/") + "/v1/messages"
                _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0]
                _MAX_RETRIES = len(_RETRY_DELAYS)
                _data_emitted = False
                _last_err: Optional[str] = None

                for _attempt in range(_MAX_RETRIES + 1):
                    if self.is_cancelled(session_id):
                        break
                    if _attempt > 0:
                        _d = _RETRY_DELAYS[_attempt - 1]
                        print(f"[AnthropicAPI] retry {_attempt}/{_MAX_RETRIES} in {_d}s ...",
                              file=sys.stderr, flush=True)
                        await asyncio.sleep(_d)
                    try:
                        async with httpx.AsyncClient(timeout=120.0) as hclient:
                            async with hclient.stream(
                                "POST", url, headers=req_headers, json=req_body
                            ) as resp:
                                if resp.status_code == 429 and _attempt < _MAX_RETRIES:
                                    _last_err = f"HTTP 429 (rate limited, retrying {_attempt+1}/{_MAX_RETRIES})"
                                    print(f"[AnthropicAPI] 429 rate limit, will retry",
                                          file=sys.stderr, flush=True)
                                    continue
                                if resp.status_code != 200:
                                    body = await resp.aread()
                                    raise Exception(
                                        f"HTTP {resp.status_code}: {body.decode(errors='replace')}"
                                    )
                                async for line in resp.aiter_lines():
                                    if self.is_cancelled(session_id):
                                        break
                                    if not line.startswith("data:"):
                                        continue
                                    data_str = line[5:].strip()
                                    if not data_str or data_str == "[DONE]":
                                        continue
                                    try:
                                        evt = json.loads(data_str)
                                    except json.JSONDecodeError:
                                        continue

                                    etype = evt.get("type", "")
                                    if etype == "content_block_delta":
                                        delta = evt.get("delta", {})
                                        dtype = delta.get("type", "")
                                        if dtype == "text_delta":
                                            emit("text_delta", text=delta.get("text", ""))
                                            _data_emitted = True
                                        elif dtype == "thinking_delta":
                                            emit("thinking", text=delta.get("thinking", ""))
                                        elif dtype == "input_json_delta":
                                            emit("tool_input", tool_call={
                                                "inputDelta": delta.get("partial_json", "")
                                            })
                                    elif etype == "content_block_start":
                                        block = evt.get("content_block", {})
                                        if block.get("type") == "tool_use":
                                            emit("tool_start", tool_call={
                                                "id": block.get("id", ""),
                                                "name": block.get("name", ""),
                                                "input": "",
                                                "status": "running",
                                            })
                                    elif etype == "message_delta":
                                        output_tokens = evt.get("usage", {}).get(
                                            "output_tokens", output_tokens
                                        )
                                    elif etype == "message_start":
                                        input_tokens = (
                                            evt.get("message", {})
                                            .get("usage", {})
                                            .get("input_tokens", input_tokens)
                                        )
                        _last_err = None
                        break  # success

                    except (httpx.ConnectError, httpx.NetworkError,
                            httpx.TimeoutException, httpx.RemoteProtocolError) as _ne:
                        if _data_emitted or _attempt >= _MAX_RETRIES:
                            _last_err = _exc_msg(_ne)
                            break
                        _last_err = _exc_msg(_ne)
                        print(f"[AnthropicAPI] network error ({_last_err}), will retry",
                              file=sys.stderr, flush=True)

                if _last_err:
                    raise Exception(_last_err)
            else:
                # ── 官方 Anthropic：使用 SDK ──────────────────────────────────
                client = _anthropic.AsyncAnthropic(
                    **({"api_key": api_key} if api_key else {})
                )
                async with client.messages.stream(
                    model=model,
                    max_tokens=8096,
                    system=system_str or _anthropic.NOT_GIVEN,
                    messages=api_messages,
                ) as stream:
                    async for event in stream:
                        if self.is_cancelled(session_id):
                            break

                        etype = type(event).__name__

                        if etype == "RawContentBlockDeltaEvent":
                            delta = event.delta
                            dtype = type(delta).__name__
                            if dtype == "TextDelta":
                                emit("text_delta", text=delta.text)
                            elif dtype == "ThinkingDelta":
                                emit("thinking", text=delta.thinking)
                            elif dtype == "InputJSONDelta":
                                emit("tool_input", tool_call={"inputDelta": delta.partial_json})

                        elif etype == "RawContentBlockStartEvent":
                            block = event.content_block
                            btype = type(block).__name__
                            if btype == "ToolUseBlock":
                                emit("tool_start", tool_call={
                                    "id": block.id,
                                    "name": block.name,
                                    "input": "",
                                    "status": "running",
                                })

                        elif etype == "RawMessageDeltaEvent":
                            usage = getattr(event, "usage", None)
                            if usage:
                                output_tokens = getattr(usage, "output_tokens", 0)

                        elif etype == "RawMessageStartEvent":
                            usage = getattr(event.message, "usage", None)
                            if usage:
                                input_tokens = getattr(usage, "input_tokens", 0)

            if not self.is_cancelled(session_id):
                usage_dict: Optional[dict] = None
                if input_tokens or output_tokens:
                    usage_dict = {
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                    }
                emit("done", **({"usage": usage_dict} if usage_dict else {}))

            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                import traceback
                traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}


# ---------------------------------------------------------------------------
#  Factory
# ---------------------------------------------------------------------------

def create_backend(config: ModelBackendConfig) -> ModelBackend:
    if config.type == BackendType.CLAUDE_AGENT_SDK:
        return ClaudeAgentBackend(config)
    elif config.type == BackendType.CLAUDE_CODE_OFFICIAL:
        return ClaudeCodeOfficialBackend(config)
    elif config.type == BackendType.ANTHROPIC_API:
        return AnthropicAPIBackend(config)
    elif config.type == BackendType.OPENAI_COMPATIBLE:
        return OpenAICompatibleBackend(config)
    else:
        raise ValueError(f"Unknown backend type: {config.type}")
"""QwenCodeSdkBackend — uses qwen-code-sdk (official Python SDK).

Migration from manual CLI subprocess to official SDK:
  - Old: subprocess.Popen("qwen -p <content> -o stream-json") + manual JSON parsing
  - New: qwen_code_sdk.query() with proper system_prompt injection

Key improvements:
  - System prompt: uses `append_system_prompt` instead of hacking into -p
  - Stream format: SDK handles stream-json parsing internally
  - Permission control: uses `permission_mode='yolo'` + `can_use_tool` callback
  - Session management: uses `resume` / `session_id` parameters
  - Error handling: typed exceptions (ProcessExitError, ValidationError, AbortError)

Message format compatibility:
  SDK returns the same Anthropic stream-json protocol, so frontend parsers
  need NO changes.
"""
import os
import sys
import asyncio
import json
from typing import Optional, Callable, Awaitable

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, ToolCallInfo, new_id
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg
from . import paths


# ---------------------------------------------------------------------------
#  CLI path resolution (fallback if SDK needs it)
# ---------------------------------------------------------------------------

def resolve_qwen_cli(config_cli_path: Optional[str] = None) -> str:
    """Resolve the qwen CLI path: config → npm global → system PATH."""
    if config_cli_path:
        return str(config_cli_path)

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("qwen.cmd", "qwen.ps1", "qwen"):
                p = os.path.join(appdata, "npm", name)
                if os.path.exists(p):
                    return p

    return "qwen"


# ---------------------------------------------------------------------------
#  Backend implementation
# ---------------------------------------------------------------------------

class QwenCodeSdkBackend(ModelBackend):
    """Qwen Code SDK backend.

    Uses the official `qwen-code-sdk` Python package for proper integration.
    System prompt injection is handled correctly via `append_system_prompt`.
    """

    def _resolve_cli(self) -> str:
        return resolve_qwen_cli(getattr(self.config, "cli_path", None))

    def _build_env(self) -> dict:
        """Build environment dict for SDK.

        Strategy:
          1. Auto-detect system proxy
          2. Backend config env overrides
          3. Map QWEN_PROVIDER → QWEN_AUTH_TYPE
          4. Convenience alias: api_key → OPENAI_API_KEY / DASHSCOPE_API_KEY
        """
        import urllib.request as _urllib_req

        proc_env: dict[str, str] = {}

        # Auto-detect system proxy
        _already_has_proxy = any(
            os.environ.get(k)
            for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
        )
        if not _already_has_proxy:
            try:
                sys_proxies = _urllib_req.getproxies()
                for scheme, env_keys in [("https", ("HTTPS_PROXY", "https_proxy")),
                                         ("http", ("HTTP_PROXY", "http_proxy"))]:
                    url = sys_proxies.get(scheme)
                    if url:
                        for k in env_keys:
                            proc_env.setdefault(k, url)
                _detected = proc_env.get("HTTPS_PROXY") or proc_env.get("https_proxy") or "none"
                print(f"[QwenSdk] proxy auto-detect: {_detected}",
                      file=sys.stderr, flush=True)
            except Exception as _pe:
                print(f"[QwenSdk] proxy detect failed (harmless): {_pe}",
                      file=sys.stderr, flush=True)

        # Backend config env overrides
        for key in (
            "DASHSCOPE_API_KEY", "DASHSCOPE_API_TOKEN",
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
            "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
            "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "all_proxy", "no_proxy",
            "QWEN_MODEL", "QWEN_AUTH_TYPE", "QWEN_PROVIDER",
        ):
            val = self.config.get_env(key)
            if val is not None:
                if val:
                    proc_env[key] = val
                else:
                    proc_env.pop(key, None)

        # Map QWEN_PROVIDER → QWEN_AUTH_TYPE
        provider = proc_env.get("QWEN_PROVIDER") or proc_env.get("QWEN_AUTH_TYPE")
        if provider:
            proc_env["QWEN_AUTH_TYPE"] = provider

        # Convenience alias: api_key → OPENAI_API_KEY / DASHSCOPE_API_KEY
        if self.config.api_key:
            auth_type = proc_env.get("QWEN_AUTH_TYPE", "openai")
            if auth_type == "openai":
                proc_env.setdefault("OPENAI_API_KEY", self.config.api_key)
            elif auth_type == "qwen-oauth":
                proc_env.setdefault("DASHSCOPE_API_KEY", self.config.api_key)
            elif auth_type == "anthropic":
                proc_env.setdefault("ANTHROPIC_API_KEY", self.config.api_key)

        # qwen-oauth fallback: DASHSCOPE_API_KEY → OPENAI_API_KEY
        _final_auth = proc_env.get("QWEN_AUTH_TYPE") or proc_env.get("QWEN_PROVIDER")
        if _final_auth == "qwen-oauth":
            _ds_key = proc_env.get("DASHSCOPE_API_KEY")
            if _ds_key and not proc_env.get("OPENAI_API_KEY"):
                proc_env["OPENAI_API_KEY"] = _ds_key
                print("[QwenSdk] qwen-oauth: mapped DASHSCOPE_API_KEY → OPENAI_API_KEY (fallback)",
                      file=sys.stderr, flush=True)
            if not proc_env.get("OPENAI_BASE_URL"):
                proc_env["OPENAI_BASE_URL"] = (
                    "https://dashscope.aliyuncs.com/compatible-mode/v1"
                )

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
        constraints: Optional[str] = None,
        sandbox_enabled: bool = True,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kwargs):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

        # Load SDK
        try:
            from qwen_code_sdk import query as sdk_query
            from qwen_code_sdk import (
                is_sdk_assistant_message,
                is_sdk_result_message,
                is_sdk_partial_assistant_message,
            )
        except ImportError as _imp_err:
            import traceback as _tb
            _detail = str(_imp_err)
            print(f"[QwenSdk] ImportError: {_detail}\n{_tb.format_exc()}", file=sys.stderr, flush=True)
            emit("error", error=f"qwen-code-sdk 加载失败：{_detail}\n请确认：pip install qwen-code-sdk")
            emit("done")
            return {}

        cwd = working_dir or getattr(self.config, "working_dir", None) or "."
        model = self.get_env("QWEN_MODEL") or self.config.model
        auth_type = (self.get_env("QWEN_PROVIDER")
                     or self.get_env("QWEN_AUTH_TYPE")
                     or "openai")

        # Allowed tools
        tools: list[str] = list(getattr(self.config, "allowed_tools", None) or [
            "Read", "Edit", "Bash", "Glob", "Grep", "Write"
        ])
        if "Skill" not in tools:
            tools.append("Skill")

        # Permission mode
        if skip_permissions is None:
            skip_permissions = getattr(self.config, "skip_permissions", True)
        permission_mode = "yolo" if skip_permissions else "default"

        # Environment
        env_dict = self._build_env()
        print(f"[QwenSdk] auth: {auth_type}, model={model!r}, permission_mode={permission_mode}",
              file=sys.stderr, flush=True)

        # Build prompt (handle images)
        has_images = bool(images)
        if has_images:
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
            prompt = {
                "type": "user",
                "message": {"role": "user", "content": content_blocks},
            }
            print(f"[QwenSdk] images: {len(content_blocks) - 1} block(s)", file=sys.stderr, flush=True)
        else:
            prompt = content

        # SDK options
        options = {
            "cwd": cwd,
            "model": model if model and model not in ("default",) else None,
            "path_to_qwen_executable": self._resolve_cli(),
            "permission_mode": permission_mode,
            "allowed_tools": tools,
            "auth_type": auth_type,
            "include_partial_messages": True,  # Stream partial messages
            "env": env_dict if env_dict else None,
        }

        # System prompt injection (★ KEY IMPROVEMENT)
        if constraints:
            options["append_system_prompt"] = constraints
            print(f"[QwenSdk] constraints injected via append_system_prompt ({len(constraints)} chars)",
                  file=sys.stderr, flush=True)

        # Session resume
        if agent_session_id:
            options["resume"] = agent_session_id

        # stderr callback
        _stderr_lines: list[str] = []
        def _on_stderr(line: str):
            line = line.rstrip()
            if line:
                _stderr_lines.append(line)
                print(f"[QwenSdk][stderr] {line}", file=sys.stderr, flush=True)
        options["stderr"] = _on_stderr

        # Sandbox tools
        SANDBOX_TOOLS = {"Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit"}

        # Permission-sensitive tools
        PERMISSION_SENSITIVE_TOOLS = {"Bash", "Edit", "Write"}

        # Permission callback
        async def _can_use_tool(tool_name: str, tool_input: dict, context) -> dict:
            """SDK permission callback. Returns PermissionAllowResult or PermissionDenyResult."""
            # Sandbox validation
            if sandbox_enabled and cwd and tool_name in SANDBOX_TOOLS:
                from .bridge_ws import validate_tool_sandbox
                _ok, _reason = validate_tool_sandbox(tool_name, tool_input, cwd)
                if not _ok:
                    print(f"[QwenSdk] sandbox violation: {tool_name} — {_reason}",
                          file=sys.stderr, flush=True)
                    emit("error", error=f"🔒 沙盒违规：{_reason}")
                    return {"behavior": "deny", "message": f"沙盒违规: {_reason}"}

            if skip_permissions:
                return {"behavior": "allow"}
            if tool_name not in PERMISSION_SENSITIVE_TOOLS:
                return {"behavior": "allow"}
            if not on_permission_request:
                return {"behavior": "allow"}

            # Send permission request to frontend
            tool_input_str = json.dumps(tool_input, ensure_ascii=False) if isinstance(tool_input, dict) else str(tool_input)
            perm_payload = {
                "id": context.get("tool_use_id", "") if isinstance(context, dict) else "",
                "name": tool_name,
                "input": tool_input_str,
            }
            emit("permission_request", tool_call=perm_payload)

            req = PermissionRequest(session_id, message_id,
                                    context.get("tool_use_id", "") if isinstance(context, dict) else "",
                                    tool_name, tool_input_str)
            granted = await on_permission_request(req)
            if granted:
                return {"behavior": "allow"}
            else:
                return {"behavior": "deny", "message": "Permission denied by user"}

        options["can_use_tool"] = _can_use_tool

        # Execute query
        _new_agent_sid: Optional[str] = agent_session_id
        _done_emitted = False
        _usage: Optional[dict] = None
        _suppress_exit_error = False

        try:
            async with sdk_query(prompt, options) as result:
                # Update session ID from result (SDK uses get_session_id() method)
                try:
                    sdk_session_id = result.get_session_id()
                    if sdk_session_id:
                        _new_agent_sid = sdk_session_id
                        print(f"[QwenSdk] session_id: {_new_agent_sid}", file=sys.stderr, flush=True)
                except Exception:
                    pass

                async for message in result:
                    if self.is_cancelled(session_id):
                        break

                    if is_sdk_assistant_message(message):
                        # Assistant message: contains content blocks
                        msg_dict = dict(message)
                        msg_content = msg_dict.get("message", {}).get("content", [])
                        msg_id = msg_dict.get("id", "")

                        for block in msg_content:
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
                                _tool_name = block.get("name", "")
                                _tool_input = block.get("input", {})
                                emit("tool_start", tool_call={
                                    "id": block.get("id", ""),
                                    "name": _tool_name,
                                    "input": json.dumps(_tool_input, ensure_ascii=False),
                                    "status": "running",
                                })

                    elif is_sdk_partial_assistant_message(message):
                        # Partial message: stream_event with content_block_delta/start/stop
                        msg_dict = dict(message)
                        event = msg_dict.get("event", {})
                        etype = event.get("type", "")
                        msg_uuid = msg_dict.get("uuid", "")

                        if etype == "content_block_delta":
                            delta = event.get("delta", {})
                            dtype = delta.get("type", "")
                            if dtype == "text_delta":
                                emit("text_delta", text=delta.get("text", ""))
                            elif dtype == "thinking_delta":
                                emit("thinking", text=delta.get("thinking", ""))
                            elif dtype == "input_json_delta":
                                emit("tool_input", tool_call={
                                    "inputDelta": delta.get("partial_json", ""),
                                })

                        elif etype == "content_block_start":
                            block = event.get("content_block", {})
                            if block.get("type") == "tool_use":
                                emit("tool_start", tool_call={
                                    "id": block.get("id", ""),
                                    "name": block.get("name", ""),
                                    "input": "",
                                    "status": "running",
                                })

                        elif etype == "content_block_stop":
                            # Tool input complete - permission check happens here
                            pass

                    elif is_sdk_result_message(message):
                        # Result message: session completed
                        msg_dict = dict(message)
                        _new_agent_sid = msg_dict.get("session_id", _new_agent_sid)
                        is_error = msg_dict.get("is_error", False)
                        subtype = msg_dict.get("subtype", "")

                        if is_error or subtype == "error_during_execution":
                            result_text = msg_dict.get("result", "")
                            err_obj = msg_dict.get("error", {})
                            err_msg = err_obj.get("message", "") if isinstance(err_obj, dict) else ""
                            display_text = result_text or err_msg

                            print(f"[QwenSdk] result error: subtype={subtype}, text={display_text[:300]}",
                                  file=sys.stderr, flush=True)

                            # Detect auth/network errors
                            _lower = display_text.lower()
                            _is_auth_or_network = any(k in _lower for k in (
                                "failed to auth", "authentication failed",
                                "unauthorized", "invalid", "login", "credential",
                                "expired", "failed to fetch", "network",
                                "econnrefused", "enotfound",
                                "缺少", "api key", "认证",
                            ))
                            if _is_auth_or_network:
                                _suppress_exit_error = True
                                emit("text_delta", text=(
                                    "\n\n---\n\n"
                                    "💡 **认证或网络问题，请检查：**\n\n"
                                    "- **API Key 未配置**：点击 ⚙️ → 编辑后端 → "
                                    "填写 API Key（DashScope / OpenAI 兼容）\n"
                                    "- **auth-type 不匹配**：确认 `QWEN_AUTH_TYPE` "
                                    "与 API Key 类型一致（openai / qwen-oauth / "
                                    "anthropic / gemini）\n"
                                    "- **代理未开启**：如需代理，请在后端配置 "
                                    "`HTTPS_PROXY` 字段\n"
                                ))
                            else:
                                emit("resume_failed")

                        # Usage stats
                        usage = msg_dict.get("usage", {})
                        if usage:
                            _usage = {
                                "inputTokens": usage.get("input_tokens", 0),
                                "outputTokens": usage.get("output_tokens", 0),
                            }

            # Stream completed normally
            _done_emitted = True
            emit("done", **(_usage and {"usage": _usage} or {}))

        except Exception as e:
            import traceback
            traceback.print_exc()
            err_msg = _exc_msg(e)
            print(f"[QwenSdk] exception: {err_msg}", file=sys.stderr, flush=True)

            # Check for stderr context
            if _stderr_lines:
                err_msg += "\n\n[SDK stderr]:\n" + "\n".join(_stderr_lines[-10:])

            emit("error", error=err_msg)
            if not _done_emitted:
                emit("done")

        return {"agentSessionId": _new_agent_sid}

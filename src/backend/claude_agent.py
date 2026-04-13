"""ClaudeAgentBackend — uses claude_agent_sdk."""
import os, sys, asyncio, json, threading
from pathlib import Path
from typing import Optional, Callable, Awaitable
from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, ToolCallInfo, new_id
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg

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
        constraints: Optional[str] = None,  # ★ Session-level constraints/rules/prompts
        sandbox_enabled: bool = True,  # ★ 沙盒开关
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kwargs):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

        try:
            from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
        except ImportError as _imp_err:
            import traceback as _tb
            _detail = str(_imp_err)
            print(f"[ClaudeAgent] ImportError: {_detail}\n{_tb.format_exc()}", file=sys.stderr, flush=True)
            emit("error", error=(
                f"claude-agent-sdk 加载失败: {_detail}\n请确认: pip install claude-agent-sdk"
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
            # ★ Layer 2 沙盒：需要路径校验的工具
            SANDBOX_TOOLS = {"Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit"}

            # ★ 图片处理：使用 AsyncIterable[dict] 形式的 prompt 原生传递图片
            # SDK 支持通过 yield Anthropic content blocks 的方式直接传递图片
            has_images = bool(images)

            # ★ 权限门控状态
            _permission_event = asyncio.Event()
            _permission_granted = True
            # ★ 追踪当前正在流式输入的 tool_use block，用于在 content_block_stop 时拿到完整 input
            # 现在同时用于权限门控和沙盒校验
            _pending_perm: dict | None = None   # {"id": str, "name": str, "parts": list[str]}
            _waiting_for_permission = False

            def _set_permission_result(granted: bool):
                """设置权限结果并解除等待。"""
                nonlocal _permission_granted
                _permission_granted = granted
                _permission_event.set()

            async def _wait_for_permission(tool_id: str, tool_name: str, tool_input: str) -> bool:
                """等待权限确认，返回是否授权。"""
                nonlocal _waiting_for_permission
                # ★ Layer 2 沙盒校验：在权限检查之前执行，不受 skip_permissions 影响，受 sandbox_enabled 控制
                if sandbox_enabled and cwd and tool_name in SANDBOX_TOOLS:
                    from .bridge_ws import validate_tool_sandbox
                    is_valid, reason = validate_tool_sandbox(tool_name, tool_input, cwd)
                    if not is_valid:
                        print(f"[ClaudeAgent] 🔒 沙盒拦截: {tool_name} — {reason}",
                              file=sys.stderr, flush=True)
                        emit("error", error=f"🔒 沙盒拦截: {reason}")
                        return False
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
                # ★ 注入约束/提示词到 prompt 中
                final_content = content
                if constraints:
                    final_content = f"以下是你必须遵守的规则和约束：\n\n{constraints}\n\n---\n\n{content}"

                if not has_images:
                    yield final_content
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
                content_blocks.append({"type": "text", "text": final_content})
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
            # ★ 注入约束到 prompt 中
            if has_images:
                prompt_arg = _build_prompt()
            elif constraints:
                prompt_arg = f"以下是你必须遵守的规则和约束：\n\n{constraints}\n\n---\n\n{content}"
            else:
                prompt_arg = content
            # ★ 持锁期间独占 SDK 运行时，防止不同 session 并发导致串流
            print(f"[ClaudeAgent] 等待 SDK 锁 session={session_id!r}",
                  file=sys.stderr, flush=True)
            # ★ 每次 sdk_query 在独立线程 + 独立 event loop 中运行，
            #   彻底隔离 anyio 运行时，多个 session 可真正并发且互不串扰。
            main_loop = asyncio.get_running_loop()
            _q: asyncio.Queue = asyncio.Queue()
            _DONE = object()
            _exc_box: list = [None]

            # 若 prompt_arg 是 async generator（有图片时），先在主循环中收集好，
            # 然后在子线程里用简单 list → async gen 的方式重新包装传给 SDK。
            if has_images:
                _collected_prompt: list = []
                async for _item in prompt_arg:  # type: ignore[union-attr]
                    _collected_prompt.append(_item)
                _prompt_for_thread: object = _collected_prompt
            else:
                _prompt_for_thread = prompt_arg  # str

            def _sdk_thread():
                import asyncio as _aio
                _tloop = _aio.new_event_loop()
                _aio.set_event_loop(_tloop)
                try:
                    async def _run():
                        if isinstance(_prompt_for_thread, list):
                            async def _gen():
                                for _x in _prompt_for_thread:
                                    yield _x
                            _p = _gen()
                        else:
                            _p = _prompt_for_thread  # type: ignore[assignment]
                        try:
                            async for _msg in sdk_query(prompt=_p, options=options):
                                main_loop.call_soon_threadsafe(_q.put_nowait, _msg)
                        except Exception as _e:
                            _exc_box[0] = _e
                        finally:
                            main_loop.call_soon_threadsafe(_q.put_nowait, _DONE)
                    _tloop.run_until_complete(_run())
                finally:
                    _tloop.close()

            _t = threading.Thread(target=_sdk_thread, daemon=True,
                                  name=f"sdk-{session_id[:8]}")
            _t.start()
            print(f"[ClaudeAgent] 线程 {_t.name} 已启动", file=sys.stderr, flush=True)

            # 从队列消费消息（线程推送到主循环）
            while True:
                _msg = await _q.get()
                if _msg is _DONE:
                    break
                message = _msg

                if self.is_cancelled(session_id):
                    break
                if _done_emitted:
                    continue

                _CLASS_TYPE_MAP = {
                    "SystemMessage": "system",
                    "StreamEvent": "stream_event",
                    "AssistantMessage": "assistant",
                    "TaskStartedMessage": "task_started",
                    "TaskProgressMessage": "task_progress",
                    "TaskNotificationMessage": "task_notification",
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
                                # ★ 同步累积到 _pending_perm，以便 content_block_stop 时拿到完整 input
                                if _pending_perm is not None:
                                    _pending_perm["parts"].append(partial)
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
                            # ★ 记录待确认 tool，等 content_block_stop 时输入完整再弹权限门 / 沙盒校验
                            _need_track = (
                                (not skip_permissions and tool_name in PERMISSION_SENSITIVE_TOOLS)
                                or (sandbox_enabled and tool_name in SANDBOX_TOOLS)
                            )
                            if _need_track:
                                _pending_perm = {"id": tool_id, "name": tool_name, "parts": []}
                            else:
                                _pending_perm = None
                    elif etype == "content_block_stop":
                        # ★ 工具输入已完整，现在才发起权限确认
                        if _pending_perm is not None:
                            perm = _pending_perm
                            _pending_perm = None
                            full_input = "".join(perm["parts"])
                            granted = await _wait_for_permission(perm["id"], perm["name"], full_input)
                            if not granted:
                                emit("error", error=f"权限被拒绝：{perm['name']} 操作已取消")
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
                    _done_emitted = True  # 不 break，让生成器自然耗尽（线程会自行结束）

                elif msg_type not in ("task_started", "task_progress", "task_notification"):
                    print(f"[ClaudeAgent] 未处理的消息类型: {msg_type}",
                          file=sys.stderr, flush=True)

            # 等待线程结束，传播线程内异常
            _t.join(timeout=120)
            if _exc_box[0] is not None:
                raise _exc_box[0]
            if not _done_emitted:
                emit("done")
            return {"agentSessionId": agent_sid}

        except Exception as e:
            import traceback
            traceback.print_exc()
            emit("error", error=_exc_msg(e))
            emit("done")
            return {"agentSessionId": agent_sid}



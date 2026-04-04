"""ClaudeCodeOfficialBackend — spawns claude CLI subprocess."""
import os, sys, asyncio, json, subprocess
from pathlib import Path
from typing import Optional, Callable, Awaitable
from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, ToolCallInfo, new_id
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg

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

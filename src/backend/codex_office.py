"""CodexOfficeBackend — runs OpenAI Codex CLI in non-interactive exec mode."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import math
from pathlib import Path
from typing import Optional, Callable, Awaitable
from urllib.parse import urlsplit

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg, cli_available, cli_missing_message


_PROXY_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)


def _normalize_proxy_url(value: object) -> str:
    """Normalize the HTTP proxy URL accepted by Codex's WebSocket client."""
    proxy = str(value or "").strip()
    if not proxy:
        return ""
    if "://" not in proxy:
        proxy = f"http://{proxy}"
    parsed = urlsplit(proxy)
    if parsed.scheme.lower() != "http" or not parsed.hostname:
        return ""
    return proxy


def _smooth_text_chunks(text: str) -> list[str]:
    """Split a completed CLI message into a short, bounded UI stream."""
    if not text:
        return []
    # 大约最多 300 帧：短回答接近逐字，长回答也不会因动画额外等待太久。
    chunk_size = max(2, math.ceil(len(text) / 300))
    return [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]


def _is_windows_store_codex(path: str) -> bool:
    """Return whether *path* points into the protected Codex app package."""
    if sys.platform != "win32" or not path:
        return False
    normalized = os.path.normcase(os.path.abspath(os.path.expandvars(path)))
    windows_apps = os.path.normcase(os.path.join(
        os.environ.get("ProgramFiles", r"C:\Program Files"), "WindowsApps",
    ))
    return normalized == windows_apps or normalized.startswith(windows_apps + os.sep)


def resolve_codex_cli(config_cli_path: Optional[str] = None) -> str:
    """Resolve an independently installed Codex CLI executable.

    The executable bundled in the Microsoft Store Codex app is an internal app
    component. External processes cannot execute it, so never select it as a
    CLI even when the app's resources directory leaked into PATH.
    """
    if config_cli_path:
        configured = os.path.expandvars(os.path.expanduser(str(config_cli_path)))
        if not _is_windows_store_codex(configured):
            return configured
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("codex.cmd", "codex.exe"):
                p = os.path.join(appdata, "npm", name)
                if os.path.exists(p):
                    return p
    discovered = shutil.which("codex")
    if discovered and not _is_windows_store_codex(discovered):
        return discovered
    return "codex"


def _codex_launch_command(codex_cli: str, args: list[str]) -> list[str]:
    """Build a CreateProcess-compatible command, including npm .cmd shims."""
    command = [codex_cli, *args]
    if sys.platform == "win32" and Path(codex_cli).suffix.lower() in {".cmd", ".bat"}:
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        return [comspec, "/d", "/s", "/c", subprocess.list2cmdline(command)]
    return command


class CodexOfficeBackend(ModelBackend):
    """OpenAI Codex CLI backend.

    Uses `codex exec --json` so AgentWithU can run Codex as a local office-style
    agent, similar to the existing Claude official-account backend.  Codex's
    documented non-interactive mode supports JSON events, workspace selection,
    model override, sandbox policy, image attachments, and exec-session resume.
    """

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.config.env:
            env.update({k: str(v) for k, v in self.config.env.items() if v is not None})

        # 代理只作用于 Codex 子进程，不修改 AgentWithU 或 Windows 的全局网络设置。
        # 旧配置只有 HTTPS_PROXY 时视为 custom，避免升级后行为突变。
        configured = self.config.env or {}
        mode = str(configured.get("AGENTWITHU_CODEX_PROXY_MODE") or "").strip().lower()
        raw_proxy = (
            configured.get("AGENTWITHU_CODEX_PROXY")
            or configured.get("HTTPS_PROXY")
            or configured.get("https_proxy")
            or ""
        )
        proxy = _normalize_proxy_url(raw_proxy)
        if not mode:
            mode = "custom" if proxy else "inherit"

        if mode == "direct":
            for key in _PROXY_ENV_KEYS:
                env.pop(key, None)
        elif mode == "system":
            # 避免环境变量抢占 Windows 系统代理；系统代理由 Codex 功能开关读取。
            for key in _PROXY_ENV_KEYS:
                env.pop(key, None)
        elif mode == "custom":
            # custom 模式不应意外继承宿主代理；地址无效时保持无代理，日志会显示 '-'。
            for key in _PROXY_ENV_KEYS:
                env.pop(key, None)
            if proxy:
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                            "http_proxy", "https_proxy", "all_proxy"):
                    env[key] = proxy
                no_proxy = str(configured.get("AGENTWITHU_CODEX_NO_PROXY") or "").strip()
                if no_proxy:
                    env["NO_PROXY"] = no_proxy
                    env["no_proxy"] = no_proxy

        for key in (
            "AGENTWITHU_CODEX_PROXY_MODE",
            "AGENTWITHU_CODEX_PROXY",
            "AGENTWITHU_CODEX_NO_PROXY",
            "AGENTWITHU_CODEX_FORCE_HTTP",
        ):
            env.pop(key, None)
        if self.config.api_key:
            env.setdefault("OPENAI_API_KEY", self.config.api_key)
        if self.config.base_url:
            env.setdefault("OPENAI_BASE_URL", self.config.base_url)
        env.setdefault("NO_COLOR", "1")
        return env

    def _native_resume_enabled(self) -> bool:
        """Use Codex native threads unless explicitly disabled.

        Native resume preserves the actual agent context and avoids re-sending
        a large constraints/history prompt on every short conversational turn.
        The environment switch remains available as an emergency opt-out.
        """
        val = (
            self.config.get_env("AGENTWITHU_CODEX_NATIVE_RESUME")
            or self.config.get_env("CODEX_USE_NATIVE_RESUME")
        )
        if val is None or not str(val).strip():
            return True
        return str(val).strip().lower() not in {"0", "false", "no", "off"}

    def _network_summary(self) -> str:
        """Return a credential-free summary for startup diagnostics."""
        configured = self.config.env or {}
        mode = str(configured.get("AGENTWITHU_CODEX_PROXY_MODE") or "").strip().lower()
        proxy = _normalize_proxy_url(
            configured.get("AGENTWITHU_CODEX_PROXY")
            or configured.get("HTTPS_PROXY")
            or configured.get("https_proxy")
            or ""
        )
        if not mode:
            mode = "custom" if proxy else "inherit"
        endpoint = ""
        if mode == "system":
            endpoint = "windows-system"
        elif proxy:
            parsed = urlsplit(proxy)
            endpoint = parsed.hostname or "configured"
            if parsed.port:
                endpoint += f":{parsed.port}"
        return f"proxy_mode={mode!r}, proxy_endpoint={endpoint or '-'}"

    def _system_proxy_enabled(self) -> bool:
        configured = self.config.env or {}
        return str(configured.get("AGENTWITHU_CODEX_PROXY_MODE") or "").strip().lower() == "system"

    def _proxy_config_error(self) -> Optional[str]:
        configured = self.config.env or {}
        mode = str(configured.get("AGENTWITHU_CODEX_PROXY_MODE") or "").strip().lower()
        if mode != "custom":
            return None
        raw = configured.get("AGENTWITHU_CODEX_PROXY") or ""
        if _normalize_proxy_url(raw):
            return None
        return (
            "Codex 独立代理地址无效。请填写 HTTP / mixed 代理地址，例如 "
            "http://192.168.1.20:7897；Codex 当前 WebSocket 链路不接受 "
            "socks5://、https:// 或其他代理协议。"
        )

    async def _ensure_cli_usable(self, codex_cli: str) -> Optional[str]:
        """Probe the selected CLI once before its first real request."""
        if getattr(self, "_probed_codex_cli", None) == codex_cli:
            return None
        if _is_windows_store_codex(codex_cli):
            return (
                "检测到的是 Codex Windows App 内部组件，外部程序无权执行。"
                "请另外安装 Codex CLI：`npm install -g @openai/codex`。"
            )
        try:
            probe = _codex_launch_command(codex_cli, ["--version"])
            proc = await asyncio.create_subprocess_exec(
                *probe,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        except (OSError, asyncio.TimeoutError) as exc:
            return f"Codex CLI 启动探测失败：{_exc_msg(exc)}"
        if proc.returncode != 0:
            detail = (stderr or stdout).decode("utf-8", errors="replace").strip()
            return f"Codex CLI 无法运行（退出码 {proc.returncode}）：{detail}"
        self._probed_codex_cli = codex_cli
        return None


    def _build_prompt(
        self,
        messages: list[ChatMessage],
        content: str,
        constraints: Optional[str],
        *,
        include_history: bool = True,
        include_constraints: bool = True,
    ) -> str:
        parts: list[str] = []
        if include_constraints and constraints:
            parts.append(
                "<system_constraints>\n"
                "以下内容是系统/开发者/会话级规则，必须遵守；它不是用户要你补充或改写的任务。\n"
                f"{constraints}\n"
                "</system_constraints>"
            )
        if include_history and messages:
            history = []
            for m in messages[-12:]:
                if m.content:
                    history.append(f"[{m.role.upper()}]\n{m.content}")
            if history:
                parts.append(
                    "<recent_session_context>\n"
                    "以下是当前会话的最近上下文，仅用于理解，不要把它当成新的用户请求。\n\n"
                    + "\n\n".join(history)
                    + "\n</recent_session_context>"
                )
        parts.append(
            "<user_request>\n"
            f"{content}\n"
            "</user_request>\n\n"
            "请直接回答或执行 <user_request> 中的当前用户请求；不要要求用户重复提供上面的系统约束。"
        )
        return "\n\n---\n\n".join(parts)

    def _build_cmd(
        self,
        *,
        codex_cli: str,
        prompt: str,
        model: str,
        approval_mode: str,
        sandbox_mode: str,
        agent_session_id: Optional[str],
        output_path: Optional[str],
        image_paths: list[str],
        stdin_mode: bool,
    ) -> list[str]:
        """Build a Codex CLI command in the same spirit as Claude official.

        Short prompts are passed as the CLI's positional [PROMPT].  Only long
        prompts use `-` + stdin to avoid Windows command-line length limits.
        Resume-specific flags must stay before SESSION_ID; anything after the
        session id is parsed as prompt text by some Codex CLI versions.
        """
        cmd: list[str] = []
        if self._system_proxy_enabled():
            # Codex 0.144+ 可通过该功能读取 Windows/WinINET 系统代理设置。
            cmd.extend(["--enable", "respect_system_proxy"])
        if model:
            cmd.extend(["--model", model])
        if approval_mode == "never" and sandbox_mode == "danger-full-access":
            # Older Codex builds expose this compatibility flag prominently
            # for `exec resume`; it is equivalent to no approvals + no sandbox.
            cmd.append("--dangerously-bypass-approvals-and-sandbox")
        else:
            cmd.extend(["--ask-for-approval", approval_mode])
            cmd.extend(["--sandbox", sandbox_mode])

        if agent_session_id:
            cmd.extend(["exec", "resume", "--json"])
        else:
            cmd.extend(["exec", "--json"])
            if output_path:
                cmd.extend(["--skip-git-repo-check", "--output-last-message", output_path])

        for path in image_paths:
            cmd.extend(["--image", path])

        if agent_session_id:
            cmd.append(agent_session_id)

        cmd.append("-" if stdin_mode else prompt)
        return _codex_launch_command(codex_cli, cmd)

    @staticmethod
    def _decode_text_payload(obj: dict) -> str:
        """Best-effort extraction from Codex JSON event shapes."""
        for key in ("delta", "text", "content", "message", "output"):
            val = obj.get(key)
            if isinstance(val, str):
                return val
        msg = obj.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                chunks = []
                for item in content:
                    if isinstance(item, dict):
                        chunks.append(str(item.get("text") or item.get("content") or ""))
                    else:
                        chunks.append(str(item))
                return "".join(chunks)
        item = obj.get("item")
        if isinstance(item, dict):
            text = item.get("text") or item.get("content") or item.get("message")
            if isinstance(text, str):
                return text
        return ""

    @staticmethod
    def _extract_session_id(obj: dict) -> Optional[str]:
        for key in ("session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId", "id"):
            val = obj.get(key)
            if isinstance(val, str) and val:
                # Avoid treating every event id/tool id as the resumable session id.
                typ = str(obj.get("type") or obj.get("event") or "").lower()
                if key == "id" and typ not in {"session", "session_created", "exec_session", "thread.started"}:
                    continue
                return val
        return None

    @staticmethod
    def _command_tool_payload(obj: dict, item: dict) -> dict:
        """Convert a verbose Codex command event into a compact tool payload."""
        command = item.get("command") or item.get("input") or ""
        if isinstance(command, list):
            command = subprocess.list2cmdline([str(part) for part in command])
        elif not isinstance(command, str):
            command = json.dumps(command, ensure_ascii=False)

        lowered = command.lower()
        if "powershell" in lowered or "pwsh" in lowered:
            name = "PowerShell"
        elif "python" in lowered:
            name = "Python"
        elif "cmd.exe" in lowered:
            name = "Command Prompt"
        else:
            name = "Command"

        output = item.get("aggregated_output")
        if output is None:
            output = item.get("output") or item.get("stdout") or ""
        if not isinstance(output, str):
            output = json.dumps(output, ensure_ascii=False)

        item_id = str(item.get("id") or obj.get("id") or "")
        item_status = str(item.get("status") or "").lower()
        event_type = str(obj.get("type") or obj.get("event") or "").lower()
        completed = (
            "completed" in event_type
            or item_status in {"completed", "done", "failed", "error"}
        )
        exit_code = item.get("exit_code")
        failed = item_status in {"failed", "error"} or (
            isinstance(exit_code, int) and exit_code != 0
        )
        return {
            "id": item_id,
            "name": name,
            "input": command,
            "output": output,
            "completed": completed,
            "status": "error" if failed else ("done" if completed else "running"),
        }

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

        async def emit_completed_text(text: str) -> None:
            """Animate CLI item.completed payloads without altering real deltas."""
            enabled = str(
                self.config.get_env("AGENTWITHU_CODEX_SMOOTH_STREAM", "true") or "true"
            ).strip().lower() not in {"0", "false", "no", "off"}
            chunks = _smooth_text_chunks(text) if enabled else [text]
            for index, chunk in enumerate(chunks):
                emit("text_delta", text=chunk)
                if enabled and index + 1 < len(chunks):
                    await asyncio.sleep(0.016)

        cwd = working_dir or self.config.working_dir or "."
        use_native_resume = self._native_resume_enabled()
        codex_resume_id = agent_session_id if use_native_resume else None
        # Like Claude official, resumed CLI sessions should rely on the native
        # agent thread instead of re-injecting recent AgentWithU history.  This
        # avoids duplicated context, lowers token use, and reduces self-repeat.
        prompt = self._build_prompt(
            messages,
            content,
            constraints,
            include_history=not bool(codex_resume_id),
            include_constraints=not bool(codex_resume_id),
        )
        model = self.config.model or self.get_env("OPENAI_MODEL") or ""
        skip = self.config.skip_permissions if skip_permissions is None else bool(skip_permissions)

        output_path = None
        image_tmpdir = None
        proc: Optional[asyncio.subprocess.Process] = None
        collected: list[str] = []
        started_tool_ids: set[str] = set()
        new_agent_sid = codex_resume_id
        stdin_data: Optional[bytes] = None
        final_usage: Optional[dict] = None

        try:
            proxy_error = self._proxy_config_error()
            if proxy_error:
                emit("error", error=proxy_error)
                return {"agentSessionId": new_agent_sid}

            codex_cli = resolve_codex_cli(self.config.cli_path)
            if not cli_available(codex_cli):
                emit("error", error=cli_missing_message(
                    "Codex",
                    codex_cli,
                    "npm install -g @openai/codex",
                    "安装后可运行 `codex login` 完成登录，或在 Backend Manager 中填写 OpenAI API Key。",
                ))
                return {"agentSessionId": new_agent_sid}

            probe_error = await self._ensure_cli_usable(codex_cli)
            if probe_error:
                emit("error", error=probe_error)
                return {"agentSessionId": new_agent_sid}

            approval_mode = "never" if skip else "on-request"
            sandbox_mode = "workspace-write" if sandbox_enabled else "danger-full-access"

            if not codex_resume_id:
                with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as f:
                    output_path = f.name

            image_paths: list[str] = []
            if images:
                image_tmpdir = tempfile.TemporaryDirectory(prefix="awu-codex-images-")
                for i, img in enumerate(images):
                    if img.file_path and os.path.exists(img.file_path):
                        image_paths.append(img.file_path)
                        continue
                    if img.base64:
                        ext = (img.mime_type or "image/png").split("/")[-1].replace("jpeg", "jpg")
                        path = Path(image_tmpdir.name) / f"image-{i}.{ext}"
                        path.write_bytes(base64.b64decode(img.base64))
                        image_paths.append(str(path))

            # A multiline prompt cannot safely cross a Windows npm `.cmd`
            # shim: cmd.exe may split it at a newline and Codex then sees only
            # the first line (for example, `<system_constraints>`). Always
            # carry prompts over stdin for batch shims; also do so for long
            # direct-executable commands to stay below Windows' command limit.
            is_batch_shim = (
                sys.platform == "win32"
                and Path(codex_cli).suffix.lower() in {".cmd", ".bat"}
            )
            stdin_mode = is_batch_shim or len(prompt) > 8000
            if stdin_mode:
                stdin_data = prompt.encode("utf-8")
                reason = "Windows npm shim" if is_batch_shim else "long prompt"
                print(f"[CodexOffice] {reason} ({len(prompt)} chars), using stdin",
                      file=sys.stderr, flush=True)

            cmd = self._build_cmd(
                codex_cli=codex_cli,
                prompt=prompt,
                model=model,
                approval_mode=approval_mode,
                sandbox_mode=sandbox_mode,
                agent_session_id=codex_resume_id,
                output_path=output_path,
                image_paths=image_paths,
                stdin_mode=stdin_mode,
            )

            print(f"[CodexOffice] exec: cwd={cwd!r}, resume={codex_resume_id!r}, "
                  f"native_resume={use_native_resume}, model={model!r}, "
                  f"approval={approval_mode!r}, sandbox={sandbox_mode!r}, "
                  f"{self._network_summary()}",
                  file=sys.stderr, flush=True)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                env=self._build_env(),
                # Match Claude official: do not attach stdin for normal
                # positional-prompt runs.  Some Codex CLI builds try to read
                # extra input whenever stdin is a non-TTY (even /dev/null),
                # which can trigger slow "Reading additional input from stdin"
                # and reconnect/timeout behavior.
                stdin=asyncio.subprocess.PIPE if stdin_data else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            if stdin_data:
                assert proc.stdin is not None
                proc.stdin.write(stdin_data)
                await proc.stdin.drain()
                proc.stdin.close()
                try:
                    await proc.stdin.wait_closed()
                except (AttributeError, BrokenPipeError, ConnectionResetError):
                    pass

            async def read_stderr():
                assert proc and proc.stderr
                async for raw in proc.stderr:
                    line = raw.decode("utf-8", errors="replace").rstrip()
                    if line:
                        print(f"[CodexOffice][stderr] {line}", file=sys.stderr, flush=True)

            stderr_task = asyncio.create_task(read_stderr())
            assert proc.stdout is not None
            async for raw in proc.stdout:
                if self.is_cancelled(session_id):
                    proc.terminate()
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    collected.append(line)
                    emit("text_delta", text=line + "\n")
                    continue
                sid = self._extract_session_id(obj)
                if sid and use_native_resume:
                    new_agent_sid = sid
                typ = str(obj.get("type") or obj.get("event") or "").lower()
                usage = obj.get("usage")
                if isinstance(usage, dict):
                    final_usage = {
                        "inputTokens": usage.get("input_tokens", 0),
                        "outputTokens": usage.get("output_tokens", 0),
                        "cachedInputTokens": usage.get("cached_input_tokens", 0),
                        "reasoningOutputTokens": usage.get("reasoning_output_tokens", 0),
                    }
                item = obj.get("item")
                item_type = str(item.get("type") or "").lower() if isinstance(item, dict) else ""
                if item_type == "agent_message":
                    txt = self._decode_text_payload(obj)
                    if txt:
                        collected.append(txt)
                        if "completed" in typ:
                            await emit_completed_text(txt)
                        else:
                            emit("text_delta", text=txt)
                elif item_type == "command_execution" and isinstance(item, dict):
                    tool = self._command_tool_payload(obj, item)
                    completed = tool.pop("completed")
                    tool_id = str(tool.get("id") or "")
                    if completed:
                        # Some Codex versions emit only item.completed. Create
                        # the card before resolving it so the UI never drops
                        # a fast command that had no separate started event.
                        if tool_id not in started_tool_ids:
                            emit("tool_start", tool_call={
                                "id": tool_id,
                                "name": tool["name"],
                                "input": tool["input"],
                                "status": "running",
                            })
                            started_tool_ids.add(tool_id)
                        emit("tool_result", tool_call=tool)
                    else:
                        tool.pop("output", None)
                        emit("tool_start", tool_call=tool)
                        started_tool_ids.add(tool_id)
                elif item_type == "tool_call" and isinstance(item, dict):
                    name = item.get("name") or item.get("tool") or "Codex tool"
                    tool_input = item.get("input") or item.get("arguments") or ""
                    if not isinstance(tool_input, str):
                        tool_input = json.dumps(tool_input, ensure_ascii=False)
                    emit("tool_start", tool_call={
                        "id": str(item.get("id") or obj.get("id") or ""),
                        "name": str(name),
                        "input": tool_input,
                        "status": "running",
                    })
                elif any(k in typ for k in ("delta", "assistant", "message")):
                    txt = self._decode_text_payload(obj)
                    if txt:
                        collected.append(txt)
                        emit("text_delta", text=txt)
                elif "error" in typ:
                    emit("error", error=self._decode_text_payload(obj) or json.dumps(obj, ensure_ascii=False))
                elif "tool" in typ or "command" in typ:
                    name = obj.get("name") or obj.get("tool") or obj.get("command") or "Codex tool"
                    emit("tool_start", tool_call={"id": str(obj.get("id") or ""), "name": str(name), "input": json.dumps(obj, ensure_ascii=False), "status": "running"})

            rc = await proc.wait()
            await stderr_task
            if rc != 0 and not self.is_cancelled(session_id):
                emit("error", error=f"Codex CLI exited with code {rc}")

            final_text = ""
            if output_path and os.path.exists(output_path):
                final_text = Path(output_path).read_text(encoding="utf-8", errors="replace").strip()
            if final_text and final_text not in "".join(collected):
                await emit_completed_text(final_text)

        except FileNotFoundError:
            emit("error", error=cli_missing_message(
                "Codex",
                resolve_codex_cli(self.config.cli_path),
                "npm install -g @openai/codex",
                "安装后可运行 `codex login` 完成登录，或在 Backend Manager 中填写 OpenAI API Key。",
            ))
        except Exception as e:
            emit("error", error=_exc_msg(e))
        finally:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            if output_path:
                try:
                    os.unlink(output_path)
                except OSError:
                    pass
            if image_tmpdir:
                image_tmpdir.cleanup()
            emit("done", **({"usage": final_usage} if final_usage else {}))
            self.clear_cancelled(session_id)

        return {"agentSessionId": new_agent_sid if use_native_resume else None}

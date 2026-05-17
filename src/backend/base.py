"""
Base classes for model backends.
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


def resolve_claude_cli(config_cli_path: Optional[str] = None) -> str:
    """Resolve the claude CLI path: config → bundled claude-env → system PATH.

    Windows note: never return a ``claude.exe`` path. ``claude-agent-sdk``
    runs the CLI via ``node <path>``; Node refuses to load a ``.exe`` as an
    ES module and crashes with ``ERR_UNKNOWN_FILE_EXTENSION``. Prefer the
    ``claude.cmd`` shim (which dispatches via Node itself) or the package's
    JS entry point (``cli.js`` / ``cli.cjs``).
    """
    if config_cli_path:
        return str(config_cli_path)
    if sys.platform == "win32":
        if getattr(sys, 'frozen', False):
            exe_dir = os.path.dirname(sys.executable)
        else:
            exe_dir = os.path.dirname(os.path.abspath(__file__))

        bases: list[str] = []
        seen: set[str] = set()
        for candidate in (
            exe_dir,
            os.path.join(exe_dir, ".."),
            os.path.join(exe_dir, "..", ".."),
            os.path.dirname(exe_dir),
            os.path.dirname(os.path.dirname(exe_dir)),
        ):
            ap = os.path.abspath(candidate)
            if ap not in seen:
                seen.add(ap)
                bases.append(ap)

        for base in bases:
            cmd_path = os.path.join(base, "claude-env", "claude.cmd")
            if os.path.exists(cmd_path):
                return cmd_path
            npm_cmd = os.path.join(base, "claude-env", "npm-global", "claude.cmd")
            if os.path.exists(npm_cmd):
                return npm_cmd
            pkg_root = os.path.join(
                base, "claude-env", "npm-global", "node_modules",
                "@anthropic-ai", "claude-code",
            )
            for entry in ("cli.js", "cli.cjs", "cli-wrapper.cjs"):
                cli_js = os.path.join(pkg_root, entry)
                if os.path.exists(cli_js):
                    return cli_js

        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("claude.cmd", "claude.ps1"):
                p = os.path.join(appdata, "npm", name)
                if os.path.exists(p):
                    return p
            for entry in ("cli.js", "cli.cjs"):
                p = os.path.join(
                    appdata, "npm", "node_modules",
                    "@anthropic-ai", "claude-code", entry,
                )
                if os.path.exists(p):
                    return p
    return "claude"


def apply_root_sandbox_env(env: dict) -> dict:
    """允许在 root/容器环境下使用 --dangerously-skip-permissions。

    Claude CLI 在以 root 身份运行时会拒绝 ``--dangerously-skip-permissions``
    （报错 "cannot be used with root/sudo privileges"），除非进程环境里设置了
    ``IS_SANDBOX``。本应用常运行于沙箱化的容器（root 用户），因此当检测到
    root 且调用方未显式设置 ``IS_SANDBOX`` 时，自动注入 ``IS_SANDBOX=1``。
    """
    try:
        is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    except Exception:
        is_root = False
    if is_root and not env.get("IS_SANDBOX"):
        env["IS_SANDBOX"] = "1"
    return env


_PROXY_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)
_original_proxy_env: Optional[dict] = None


def apply_proxy_env(enabled: bool, host: str = "", port: str = "") -> Optional[str]:
    """根据用户配置设置/清除进程级代理环境变量。

    启用时把代理 URL 写入 ``os.environ``——Claude CLI 子进程（继承 env）和
    httpx（``urllib.request.getproxies()`` 读 env）都会因此走代理。
    禁用时恢复进程启动时的原始代理变量。返回生效的代理 URL，禁用时返回 None。
    """
    global _original_proxy_env
    if _original_proxy_env is None:
        _original_proxy_env = {k: os.environ.get(k) for k in _PROXY_ENV_KEYS}

    host = (host or "").strip()
    port = str(port or "").strip()

    if enabled and host:
        if "://" in host:
            url = host
        else:
            url = "http://" + host
        # 仅当 host 自身未带端口时才补端口
        authority = url.split("://", 1)[1]
        if port and ":" not in authority:
            url = f"{url}:{port}"
        for k in _PROXY_ENV_KEYS:
            os.environ[k] = url
        return url

    for k in _PROXY_ENV_KEYS:
        orig = _original_proxy_env.get(k)
        if orig is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = orig
    return None


class StreamDelta:
    """
    A single streaming event pushed to the frontend.

    ★ delta_type 说明：
      text_delta           - 正文文本增量
      thinking             - 思考内容增量
      tool_start           - 工具调用开始（含名称、输入、可选 parentToolUseId）
      tool_input           - 工具输入增量（含 id / 可选 parentToolUseId）
      tool_result          - 工具执行结果（含 id / 输出 / 状态 / 可选 parentToolUseId）
      subagent_start       - Task 工具派发了一个子 agent（携带 subagent 字段）
      subagent_progress    - 子 agent 进度刷新
      subagent_done        - 子 agent 结束（completed / failed / stopped）
      done                 - 本轮流结束
      error                - 错误

    subagent 字段结构（与 claude_agent_sdk.types.Task*Message 对齐）：
      {
        taskId: str,
        description: str,
        taskType: str | None,
        parentToolUseId: str | None,  // 关联父级 Task tool_use.id
        status: "running" | "completed" | "failed" | "stopped",
        lastToolName: str | None,     // progress 时携带
        summary: str | None,          // done 时携带
        outputFile: str | None,       // done 时携带
        usage: { totalTokens, toolUses, durationMs } | None,
      }
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
        subagent: Optional[dict] = None,
    ):
        self.session_id = session_id
        self.message_id = message_id
        self.type = delta_type
        self.text = text
        self.tool_call = tool_call
        self.error = error
        self.usage = usage
        self.subagent = subagent

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
        if self.subagent is not None:
            d["subagent"] = self.subagent
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
        constraints: Optional[str] = None,  # ★ Session-level constraints/rules/prompts
        sandbox_enabled: bool = True,  # ★ 沙盒开关
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



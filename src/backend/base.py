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



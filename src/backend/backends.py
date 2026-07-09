"""
Backward-compatibility shim.

All implementation has been split into:
  base.py           — PermissionRequest, StreamDelta, ModelBackend ABC
  claude_agent.py   — ClaudeAgentBackend
  claude_code.py    — ClaudeCodeOfficialBackend
  openai_compat.py  — OpenAICompatibleBackend
  anthropic_api.py  — AnthropicAPIBackend
  dashscope_image.py— DashScopeImageBackend
  qwen_code_cli.py  — QwenCodeSdkBackend (uses qwen-code-sdk)
  codex_office.py   — CodexOfficeBackend
  factory.py        — create_backend()
"""

from .base import PermissionRequest, StreamDelta, ModelBackend, _exc_msg
from .claude_agent import ClaudeAgentBackend
from .claude_code import ClaudeCodeOfficialBackend
from .openai_compat import OpenAICompatibleBackend
from .anthropic_api import AnthropicAPIBackend
from .dashscope_image import DashScopeImageBackend
from .qwen_code_cli import QwenCodeSdkBackend
from .codex_office import CodexOfficeBackend
from .factory import create_backend

__all__ = [
    "PermissionRequest",
    "StreamDelta",
    "ModelBackend",
    "_exc_msg",
    "ClaudeAgentBackend",
    "ClaudeCodeOfficialBackend",
    "OpenAICompatibleBackend",
    "AnthropicAPIBackend",
    "DashScopeImageBackend",
    "QwenCodeSdkBackend",
    "CodexOfficeBackend",
    "create_backend",
]

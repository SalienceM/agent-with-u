"""
Shared type definitions and IPC protocol.
"""

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional
import json
import time
import uuid


class BackendType(str, Enum):
    CLAUDE_AGENT_SDK = "claude-agent-sdk"
    CLAUDE_CODE_OFFICIAL = "claude-code-official"   # 官方 Claude.ai 账户（ANTHROPIC_AUTH_TOKEN）
    OPENAI_COMPATIBLE = "openai-compatible"
    ANTHROPIC_API = "anthropic-api"


@dataclass
class ModelBackendConfig:
    id: str
    type: BackendType
    label: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    working_dir: Optional[str] = None
    allowed_tools: Optional[list[str]] = None
    skip_permissions: bool = True  # ★ If False, claude-code will ask for confirmation
    # ★ Per-backend environment variables for ANTHROPIC_* settings
    env: Optional[dict[str, str]] = None  # {ANTHROPIC_MODEL, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}
    cli_path: Optional[str] = None  # Override path to claude CLI binary
    extra_headers: Optional[dict[str, str]] = None  # Custom HTTP headers for proxy/relay backends
    mcp_servers: Optional[dict[str, dict]] = None  # MCP server configurations

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type.value,
            "label": self.label,
            "baseUrl": self.base_url,
            "model": self.model,
            "apiKey": self.api_key,
            "workingDir": self.working_dir,
            "allowedTools": self.allowed_tools,
            "skipPermissions": self.skip_permissions,
            "env": self.env,
            "cliPath": self.cli_path,
            "extraHeaders": self.extra_headers,
            "mcpServers": self.mcp_servers,
        }

    def get_env(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get environment variable from backend config."""
        if self.env:
            return self.env.get(key, default)
        return default


@dataclass
class ImageAttachment:
    id: str
    base64: str
    mime_type: str = "image/png"
    size: int = 0
    width: Optional[int] = None
    height: Optional[int] = None
    file_path: Optional[str] = None  # ★ 本地临时文件路径（落盘后填充）

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ToolCallInfo:
    name: str
    id: str = ""
    input: Optional[str] = None
    output: Optional[str] = None
    error: Optional[str] = None
    status: str = "running"
    # ★ Diff data for Edit/Write tools
    diff_path: Optional[str] = None
    diff_before: Optional[str] = None
    diff_after: Optional[str] = None
    # ★ Timing data for duration display
    start_time: Optional[float] = None  # Unix timestamp in seconds
    duration: Optional[int] = None  # Duration in milliseconds

    def to_dict(self) -> dict:
        d = {
            "name": self.name,
            "id": self.id,
            "status": self.status,
        }
        if self.input is not None:
            d["input"] = self.input
        if self.output is not None:
            d["output"] = self.output
        if self.error is not None:
            d["error"] = self.error
        if self.diff_path is not None:
            d["diff"] = {
                "path": self.diff_path,
                "old": self.diff_before or "",
                "new": self.diff_after or "",
            }
        if self.duration is not None:
            d["duration"] = self.duration
        return d


@dataclass
class ThinkingBlock:
    content: str

    def to_dict(self) -> dict:
        return {"content": self.content}


@dataclass
class ChatMessage:
    id: str
    role: str  # user | assistant | system
    content: str
    timestamp: float = field(default_factory=time.time)
    images: Optional[list[ImageAttachment]] = None
    backend_id: Optional[str] = None
    usage: Optional[dict] = None
    tool_calls: Optional[list[ToolCallInfo]] = None
    thinking_blocks: Optional[list[ThinkingBlock]] = None
    streaming: bool = False

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
            "streaming": self.streaming,
        }
        if self.images:
            d["images"] = [img.to_dict() for img in self.images]
        if self.backend_id:
            d["backendId"] = self.backend_id
        if self.usage:
            d["usage"] = self.usage
        if self.tool_calls:
            d["toolCalls"] = [tc.to_dict() for tc in self.tool_calls]
        if self.thinking_blocks:
            d["thinkingBlocks"] = [tb.to_dict() for tb in self.thinking_blocks]
        return d


@dataclass
class Session:
    id: str
    title: str
    created_at: float
    updated_at: float
    messages: list[ChatMessage]
    working_dir: str  # ★ Primary: Working directory is the identity of a session
    backend_id: str  # Backend config ID for this session
    agent_session_id: Optional[str] = None
    # Auto-continue on max_tokens
    auto_continue: bool = True
    # ★ Skip permission confirmation for sensitive tools (Bash/Edit/Write)
    skip_permissions: bool = True
    # Max continuation attempts
    max_continuations: int = 10
    # Track which backend config was used for each message
    backend_config_id: Optional[str] = None  # Alias for backend_id compatibility

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "messages": [m.to_dict() for m in self.messages],
            "workingDir": self.working_dir,  # ★ Prominent: directory is primary
            "backendId": self.backend_id,
            "agentSessionId": self.agent_session_id,
            "autoContinue": self.auto_continue,
            "skipPermissions": self.skip_permissions,
            "maxContinuations": self.max_continuations,
        }

    def meta_dict(self) -> dict:
        """For session list sidebar - directory is the primary identifier."""
        return {
            "id": self.id,
            "title": self.title,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "messageCount": len(self.messages),
            "workingDir": self.working_dir,  # ★ Show directory in sidebar
            "backendId": self.backend_id,
        }


def new_id() -> str:
    return str(uuid.uuid4())
"""
Shared type definitions and IPC protocol.
"""

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Any
import json
import time
import uuid


class BackendType(str, Enum):
    CLAUDE_AGENT_SDK = "claude-agent-sdk"
    CLAUDE_CODE_OFFICIAL = "claude-code-official"   # 官方 Claude.ai 账户（ANTHROPIC_AUTH_TOKEN）
    OPENAI_COMPATIBLE = "openai-compatible"
    ANTHROPIC_API = "anthropic-api"
    DASHSCOPE_IMAGE = "dashscope-image"             # DashScope 图像（Wan / Qwen Image 3.0）
    QWEN_CODE_CLI = "qwen-code-cli"                 # Qwen Code CLI（子进程 stream-json 模式）
    CODEX_OFFICIAL = "codex-office"                 # OpenAI Codex CLI（本地官方账户 / API key）


@dataclass
class ModelBackendConfig:
    id: str
    type: BackendType
    label: str
    enabled: bool = True
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
            "enabled": self.enabled,
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
class TextAttachment:
    id: str
    name: str
    content: str
    size: int = 0
    source: Optional[str] = None

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
    # ★ Subagent linkage: set when this tool is invoked inside a Task subagent.
    # 平铺存储 + parent_tool_use_id 反向引用，前端渲染时自行建树。
    parent_tool_use_id: Optional[str] = None
    # ★ Subagent metadata: only populated on the parent "Task" tool call.
    # Shape: { taskId, description, taskType, status, lastToolName, summary, outputFile, usage }
    subagent: Optional[dict] = None

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
        if self.parent_tool_use_id is not None:
            d["parentToolUseId"] = self.parent_tool_use_id
        if self.subagent is not None:
            d["subagent"] = self.subagent
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
    text_attachments: Optional[list[TextAttachment]] = None
    backend_id: Optional[str] = None
    usage: Optional[dict] = None
    tool_calls: Optional[list[ToolCallInfo]] = None
    thinking_blocks: Optional[list[ThinkingBlock]] = None
    streaming: bool = False
    # Follow-up delivery semantics.  Kept on the message (not the backend)
    # because it is part of the visible Session history.
    delivery_mode: Optional[str] = None  # steer | redirect

    def has_visible_payload(self) -> bool:
        """正文之外，思考、工具和附件也都属于可展示的有效回复。"""
        if isinstance(self.content, str) and self.content.strip():
            return True
        if any(
            isinstance(block.content, str) and block.content.strip()
            for block in (self.thinking_blocks or [])
        ):
            return True
        return bool(
            self.tool_calls
            or self.images
            or self.text_attachments
        )

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
        if self.text_attachments:
            d["textAttachments"] = [attachment.to_dict() for attachment in self.text_attachments]
        if self.backend_id:
            d["backendId"] = self.backend_id
        if self.usage:
            d["usage"] = self.usage
        if self.tool_calls:
            d["toolCalls"] = [tc.to_dict() for tc in self.tool_calls]
        if self.thinking_blocks:
            d["thinkingBlocks"] = [tb.to_dict() for tb in self.thinking_blocks]
        if self.delivery_mode in {"steer", "redirect"}:
            d["deliveryMode"] = self.delivery_mode
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
    # Stable visibility owner.  A Backend process may execute sessions for many
    # Relay users; ownership belongs to the Session, never to the process.
    # Legacy sessions without this field are deliberately local-only.
    owner_id: str = "local"
    # ★ 运行参数与 Backend 解耦。Backend 表示账号/连接/运行器；同一个 Codex
    #   Backend 可按会话选择不同模型与 reasoning effort。None 表示沿用 Backend/
    #   Codex 自身默认配置，非 Codex Backend 会安全忽略这两个字段。
    model_override: Optional[str] = None
    reasoning_effort: Optional[str] = None
    agent_session_id: Optional[str] = None
    # Codex transport: empty = regular local CLI, "node" = app-server on the
    # selected AgentWithU executor, "ssh" = app-server reached through SSH.
    codex_connection_mode: Optional[str] = None
    # Codex SSH Remote host alias from ~/.ssh/config (only for mode="ssh").
    codex_remote_host: Optional[str] = None
    # Whether this AgentWithU session originated by attaching an existing
    # native Codex thread. This is independent from the execution transport:
    # an SSH session may be both remote and attached.
    codex_thread_attached: bool = False
    # Native Codex mirror cursor. ``codex_sync_last_item_id`` points at the
    # newest user/agent item already reconciled from thread/read, while
    # ``codex_sync_local_count`` separates later AgentWithU-local bubbles that
    # still need to be matched against native items.  They make repeated syncs
    # incremental without changing the native Codex thread itself.
    codex_sync_last_item_id: Optional[str] = None
    codex_sync_local_count: int = 0
    # Auto-continue on max_tokens
    auto_continue: bool = True
    # ★ Skip permission confirmation for sensitive tools (Bash/Edit/Write)
    skip_permissions: bool = True
    # ★ 沙盒模式：限制文件操作在 working_dir 范围内。
    #   该功能支持不完善（易误报越界），前端开关已下线，默认关闭、不再强制；
    #   下方 Layer-2 校验代码保留但因本标志为 False 而不生效（便于将来恢复）。
    sandbox_enabled: bool = False
    # Max continuation attempts
    max_continuations: int = 10
    # Track which backend config was used for each message
    backend_config_id: Optional[str] = None  # Alias for backend_id compatibility
    # ★ Constraints/rules/prompts for this session -限定性提示词/规则/约束
    constraints: Optional[str] = None  # Special system prompts, rules, or constraints for this session
    # ★ Repo 能力绑定 — 替代 constraints 的新模式
    abilities: Optional[dict] = None  # {"skills": ["skill-name"], "prompts": ["prompt-name"]}
    # ★ 会话类型：普通会话 / 可视化 loop 会话（loop 状态另存于 loops/<id>.json）
    session_type: str = "normal"  # "normal" | "loop"
    # LOOP 当前所有权的轻量镜像。完整 stage 仍以 LoopState 为准；这个字段只用于
    # 首屏路由，让人工接管像普通 session 一样直接打开，不必先传完整 stage。
    loop_control_mode: Optional[str] = None  # None | "loop" | "manual"
    # 侧栏外观属于 Session 元数据，而非某个浏览器客户端的偏好。
    # sidebar_color 只保存受控预设 ID，前端负责映射成固定渐变，禁止任意 CSS。
    pinned: bool = False
    sidebar_color: str = ""
    # ★ 自动 AI commit + push：对话/Loop 结束时自动 stage-all → AI 生成 message → commit → push
    auto_commit: bool = False
    auto_commit_push: bool = False  # commit 后是否自动 push
    auto_commit_backend_id: Optional[str] = None  # AI commit 使用的后端（None = 跟随会话主模型）

    def to_dict(self, message_limit: int = 0) -> dict:
        """序列化 Session；message_limit>0 时只触碰最后 N 条消息。

        旧实现先把全部消息（含 base64 图片/工具输出）转成 dict，再由 RPC 切片，
        使“分页加载”仍是 O(全量)。这里在对象层先切片，首屏成本才真正与 N 成正比。
        """
        selected_messages = self.messages
        if message_limit and message_limit > 0:
            selected_messages = self.messages[-message_limit:]
        return {
            "id": self.id,
            "title": self.title,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "messages": [m.to_dict() for m in selected_messages],
            "workingDir": self.working_dir,  # ★ Prominent: directory is primary
            "backendId": self.backend_id,
            "ownerId": self.owner_id,
            "modelOverride": self.model_override,
            "reasoningEffort": self.reasoning_effort,
            "agentSessionId": self.agent_session_id,
            "codexConnectionMode": self.codex_connection_mode,
            "codexRemoteHost": self.codex_remote_host,
            "codexThreadAttached": self.codex_thread_attached,
            "codexSyncLastItemId": self.codex_sync_last_item_id,
            "codexSyncLocalCount": self.codex_sync_local_count,
            "autoContinue": self.auto_continue,
            "skipPermissions": self.skip_permissions,
            "sandboxEnabled": self.sandbox_enabled,
            "maxContinuations": self.max_continuations,
            "constraints": self.constraints,
            "abilities": self.abilities,
            "sessionType": self.session_type,
            "loopControlMode": self.loop_control_mode,
            "pinned": self.pinned,
            "sidebarColor": self.sidebar_color,
            "skipPermissions": self.skip_permissions,
            "autoContinue": self.auto_continue,
            "autoCommit": self.auto_commit,
            "autoCommitPush": self.auto_commit_push,
            "autoCommitBackendId": self.auto_commit_backend_id,
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
            "ownerId": self.owner_id,
            "modelOverride": self.model_override,
            "reasoningEffort": self.reasoning_effort,
            "codexConnectionMode": self.codex_connection_mode,
            "codexRemoteHost": self.codex_remote_host,
            "codexThreadAttached": self.codex_thread_attached,
            "agentSessionId": self.agent_session_id,
            "abilities": self.abilities,
            "sessionType": self.session_type,
            "loopControlMode": self.loop_control_mode,
            "pinned": self.pinned,
            "sidebarColor": self.sidebar_color,
            "autoCommit": self.auto_commit,
            "autoCommitPush": self.auto_commit_push,
            "autoCommitBackendId": self.auto_commit_backend_id,
        }


def new_id() -> str:
    return str(uuid.uuid4())

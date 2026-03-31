"""
Bridge: QObject exposed to React via QWebChannel.

Phase 2 Changes:
- Each Session can have its own backend config (backend_id is now per-session)
- InstanceManager manages 1:1 mapping between Sessions and Claude Code instances
- Cross-session support: migrate messages to new backend config
"""

import asyncio
import json
import sys
import time
from typing import Optional

from PySide6.QtCore import QObject, Signal, Slot
from PySide6.QtWidgets import QFileDialog

from ..types import (
    ModelBackendConfig,
    BackendType,
    ChatMessage,
    ImageAttachment,
    ToolCallInfo,
    ThinkingBlock,
    Session,
    new_id,
)
from .clipboard import ClipboardHandler
from .session_store import SessionStore
from .backends import create_backend, ModelBackend, StreamDelta
from .instance_manager import InstanceManager
from .backend_store import BackendStore
from .app_config_store import AppConfigStore

# 默认后端配置
DEFAULT_BACKENDS = [
    ModelBackendConfig(
        id="claude-agent-sdk-default",
        type=BackendType.CLAUDE_AGENT_SDK,
        label="Claude Code (Agent SDK)",
        model=None,  # ★ 从环境变量 ANTHROPIC_MODEL 读取，如果不设置则由 claude-code 自己决定
        allowed_tools=["Read", "Edit", "Bash", "Glob", "Grep", "Write"],
        skip_permissions=True,  # ★ 默认跳过确认，高性能模式
    ),
    ModelBackendConfig(
        id="claude-code-official-default",
        type=BackendType.CLAUDE_CODE_OFFICIAL,
        label="Claude Code (官方账户)",
        model=None,  # ★ 从 ANTHROPIC_MODEL 读取
        allowed_tools=["Read", "Edit", "Bash", "Glob", "Grep", "Write"],
        skip_permissions=True,
        # ★ 官方账户凭证自动从 ~/.claude/.credentials.json 读取（claude login 后生效）
        # ★ 如果网络需要代理，必须在 env 字段显式填入代理：
        #    {"HTTPS_PROXY": "http://127.0.0.1:7890", "HTTP_PROXY": "http://127.0.0.1:7890"}
        # ★ 系统代理自动检测在 Windows 下不可靠，必须显式配置
        env=None,  # 用户可在 UI 的"后端配置"里填入代理 env
    ),
]


def compress_messages(messages: list[ChatMessage], keep_recent: int = 6) -> str:
    """
    Compress early messages into a summary, keeping recent messages intact.

    Args:
        messages: List of chat messages
        keep_recent: Number of recent messages to keep verbatim

    Returns:
        A compressed context string that can be injected as system prompt
    """
    if len(messages) <= keep_recent:
        # No compression needed
        return "\n\n".join(
            f"[{m.role.upper()}]: {m.content}"
            for m in messages
        )

    # Compress early messages
    early_messages = messages[:-keep_recent]
    recent_messages = messages[-keep_recent:]

    # Build summary of early messages
    summary_parts = ["[早期对话摘要]"]

    # Group by conversation turns (user + assistant pairs)
    i = 0
    turn_count = 0
    while i < len(early_messages):
        turn_count += 1
        msg = early_messages[i]
        if msg.role == "user":
            # Summarize user message
            summary = msg.content[:200] + "..." if len(msg.content) > 200 else msg.content
            summary_parts.append(f"- 用户：{summary}")

            # Check if next message is assistant response
            if i + 1 < len(early_messages) and early_messages[i + 1].role == "assistant":
                asst = early_messages[i + 1]
                asst_summary = asst.content[:200] + "..." if len(asst.content) > 200 else asst.content
                summary_parts.append(f"- 助手：{asst_summary}")
                i += 2
            else:
                i += 1
        else:
            i += 1

    # Add recent messages verbatim
    recent_str = "\n\n".join(
        f"[{m.role.upper()}]: {m.content}"
        for m in recent_messages
    )

    return "\n\n".join([
        "以下是之前对话的摘要:",
        "\n".join(summary_parts),
        "\n\n最近对话:",
        recent_str,
    ])


class Bridge(QObject):
    """通过 QWebChannel 暴露给前端的 QObject 桥接层。"""

    # 信号 (Python → React)
    streamDelta = Signal(str)
    sessionUpdated = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._clipboard = ClipboardHandler()
        self._session_store = SessionStore()
        self._backend_store = BackendStore()  # ★ Persistent backend config storage
        self._app_config_store = AppConfigStore()  # ★ App-level config (theme, etc.)
        # ★ Per-session backend instances：每个 session 独占一个 backend 实例
        # 这样 abort(session_id) 只影响目标 session，不会误杀其他并发 session
        self._session_backends: dict[str, ModelBackend] = {}
        # Initialize backend configs from store, with defaults if empty
        stored_configs = self._backend_store.list()
        if stored_configs:
            self._backend_configs: list[ModelBackendConfig] = list(stored_configs)
        else:
            self._backend_configs: list[ModelBackendConfig] = list(DEFAULT_BACKENDS)
        self._active_sessions: dict[str, Session] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # ★ Phase 1: InstanceManager for 1:1 session-instance mapping
        self._instance_manager = InstanceManager()

    def set_event_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def _get_backend(self, session_id: str, config_id: str) -> ModelBackend:
        """获取（或创建）session 专属的 backend 实例。

        每个 session 持有独立的 backend 实例，这样：
        - abort(session_id) 只停该 session，不影响其他并发 session
        - 同一 backend config 可以同时服务多个 session（互不干扰）
        - session 切换 backend 时，旧实例自动替换
        """
        existing = self._session_backends.get(session_id)
        if existing and getattr(existing, '_config_id', None) == config_id:
            return existing
        config = next((c for c in self._backend_configs if c.id == config_id), None)
        if not config:
            raise ValueError(f"未找到后端配置: {config_id}")
        backend = create_backend(config)
        backend._config_id = config_id  # type: ignore[attr-defined]  # 便于切换时检测
        self._session_backends[session_id] = backend
        return backend

    def _emit_delta(self, delta: StreamDelta):
        payload = json.dumps(delta.to_dict(), ensure_ascii=False)
        print(f"[Bridge] streamDelta.emit: {payload[:150]}", file=sys.stderr, flush=True)
        self.streamDelta.emit(payload)

    # ── 剪贴板 ──

    @Slot(result=str)
    def readClipboardImage(self) -> str:
        img = self._clipboard.read_image()
        if img:
            return json.dumps(img.to_dict(), ensure_ascii=False)
        return "null"

    # ── 目录选择 ──

    @Slot(str, result=str)
    def selectDirectory(self, initial_path: str = "") -> str:
        """
        Open a system native directory picker dialog.

        Args:
            initial_path: Starting directory (optional)

        Returns:
            JSON string: { "path": string | null }
        """
        # Use main window as parent if available
        parent = None
        if hasattr(self, 'parent()') and self.parent():
            parent = self.parent()

        # Set initial directory
        directory = ""
        if initial_path and initial_path != ".":
            directory = initial_path

        # ★ Use native Windows dialog directly for better performance
        # QFileDialog can be slow due to Qt abstraction
        selected = QFileDialog.getExistingDirectory(
            parent,
            "Select Working Directory",
            directory,
            QFileDialog.ShowDirsOnly | QFileDialog.DontResolveSymlinks | QFileDialog.DontUseNativeDialog,
        )

        return json.dumps({"path": selected if selected else None}, ensure_ascii=False)

    # ── 聊天 ──

    @Slot(str)
    def sendMessage(self, payload_json: str):
        """发送消息。Payload: {sessionId, content, images?, backendId, messageId?, autoContinue?, skipPermissions?, workingDir?}"""
        payload = json.loads(payload_json)
        session_id = payload["sessionId"]
        content = payload["content"]
        backend_id = payload["backendId"]
        raw_images = payload.get("images")
        # ★ 读取前端传来的 autoContinue 偏好
        auto_continue = payload.get("autoContinue", True)
        # ★ 读取前端传来的 skipPermissions 偏好（运行时覆盖后端配置）
        skip_permissions = payload.get("skipPermissions", True)
        # ★ 读取工作目录（新建 Session 时可能需要）
        working_dir = payload.get("workingDir")

        images = None
        if raw_images:
            images = [ImageAttachment(**img) for img in raw_images]

        session = self._active_sessions.get(session_id)
        if not session:
            session = self._session_store.load(session_id)
            if not session:
                # ★ 新建 Session 时，working_dir 是必填的
                session = Session(
                    id=session_id,
                    title=content[:50] or "新会话",
                    created_at=time.time(),
                    updated_at=time.time(),
                    messages=[],
                    working_dir=working_dir or ".",  # ★ Default to current dir if not specified
                    backend_id=backend_id,
                )
            self._active_sessions[session_id] = session

        # ★ Phase 2: 支持每 Session 独立配置
        # 如果前端传入了新的 backendId，更新 Session 的配置
        if backend_id and backend_id != session.backend_id:
            print(f"[Bridge] Session {session_id} 切换模型：{session.backend_id} → {backend_id}",
                  file=sys.stderr, flush=True)
            session.backend_id = backend_id
            # 清除旧的 agent_session_id，因为新后端需要新的会话
            # 但保留历史消息，实现跨 Session 支持
            session.agent_session_id = None
            # ★ 清理旧 backend 实例，下次调用时会重新创建
            self._session_backends.pop(session_id, None)

        # ★ 同步前端偏好到 session
        session.auto_continue = auto_continue

        user_msg = ChatMessage(
            id=new_id(), role="user", content=content, images=images
        )
        session.messages.append(user_msg)

        assistant_id = payload.get("messageId") or new_id()
        assistant_msg = ChatMessage(
            id=assistant_id, role="assistant", content="",
            backend_id=backend_id, streaming=True,
        )
        session.messages.append(assistant_msg)

        if self._loop:
            asyncio.run_coroutine_threadsafe(
                self._async_send(
                    session, content, images, backend_id, assistant_id,
                    auto_continue=auto_continue,
                    skip_permissions=skip_permissions,
                    session_id=session_id,
                ),
                self._loop,
            )

    # ═══════════════════════════════════════
    #  ★ 核心：带自动续跑的流式发送
    # ═══════════════════════════════════════
    async def _async_send(
        self,
        session: Session,
        content: str,
        images: Optional[list[ImageAttachment]],
        backend_id: str,
        message_id: str,
        auto_continue: bool = True,
        skip_permissions: bool = True,
        session_id: Optional[str] = None,
    ):
        sid = session_id or session.id
        backend = self._get_backend(sid, backend_id)
        assistant_msg = session.messages[-1]

        max_continuations = session.max_continuations

        # ── 整体累积器 ──
        all_text: list[str] = []
        all_thinking: list[str] = []
        all_tool_calls: list[ToolCallInfo] = []
        total_input_tokens = 0
        total_output_tokens = 0

        current_content = content
        current_images = images
        success = True
        # ★ 防止无限重试
        retry_count = 0
        max_retry = 1  # 只重试一次

        for iteration in range(max_continuations + 1):
            # ── 本轮累积器 ──
            iter_text: list[str] = []
            iter_thinking: list[str] = []
            iter_tools: list[ToolCallInfo] = []
            iter_usage: Optional[dict] = None
            # ★ 使用列表来跟踪状态，因为闭包内需要修改
            retry_state = {"without_session": False}

            def on_delta(delta: StreamDelta):
                nonlocal iter_usage

                # ★ 拦截 done，不转发给前端（由我们在循环结束后手动发）
                if delta.type == "done":
                    if delta.usage:
                        iter_usage = delta.usage
                    return

                # ★ 检测 resume_failed 事件
                if delta.type == "resume_failed":
                    print(f"[Bridge] 收到 resume_failed 事件",
                          file=sys.stderr, flush=True)
                    # 标记需要重试
                    retry_state["without_session"] = True
                    return

                # ★ resume 失败后，压制 error delta（是 SDK 异常的误报，bridge 将重试）
                if retry_state["without_session"] and delta.type == "error":
                    print(f"[Bridge] 压制 resume 失败引发的 error delta（将重试）",
                          file=sys.stderr, flush=True)
                    return

                # 按类型累积
                if delta.type == "text_delta" and delta.text:
                    iter_text.append(delta.text)

                elif delta.type == "thinking" and delta.text:
                    iter_thinking.append(delta.text)

                elif delta.type == "tool_start" and delta.tool_call:
                    tc = ToolCallInfo(
                        id=delta.tool_call.get("id", ""),
                        name=delta.tool_call.get("name", "unknown"),
                        input=delta.tool_call.get("input"),
                        output=None,
                        status=delta.tool_call.get("status", "running"),
                    )
                    # ★ 去重：stream_event 和 AssistantMessage 都会触发 tool_start
                    # 只更新已有条目的 input，避免保存重复工具调用
                    existing = next((t for t in iter_tools if t.id and t.id == tc.id), None)
                    if existing:
                        if tc.input:
                            existing.input = tc.input
                    else:
                        iter_tools.append(tc)

                elif delta.type == "tool_input" and delta.tool_call:
                    input_delta = delta.tool_call.get("inputDelta", "")
                    if iter_tools and input_delta:
                        iter_tools[-1].input = (iter_tools[-1].input or "") + input_delta

                elif delta.type == "tool_result" and delta.tool_call:
                    tc_id = delta.tool_call.get("id", "")
                    matched = False
                    for tc in iter_tools:
                        if tc.id == tc_id:
                            tc.output = delta.tool_call.get("output")
                            tc.status = delta.tool_call.get("status", "done")
                            matched = True
                            break
                    # ★ Fallback：ID 匹配失败时，更新最后一个 running 的工具
                    if not matched:
                        for tc in reversed(iter_tools):
                            if tc.status == "running":
                                tc.output = delta.tool_call.get("output")
                                tc.status = delta.tool_call.get("status", "done")
                                break

                # 转发给前端（除了 done 以外的所有类型）
                self._emit_delta(delta)

            try:
                # ── 构建消息历史 ──
                # ★ 每次循环（包括重试）都重新检测是否需要压缩历史消息
                has_agent_session = bool(session.agent_session_id)
                need_compress = len(session.messages) > 10 and not has_agent_session

                # 确定要发送的内容
                send_content = current_content if iteration == 0 else current_content

                if iteration == 0:
                    if need_compress:
                        compressed = compress_messages(session.messages[:-1], keep_recent=6)
                        send_content = f"以下是之前对话的摘要，供你参考：\n\n{compressed}\n\n---\n\n请继续回答用户的问题：\n{current_content}"
                        print(f"[Bridge] 压缩历史消息并注入 prompt",
                              file=sys.stderr, flush=True)
                    msgs_for_backend = session.messages[:-1]
                else:
                    # 续跑或重试逻辑
                    if retry_state["without_session"]:
                        # ★ session 过期后重建：无论消息数量，始终把历史注入新 session
                        # 这样第三方 API（dashscope 等）也能保持多轮对话上下文
                        prior_msgs = session.messages[:-1]
                        if prior_msgs:
                            history_str = compress_messages(prior_msgs, keep_recent=6)
                            send_content = (
                                f"以下是之前对话的历史记录，请在此基础上继续：\n\n"
                                f"{history_str}\n\n"
                                f"---\n\n{current_content}"
                            )
                            print(f"[Bridge] Session 过期重建，注入 {len(prior_msgs)} 条历史消息",
                                  file=sys.stderr, flush=True)
                    msgs_for_backend = list(session.messages[:-1])
                    if all_text:
                        partial_assistant = ChatMessage(
                            id=new_id(), role="assistant",
                            content="".join(all_text),
                        )
                        msgs_for_backend.append(partial_assistant)
                    msgs_for_backend.append(ChatMessage(
                        id=new_id(), role="user",
                        content=current_content,
                    ))

                # ★ 如果有 agent_session_id，先尝试使用它
                use_agent_session = session.agent_session_id

                result = await backend.send_message(
                    messages=msgs_for_backend,
                    content=send_content,
                    images=current_images,
                    session_id=session.id,
                    message_id=message_id,
                    on_delta=on_delta,
                    agent_session_id=use_agent_session,
                    working_dir=session.working_dir,
                    skip_permissions=skip_permissions,
                )

                # ★ 检测 resume 是否失败（返回的 agentSessionId 与传入的不同，说明 session 无效）
                if use_agent_session and result.get("agentSessionId") != use_agent_session:
                    print(f"[Bridge] Resume 失败：原 session {use_agent_session} 已失效，回退到无 resume 模式",
                          file=sys.stderr, flush=True)
                    # 清除 agent_session_id，下次重试
                    session.agent_session_id = None
                    retry_state["without_session"] = True

                # ── 累积本轮结果 ──
                # ★ 如果 resume 失败，不要累积结果，等待重试
                if not retry_state["without_session"]:
                    all_text.extend(iter_text)
                    all_thinking.extend(iter_thinking)
                    all_tool_calls.extend(iter_tools)
                    if iter_usage:
                        total_input_tokens += iter_usage.get("inputTokens", 0)
                        total_output_tokens += iter_usage.get("outputTokens", 0)

                    if result.get("agentSessionId"):
                        session.agent_session_id = result["agentSessionId"]

                # ── 检查是否需要续跑或重试 ──
                stop_reason = result.get("stopReason", "end_turn")

                # ★ 如果 resume 失败，需要在下一轮重试（不带 resume，压缩历史消息）
                if retry_state["without_session"] and retry_count < max_retry:
                    retry_count += 1
                    # 清除 agent_session_id，确保下一轮不使用 resume
                    session.agent_session_id = None
                    # 继续下一轮循环
                    print(f"[Bridge] 准备重试 (iteration={iteration+1}, retry_count={retry_count})",
                          file=sys.stderr, flush=True)
                    continue
                elif retry_state["without_session"]:
                    # 已经超过最大重试次数，报告错误
                    print(f"[Bridge] Resume 失败且已达到最大重试次数",
                          file=sys.stderr, flush=True)
                    self._emit_delta(StreamDelta(
                        session.id, message_id, "error",
                        error="无法恢复之前的对话会话，已尝试使用压缩历史重试",
                    ))
                    success = False  # ★ 防止 error 后再发 done（避免前端 toolCalls 状态错误）

                if (
                    stop_reason == "max_tokens"
                    and auto_continue
                    and iteration < max_continuations
                ):
                    # 向前端发送续跑提示（作为 text_delta 追加到消息正文）
                    indicator = (
                        f"\n\n> ⟳ **Auto-continuing** "
                        f"({iteration + 2}/{max_continuations + 1})...\n\n"
                    )
                    self._emit_delta(StreamDelta(
                        session.id, message_id, "text_delta", text=indicator,
                    ))
                    all_text.append(indicator)

                    current_content = (
                        "Continue exactly from where you left off. "
                        "Do not repeat any content you already generated."
                    )
                    current_images = None
                    continue  # 进入下一轮
                else:
                    break  # 正常结束

            except Exception as e:
                # 出错时仍保留已累积的内容
                all_text.extend(iter_text)
                all_thinking.extend(iter_thinking)
                all_tool_calls.extend(iter_tools)

                self._emit_delta(StreamDelta(
                    session.id, message_id, "error", error=str(e),
                ))
                success = False
                break

        # ═══ 循环结束后：持久化 + 发 done ═══

        assistant_msg.content = "".join(all_text)
        assistant_msg.streaming = False

        if all_tool_calls:
            assistant_msg.tool_calls = all_tool_calls
        if all_thinking:
            assistant_msg.thinking_blocks = [
                ThinkingBlock(content="".join(all_thinking))
            ]

        final_usage = None
        if total_input_tokens or total_output_tokens:
            final_usage = {
                "inputTokens": total_input_tokens,
                "outputTokens": total_output_tokens,
            }
            assistant_msg.usage = final_usage

        # 只在成功时发 done（出错时已经发了 error）
        if success:
            self._emit_delta(StreamDelta(
                session.id, message_id, "done", usage=final_usage,
            ))

        session.updated_at = time.time()
        if session.title in ("新会话", "New session", "") and content:
            session.title = content[:50]

        # ★ Async save to avoid blocking the event loop
        self._session_store.save(session, async_=True)

    @Slot(str)
    def abortMessage(self, session_id: str):
        """停止指定 session 的流式响应。

        ★ 参数由 backend_id 改为 session_id：
        每个 session 独占 backend 实例，精确停止目标 session，
        不影响其他并发运行的 session（即使它们使用相同的 backend 配置）。
        """
        backend = self._session_backends.get(session_id)
        if backend:
            backend.abort()
            print(f"[Bridge] abortMessage: session={session_id}", file=sys.stderr, flush=True)

    # ═══════════════════════════════════════
    #  ★ 新增：后端命令执行
    # ═══════════════════════════════════════
    @Slot(str, result=str)
    def executeCommand(self, payload_json: str) -> str:
        """执行后端命令。Payload: {command, sessionId, backendId, args?}"""
        payload = json.loads(payload_json)
        command = payload.get("command", "")
        session_id = payload.get("sessionId", "")

        if command == "compact":
            session = self._active_sessions.get(session_id)
            if not session:
                return json.dumps({"status": "error", "message": "会话未找到"})
            if len(session.messages) <= 6:
                return json.dumps({"status": "skip", "message": "消息数量较少，无需压缩"})

            keep_count = 6
            removed = len(session.messages) - keep_count
            kept = session.messages[-keep_count:]
            note = ChatMessage(
                id=new_id(),
                role="assistant",
                content=f"[已压缩 {removed} 条早期消息以节省上下文窗口]",
                timestamp=time.time(),
            )
            session.messages = [note] + kept
            session.updated_at = time.time()
            # ★ Async save to avoid blocking UI
            self._session_store.save(session, async_=True)
            self.sessionUpdated.emit(json.dumps({
                "type": "session_compacted",
                "sessionId": session_id,
            }, ensure_ascii=False))
            return json.dumps({
                "status": "ok",
                "removed": removed,
                "remaining": len(session.messages),
            })

        elif command == "clear":
            session = self._active_sessions.get(session_id)
            if session:
                session.messages = []
                session.updated_at = time.time()
                # ★ Async save to avoid blocking UI
                self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"})

        elif command == "set_auto_continue":
            session = self._active_sessions.get(session_id)
            if session:
                session.auto_continue = payload.get("args", {}).get("enabled", True)
            return json.dumps({"status": "ok", "autoContinue": session.auto_continue if session else True})

        return json.dumps({"status": "error", "message": f"未知命令: {command}"})

    # ── 会话管理 ──

    @Slot(str, str, result=str)
    def createSession(self, working_dir: str, backend_id: str) -> str:
        """
        Create a new session.

        Args:
            working_dir: The working directory for this session (PRIMARY - defines session identity)
            backend_id: Backend config ID to use

        A session is fundamentally tied to a working directory - it represents
        "a Claude Code instance running in this directory".
        """
        # ★ Direct creation - no need to check storage first
        session = Session(
            id=new_id(),
            title="新会话",
            created_at=time.time(),
            updated_at=time.time(),
            messages=[],
            working_dir=working_dir,  # ★ Required: directory is the session identity
            backend_id=backend_id,
        )
        self._active_sessions[session.id] = session
        # ★ Async save to avoid blocking UI thread
        self._session_store.save(session, async_=True)
        return json.dumps(session.to_dict(), ensure_ascii=False)

    @Slot(result=str)
    def listSessions(self) -> str:
        return json.dumps(self._session_store.list(), ensure_ascii=False)

    @Slot(str, result=str)
    def loadSession(self, sid: str) -> str:
        session = self._active_sessions.get(sid)
        if not session:
            session = self._session_store.load(sid)
            if session:
                self._active_sessions[sid] = session
        if session:
            return json.dumps(session.to_dict(), ensure_ascii=False)
        return "null"

    @Slot(str, result=bool)
    def deleteSession(self, sid: str) -> bool:
        self._active_sessions.pop(sid, None)
        # ★ 清理 session 专属的 backend 实例
        self._session_backends.pop(sid, None)
        # ★ Phase 1: Clean up instance
        self._instance_manager.delete(sid)
        return self._session_store.delete(sid)

    # ═══════════════════════════════════════
    #  ★ Per-session theme overrides
    # ═══════════════════════════════════════
    @Slot(str, str, result=str)
    def updateSessionTheme(self, session_id: str, theme_overrides_json: str) -> str:
        """
        Update theme overrides for a session.

        Args:
            session_id: Session ID
            theme_overrides_json: JSON object with color overrides, e.g., {"accent": "#ff0000", "codeBg": "#16161e"}

        Returns:
            JSON string: {"status": "ok"|"error", "message"?: string}
        """
        try:
            theme_overrides = json.loads(theme_overrides_json)
            if not isinstance(theme_overrides, dict):
                return json.dumps({"status": "error", "message": "Theme overrides must be an object"}, ensure_ascii=False)

            session = self._active_sessions.get(session_id)
            if not session:
                session = self._session_store.load(session_id)
                if not session:
                    return json.dumps({"status": "error", "message": "Session not found"}, ensure_ascii=False)

            session.theme_overrides = theme_overrides
            self._active_sessions[session_id] = session
            self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    @Slot(str, str, result=str)
    def updateSessionConstraints(self, session_id: str, constraints_json: str) -> str:
        """
        Update constraints/rules/prompts for a session.

        Args:
            session_id: Session ID
            constraints_json: JSON string containing the constraints text

        Returns:
            JSON string: {"status": "ok"|"error", "message"?: string}
        """
        try:
            constraints = json.loads(constraints_json)
            # Accept string directly or object with constraints field
            if isinstance(constraints, str):
                constraints_text = constraints
            elif isinstance(constraints, dict):
                constraints_text = constraints.get("constraints", "")
            else:
                constraints_text = ""

            session = self._active_sessions.get(session_id)
            if not session:
                session = self._session_store.load(session_id)
                if not session:
                    return json.dumps({"status": "error", "message": "Session not found"}, ensure_ascii=False)

            session.constraints = constraints_text
            self._active_sessions[session_id] = session
            self._session_store.save(session, async_=True)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ═══════════════════════════════════════
    #  ★ Phase 3: 跨 Session 支持
    # ═══════════════════════════════════════
    @Slot(str, result=str)
    def migrateSession(self, payload_json: str) -> str:
        """
        Migrate a session to a different backend config.

        Payload: {sourceSessionId, targetBackendId}

        This creates a new session with the target backend,
        carrying over all message history.

        The key insight: when switching models mid-conversation,
        we preserve the full history and pass it to the new backend.
        The new backend will see all previous messages (from any model)
        and can continue the conversation seamlessly.

        ★ Migration strategy:
        - Do NOT copy agent_session_id - it's tied to the original CLI session
        - Instead, compress the message history and inject it as context
        - This ensures the new backend can continue without resume failures
        """
        payload = json.loads(payload_json)
        source_id = payload.get("sourceSessionId")
        target_backend_id = payload.get("targetBackendId")

        if not source_id or not target_backend_id:
            return json.dumps({"status": "error", "message": "Missing parameters"})

        source = self._active_sessions.get(source_id)
        if not source:
            source = self._session_store.load(source_id)
        if not source:
            return json.dumps({"status": "error", "message": "Source session not found"})

        # Validate target backend config exists
        target_config = next((c for c in self._backend_configs if c.id == target_backend_id), None)
        if not target_config:
            return json.dumps({"status": "error", "message": f"Target backend not found: {target_backend_id}"})

        # ★ Compress message history for the new session
        # This provides context without relying on a potentially invalid agent_session_id
        compressed_history = None
        if len(source.messages) > 10:
            compressed_history = compress_messages(source.messages, keep_recent=6)
            print(f"[Bridge] Session migrated with compressed history ({len(source.messages)} → ~6 messages)",
                  file=sys.stderr, flush=True)

        # Create new session with same history but new backend
        new_session = Session(
            id=new_id(),
            title=source.title,
            created_at=time.time(),
            updated_at=time.time(),
            messages=list(source.messages),  # Copy all messages
            backend_id=target_backend_id,
            working_dir=source.working_dir,
            auto_continue=source.auto_continue,
            max_continuations=source.max_continuations,
            # ★ Do NOT copy agent_session_id - it's tied to the original CLI session
            # and will likely be invalid for the new backend
            agent_session_id=None,
        )

        self._active_sessions[new_session.id] = new_session
        # ★ Async save to avoid blocking UI
        self._session_store.save(new_session, async_=True)

        return json.dumps({
            "status": "ok",
            "newSessionId": new_session.id,
            "messageCount": len(new_session.messages),
            "compressedHistory": compressed_history is not None,
        }, ensure_ascii=False)

    # ── 后端配置管理 ──

    @Slot(result=str)
    def getBackends(self) -> str:
        return json.dumps(
            [c.to_dict() for c in self._backend_configs],
            ensure_ascii=False,
        )

    @Slot(str)
    def saveBackend(self, config_json: str):
        data = json.loads(config_json)
        config = ModelBackendConfig(
            id=data["id"],
            type=BackendType(data["type"]),
            label=data["label"],
            base_url=data.get("baseUrl"),
            model=data.get("model"),
            api_key=data.get("apiKey"),
            working_dir=data.get("workingDir"),
            allowed_tools=data.get("allowedTools"),
            skip_permissions=data.get("skipPermissions", True),
            env=data.get("env"),  # ★ Per-backend environment variables
            extra_headers=data.get("extraHeaders"),  # ★ Custom HTTP headers for proxy backends
        )
        # Save to persistent storage
        self._backend_store.save(config)
        # Update in-memory cache
        idx = next((i for i, c in enumerate(self._backend_configs) if c.id == config.id), -1)
        if idx >= 0:
            self._backend_configs[idx] = config
        else:
            self._backend_configs.append(config)
        # ★ 清理所有使用该 config 的 session backend 实例（配置已更新，旧实例作废）
        stale = [
            sid for sid, b in self._session_backends.items()
            if getattr(b, '_config_id', None) == config.id
        ]
        for sid in stale:
            self._session_backends.pop(sid, None)

    @Slot(str)
    def deleteBackend(self, config_id: str):
        # Delete from persistent storage
        self._backend_store.delete(config_id)
        # Update in-memory cache
        self._backend_configs = [c for c in self._backend_configs if c.id != config_id]
        stale_del = [
            sid for sid, b in self._session_backends.items()
            if getattr(b, '_config_id', None) == config_id
        ]
        for sid in stale_del:
            self._session_backends.pop(sid, None)

    # ═══════════════════════════════════════
    #  ★ 数据导入导出
    # ═══════════════════════════════════════

    @Slot(result=str)
    def selectExportPath(self) -> str:
        """Open file save dialog for export."""
        parent = None
        if hasattr(self, 'parent()') and self.parent():
            parent = self.parent()

        file_path, _ = QFileDialog.getSaveFileName(
            parent,
            "导出数据",
            "",
            "Tar 归档文件 (*.tar.gz);;所有文件 (*)",
        )
        return json.dumps({"path": file_path if file_path else None}, ensure_ascii=False)

    @Slot(result=str)
    def selectImportPath(self) -> str:
        """Open file open dialog for import."""
        parent = None
        if hasattr(self, 'parent()') and self.parent():
            parent = self.parent()

        file_path, _ = QFileDialog.getOpenFileName(
            parent,
            "导入数据",
            "",
            "Tar 归档文件 (*.tar.gz);;所有文件 (*)",
        )
        return json.dumps({"path": file_path if file_path else None}, ensure_ascii=False)

    @Slot(str, result=str)
    def exportData(self, target_path: str) -> str:
        """
        Export all sessions and backend configs to a tar file.

        Args:
            target_path: Path to save the tar file

        Returns:
            JSON string: { "status": "ok" | "error", "message": string }
        """
        try:
            import tarfile
            import tempfile
            from pathlib import Path

            with tempfile.TemporaryDirectory() as tmpdir:
                tmppath = Path(tmpdir)

                # Export sessions to temp file
                sessions_tar = tmppath / "sessions.tar.gz"
                sessions_success = self._session_store.export_all(str(sessions_tar))

                # Export backend configs to temp file
                backends_json = tmppath / "backends.json"
                backends_success = self._backend_store.export_config(str(backends_json))

                if not sessions_success:
                    return json.dumps({"status": "error", "message": "导出会话失败"}, ensure_ascii=False)

                # Create final tar file
                with tarfile.open(target_path, "w:gz") as tar:
                    # Add sessions archive
                    tar.add(sessions_tar, arcname="sessions.tar.gz")
                    # Add backends config
                    tar.add(backends_json, arcname="backends.json")

                return json.dumps({"status": "ok", "message": "导出成功"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    @Slot(str, result=str)
    def importData(self, source_path: str) -> str:
        """
        Import sessions and backend configs from a tar file.
        This will OVERWRITE existing data.

        Args:
            source_path: Path to the tar file to import

        Returns:
            JSON string: { "status": "ok" | "error", "message": string, "sessions"?: number, "backends"?: number }
        """
        try:
            import tarfile
            import tempfile
            from pathlib import Path

            with tempfile.TemporaryDirectory() as tmpdir:
                tmppath = Path(tmpdir)

                # Extract archive
                with tarfile.open(source_path, "r:gz") as tar:
                    tar.extractall(tmpdir)

                # Import sessions
                sessions_tar = tmppath / "sessions.tar.gz"
                sessions_count = 0
                if sessions_tar.exists():
                    # Count sessions before import
                    before_count = len(self._session_store.list())
                    if self._session_store.import_all(str(sessions_tar)):
                        after_count = len(self._session_store.list())
                        sessions_count = after_count - before_count

                # Import backend configs
                backends_json = tmppath / "backends.json"
                backends_count = 0
                if backends_json.exists():
                    before_count = len(self._backend_store.list())
                    if self._backend_store.import_config(str(backends_json)):
                        after_count = len(self._backend_store.list())
                        backends_count = after_count - before_count

                    # Update in-memory backend configs in Bridge
                    stored_configs = self._backend_store.list()
                    if stored_configs:
                        self._backend_configs = list(stored_configs)

                return json.dumps({
                    "status": "ok",
                    "message": "导入成功",
                    "sessions": sessions_count,
                    "backends": backends_count,
                }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

    # ═══════════════════════════════════════
    #  ★ 应用配置（主题等）
    # ═══════════════════════════════════════

    @Slot(result=str)
    def getAppConfig(self) -> str:
        """Get application config (theme, preferences, etc.)."""
        config = self._app_config_store.get_all()
        return json.dumps(config, ensure_ascii=False)

    @Slot(str, result=str)
    def setAppConfig(self, config_json: str) -> str:
        """Set application config (theme, preferences, etc.)."""
        try:
            config = json.loads(config_json)
            self._app_config_store.set_all(config)
            return json.dumps({"status": "ok"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)
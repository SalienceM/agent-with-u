"""
ClaudeCodeInstanceManager: Manages 1:1 mapping between Sessions and Claude Code CLI instances.

Key concepts:
- Each Session has its own claude CLI instance (subprocess)
- Instances are lazily started on first sendMessage
- Instances are cached to maintain conversation continuity via --resume
- Each instance can have its own backend config (model, API key, etc.)

Architecture:
┌─────────────────────────────────────────────────────────┐
│  InstanceManager                                         │
│  - instances: dict[session_id, ClaudeCodeInstance]      │
│  - configs: dict[config_id, ModelBackendConfig]         │
└─────────────────────────────────────────────────────────┘
              ↕ manages
┌─────────────────────────────────────────────────────────┐
│  ClaudeCodeInstance (per Session)                       │
│  - session_id, config_id, agent_session_id              │
│  - process: subprocess.Popen (lazy started)             │
│  - message_queue: asyncio.Queue (for stream events)     │
└─────────────────────────────────────────────────────────┘
"""

import asyncio
import json
import subprocess
import sys
from typing import Optional, Callable

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment


class ClaudeCodeInstance:
    """
    Represents a single Claude Code CLI instance bound to one Session.

    Lifecycle:
    - Created when Session sends first message
    - Process lazily started on demand
    - Reused for subsequent messages via --resume
    - Terminated when Session is deleted or config changes
    """

    def __init__(
        self,
        session_id: str,
        config: ModelBackendConfig,
        agent_session_id: Optional[str] = None,
    ):
        self.session_id = session_id
        self.config = config
        self.agent_session_id = agent_session_id
        self.process: Optional[subprocess.Popen] = None
        self._cancelled = False

    def _get_cli_path(self) -> str:
        """Get claude CLI path from config or default locations."""
        cli = getattr(self.config, "cli_path", None)
        if cli:
            return str(cli)

        if sys.platform == "win32":
            appdata = subprocess.os.environ.get("APPDATA", "")
            for name in ("claude.cmd", "claude.exe", "claude"):
                p = subprocess.os.path.join(appdata, "npm", name)
                if subprocess.os.path.exists(p):
                    return p
        return "claude"

    def _build_command(self, content: str) -> list[str]:
        """Build claude CLI command with current config."""
        cmd = [self._get_cli_path()]

        # Model
        model = subprocess.os.environ.get("ANTHROPIC_MODEL") or self.config.model
        if model and model not in ("sonnet", "claude-sonnet", "default"):
            cmd.extend(["--model", model])

        # Resume previous session
        if self.agent_session_id:
            cmd.extend(["--resume", self.agent_session_id])

        # Working directory
        cwd = getattr(self.config, "working_dir", None) or "."

        # Allowed tools
        tools = getattr(self.config, "allowed_tools", None) or [
            "Read", "Edit", "Bash", "Glob", "Grep", "Write"
        ]
        for tool in tools:
            cmd.extend(["--allowedTools", tool])

        # Output format and permissions
        cmd.extend([
            "--output-format", "stream-json",
            "--verbose",
        ])

        # ★ Check skip_permissions from config
        skip_permissions = getattr(self.config, "skip_permissions", True)
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")

        # Prompt
        cmd.extend(["-p", content])

        return cmd

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        message_id: str,
        on_delta: Callable,
    ) -> dict:
        """
        Send a message to this Claude Code instance.

        Args:
            messages: Full conversation history (for context)
            content: New user message content
            images: Optional image attachments
            message_id: Current assistant message ID
            on_delta: Callback for stream deltas

        Returns:
            dict with agent_session_id and other metadata
        """
        self._cancelled = False

        def emit(delta_type: str, **kwargs):
            if not self._cancelled:
                on_delta(delta_type, **kwargs)

        cmd = self._build_command(content)
        cwd = getattr(self.config, "working_dir", None) or "."

        print(f"[Instance] Session={self.session_id}, agent_session_id={self.agent_session_id!r}",
              file=sys.stderr, flush=True)
        print(f"[Instance] cmd: {' '.join(cmd[:8])}...",
              file=sys.stderr, flush=True)

        loop = asyncio.get_event_loop()
        msg_queue: asyncio.Queue = asyncio.Queue()
        proc_holder: list[Optional[subprocess.Popen]] = [None]

        def _run_subprocess():
            try:
                print(f"[Instance] Starting subprocess for session {self.session_id}...",
                      file=sys.stderr, flush=True)
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=cwd,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
                proc_holder[0] = proc
                print(f"[Instance] Subprocess started, pid={proc.pid}",
                      file=sys.stderr, flush=True)

                has_output = False
                line_count = 0

                while True:
                    raw_line = proc.stdout.readline()
                    if not raw_line:
                        break
                    line = raw_line.strip()
                    if not line:
                        continue
                    has_output = True
                    line_count += 1
                    print(f"[Instance] Line {line_count}: {line[:120]}",
                          file=sys.stderr, flush=True)
                    try:
                        obj = json.loads(line)
                        loop.call_soon_threadsafe(msg_queue.put_nowait, ("json", obj))
                    except json.JSONDecodeError:
                        loop.call_soon_threadsafe(msg_queue.put_nowait, ("text", line))

                proc.wait()
                print(f"[Instance] Subprocess ended, rc={proc.returncode}, lines={line_count}",
                      file=sys.stderr, flush=True)

                stderr_out = proc.stderr.read().strip()
                if stderr_out:
                    print(f"[Instance] stderr: {stderr_out[:500]}",
                          file=sys.stderr, flush=True)

                if not has_output:
                    loop.call_soon_threadsafe(msg_queue.put_nowait, ("fallback", None))
                else:
                    loop.call_soon_threadsafe(msg_queue.put_nowait, ("done", None))

            except Exception as e:
                print(f"[Instance] Subprocess error: {e}",
                      file=sys.stderr, flush=True)
                loop.call_soon_threadsafe(msg_queue.put_nowait, ("error", str(e)))

        # Start subprocess in background
        await loop.run_in_executor(None, _run_subprocess)

        # Main loop: read queue and emit deltas
        POLL_INTERVAL = 10
        MAX_TOTAL_WAIT = 7200
        total_waited = 0

        while True:
            if self._cancelled:
                proc = proc_holder[0]
                if proc and proc.poll() is None:
                    proc.terminate()
                break

            try:
                tag, payload = await asyncio.wait_for(msg_queue.get(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                total_waited += POLL_INTERVAL
                proc = proc_holder[0]

                if proc and proc.poll() is None:
                    if total_waited % 60 == 0:
                        print(f"[Instance] Waiting... {total_waited}s, pid={proc.pid}",
                              file=sys.stderr, flush=True)
                    if total_waited < MAX_TOTAL_WAIT:
                        continue
                    else:
                        emit("error", error=f"Timeout after {MAX_TOTAL_WAIT//3600}h")
                        proc.terminate()
                        break

                if proc is None:
                    if total_waited < 60:
                        continue
                    emit("error", error="Subprocess startup timeout")
                    break

                print(f"[Instance] Subprocess ended but no signal (rc={proc.returncode})",
                      file=sys.stderr, flush=True)
                break

            if tag == "done":
                break
            elif tag == "error":
                emit("error", error=str(payload))
                break
            elif tag == "fallback":
                print("[Instance] Fallback to json mode",
                      file=sys.stderr, flush=True)
                # TODO: Implement fallback
                break
            elif tag == "text":
                total_waited = 0
                emit("text_delta", text=payload + "\n")
            elif tag == "json":
                total_waited = 0
                events = self._process_json(payload)
                for evt_type, evt_kwargs in events:
                    if self._cancelled:
                        break
                    emit(evt_type, **evt_kwargs)

        emit("done")
        return {"agent_session_id": self.agent_session_id}

    def _process_json(self, obj: dict) -> list[tuple[str, dict]]:
        """Process stream-json line, return list of (delta_type, kwargs)."""
        events = []
        msg_type = obj.get("type", "")

        if msg_type == "system" and obj.get("subtype") == "init":
            self.agent_session_id = obj.get("session_id", self.agent_session_id)
            print(f"[Instance] Session init: {self.agent_session_id}",
                  file=sys.stderr, flush=True)

        elif msg_type == "assistant":
            message = obj.get("message", {})
            for block in message.get("content", []):
                btype = block.get("type", "")
                if btype == "text":
                    text = block.get("text", "")
                    if text:
                        events.append(("text_delta", {"text": text}))
                elif btype == "thinking":
                    thinking = block.get("thinking", "")
                    if thinking:
                        events.append(("thinking", {"text": thinking}))
                elif btype == "tool_use":
                    events.append(("tool_start", {"tool_call": {
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "input": json.dumps(block.get("input", {}), ensure_ascii=False),
                        "status": "running",
                    }}))

        elif msg_type == "tool":
            for block in obj.get("content", []):
                if block.get("type") == "tool_result":
                    content = block.get("content", "")
                    if isinstance(content, list):
                        content = "\n".join(str(p) for p in content)
                    events.append(("tool_result", {"tool_call": {
                        "id": block.get("tool_use_id", ""),
                        "output": str(content)[:5000],
                        "status": "error" if block.get("is_error") else "done",
                    }}))

        elif msg_type == "content_block_delta":
            delta = obj.get("delta", {})
            if delta.get("type") == "text_delta":
                events.append(("text_delta", {"text": delta.get("text", "")}))
            elif delta.get("type") == "thinking_delta":
                events.append(("thinking", {"text": delta.get("thinking", "")}))
            elif delta.get("type") == "input_json_delta":
                events.append(("tool_input", {"tool_call": {
                    "inputDelta": delta.get("partial_json", ""),
                }}))

        elif msg_type == "content_block_start":
            block = obj.get("content_block", {})
            if block.get("type") == "tool_use":
                events.append(("tool_start", {"tool_call": {
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": "",
                    "status": "running",
                }}))

        elif msg_type == "result":
            self.agent_session_id = obj.get("session_id", self.agent_session_id)
            usage = obj.get("usage", {})
            if usage:
                events.append(("done", {"usage": {
                    "inputTokens": usage.get("input_tokens"),
                    "outputTokens": usage.get("output_tokens"),
                }}))

        return events

    def cancel(self):
        """Cancel current message processing."""
        self._cancelled = True

    def terminate(self):
        """Terminate the subprocess if running."""
        if self.process and self.process.poll() is None:
            self.process.terminate()


class InstanceManager:
    """
    Manages ClaudeCodeInstance objects for all active Sessions.

    - Lazy instance creation
    - Config-based instance recycling
    - Cleanup on Session delete
    """

    def __init__(self):
        self.instances: dict[str, ClaudeCodeInstance] = {}
        self.configs: dict[str, ModelBackendConfig] = {}

    def get_or_create(
        self,
        session_id: str,
        config: ModelBackendConfig,
        agent_session_id: Optional[str] = None,
    ) -> ClaudeCodeInstance:
        """
        Get existing instance or create new one.

        If config changed, recycle the instance.
        """
        instance = self.instances.get(session_id)

        if instance:
            # Check if config changed
            if instance.config.id != config.id:
                print(f"[InstanceManager] Config changed for session {session_id}, recycling instance",
                      file=sys.stderr, flush=True)
                instance.terminate()
                del self.instances[session_id]
                instance = None

        if not instance:
            instance = ClaudeCodeInstance(
                session_id=session_id,
                config=config,
                agent_session_id=agent_session_id,
            )
            self.instances[session_id] = instance

        return instance

    def get(self, session_id: str) -> Optional[ClaudeCodeInstance]:
        """Get instance without creating."""
        return self.instances.get(session_id)

    def delete(self, session_id: str):
        """Delete instance and terminate subprocess."""
        instance = self.instances.pop(session_id, None)
        if instance:
            instance.terminate()

    def clear(self):
        """Delete all instances."""
        for instance in self.instances.values():
            instance.terminate()
        self.instances.clear()

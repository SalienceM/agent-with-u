"""CodexOfficeBackend — runs OpenAI Codex CLI in non-interactive exec mode."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional, Callable, Awaitable

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg


def resolve_codex_cli(config_cli_path: Optional[str] = None) -> str:
    """Resolve the Codex CLI executable."""
    if config_cli_path:
        return str(config_cli_path)
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("codex.cmd", "codex.exe", "codex.ps1"):
                p = os.path.join(appdata, "npm", name)
                if os.path.exists(p):
                    return p
    return shutil.which("codex") or "codex"


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
        if self.config.api_key:
            env.setdefault("OPENAI_API_KEY", self.config.api_key)
        if self.config.base_url:
            env.setdefault("OPENAI_BASE_URL", self.config.base_url)
        env.setdefault("NO_COLOR", "1")
        return env

    def _build_prompt(self, messages: list[ChatMessage], content: str, constraints: Optional[str]) -> str:
        parts: list[str] = []
        if constraints:
            parts.append(f"以下是你必须遵守的规则和约束：\n\n{constraints}")
        if messages:
            history = []
            for m in messages[-12:]:
                if m.content:
                    history.append(f"[{m.role.upper()}]\n{m.content}")
            if history:
                parts.append("以下是当前会话的最近上下文：\n\n" + "\n\n".join(history))
        parts.append(content)
        return "\n\n---\n\n".join(parts)

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
        return ""

    @staticmethod
    def _extract_session_id(obj: dict) -> Optional[str]:
        for key in ("session_id", "sessionId", "conversation_id", "conversationId", "id"):
            val = obj.get(key)
            if isinstance(val, str) and val:
                # Avoid treating every event id/tool id as the resumable session id.
                typ = str(obj.get("type") or obj.get("event") or "").lower()
                if key == "id" and typ not in {"session", "session_created", "exec_session"}:
                    continue
                return val
        return None

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

        cwd = working_dir or self.config.working_dir or "."
        prompt = self._build_prompt(messages, content, constraints)
        model = self.config.model or self.get_env("OPENAI_MODEL") or ""
        skip = self.config.skip_permissions if skip_permissions is None else bool(skip_permissions)

        output_path = None
        image_tmpdir = None
        proc: Optional[asyncio.subprocess.Process] = None
        collected: list[str] = []
        new_agent_sid = agent_session_id

        try:
            with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as f:
                output_path = f.name

            cmd = [resolve_codex_cli(self.config.cli_path)]
            if agent_session_id:
                cmd.extend(["exec", "resume", agent_session_id])
            else:
                cmd.extend(["exec"])
            cmd.extend(["--json", "--color", "never", "--cd", cwd, "--skip-git-repo-check"])
            cmd.extend(["--output-last-message", output_path])
            cmd.extend(["--ask-for-approval", "never" if skip else "on-request"])
            cmd.extend(["--sandbox", "workspace-write" if sandbox_enabled else "danger-full-access"])
            if model:
                cmd.extend(["--model", model])

            if images:
                image_tmpdir = tempfile.TemporaryDirectory(prefix="awu-codex-images-")
                image_paths = []
                for i, img in enumerate(images):
                    if img.file_path and os.path.exists(img.file_path):
                        image_paths.append(img.file_path)
                        continue
                    if img.base64:
                        ext = (img.mime_type or "image/png").split("/")[-1].replace("jpeg", "jpg")
                        path = Path(image_tmpdir.name) / f"image-{i}.{ext}"
                        path.write_bytes(base64.b64decode(img.base64))
                        image_paths.append(str(path))
                for path in image_paths:
                    cmd.extend(["--image", path])

            # Prompt last; '-' lets us avoid command-line length/quoting issues.
            cmd.append("-")

            print(f"[CodexOffice] exec: cwd={cwd!r}, resume={agent_session_id!r}, model={model!r}",
                  file=sys.stderr, flush=True)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                env=self._build_env(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

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
                if sid:
                    new_agent_sid = sid
                typ = str(obj.get("type") or obj.get("event") or "").lower()
                if any(k in typ for k in ("delta", "assistant", "message")):
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
                emit("text_delta", text=final_text)

        except FileNotFoundError:
            emit("error", error="Codex CLI 未找到。请安装 Codex CLI，或在 Backend Manager 中配置 codex 可执行文件路径。")
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
            emit("done")
            self.clear_cancelled(session_id)

        return {"agentSessionId": new_agent_sid}

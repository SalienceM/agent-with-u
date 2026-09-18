"""Isolated document/image Q&A with text output, never an agent's chat runner.

API backends receive no tools. CLI backends get a disposable home/workspace,
authentication-only copies and native tool restrictions, not just a prompt saying
"don't use tools". Codex may declare an inert skills discovery namespace; its
catalog is checked empty before inference and any tool event fails the job.
Normal chat permissions and persisted threads are untouched.
"""
from __future__ import annotations

import json
import base64
import io
import os
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from .base import ModelBackend, StreamDelta
from ..types import ImageAttachment

TEXT_ONLY_BACKENDS = {
    "openai-compatible", "anthropic-api", "codex-office", "qwen-code-cli",
    "claude-agent-sdk", "claude-code-official",
}


def _reference_images(images: list[ImageAttachment] | None) -> list[ImageAttachment]:
    """只接收本轮上传的图片字节，不允许文档/客户端借 file_path 读取执行端文件。"""
    if len(images or []) > 8:
        raise ValueError('手册答疑一次最多附带 8 张图片；未调用模型。')
    from PIL import Image
    formats = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP', 'image/gif': 'GIF'}
    total = 0
    for image in images or []:
        if image.mime_type not in formats or not image.base64:
            raise ValueError('请上传 PNG/JPEG/WebP/GIF 图片；手册答疑不读取执行端文件路径。')
        if len(image.base64) > 23_000_000:
            raise ValueError('本轮图片合计不能超过 16 MiB；未调用模型。')
        try:
            data = base64.b64decode(image.base64, validate=True)
            total += len(data)
            if total > 16 * 1024 * 1024:
                raise ValueError()
            with Image.open(io.BytesIO(data)) as picture:
                if picture.format != formats[image.mime_type] or picture.width * picture.height > 20_000_000:
                    raise ValueError()
                picture.verify()
        except Exception:
            raise ValueError('图片无效或过大（合计 16 MiB、单张 2000 万像素以内）；未调用模型。') from None
    # 丢掉可选路径，防止某个 Backend 绕过已经核验的上传字节。
    return [ImageAttachment(id=image.id, mime_type=image.mime_type, base64=image.base64) for image in images or []]


def _copy_auth(source: Path, target: Path) -> None:
    if source.is_file():
        # 只复用 access token，不在临时 HOME 中轮换主账号的 refresh token；
        # 否则临时目录删除时会丢掉新 refresh token，反而破坏正常聊天的登录。
        data = json.loads(source.read_text(encoding="utf-8-sig"))
        def without_refresh(value: Any) -> Any:
            if isinstance(value, dict):
                return {key: "" if key.replace("_", "").lower() == "refreshtoken" else without_refresh(item)
                        for key, item in value.items()}
            if isinstance(value, list):
                return [without_refresh(item) for item in value]
            return value
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(without_refresh(data)), encoding="utf-8")
        target.chmod(0o600)


def _isolated_env(env: dict[str, str], home: Path) -> dict[str, str]:
    result = dict(env)
    # 不继承宿主 Agent 注入的配置、插件目录或 Node 启动钩子。
    for key in list(result):
        if key.startswith(("CODEX_", "QWEN_CODE_", "CLAUDE_")) or key in {
            "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV",
        }:
            result.pop(key, None)
    result.update(HOME=str(home), USERPROFILE=str(home),
                  XDG_CONFIG_HOME=str(home / ".config"),
                  CODEX_HOME=str(home / ".codex"), CLAUDE_CONFIG_DIR=str(home / ".claude"))
    return result


def _codex_connection_config(home: Path) -> dict[str, Any]:
    """Retain native account/provider/model routing, never native tools or hooks."""
    path = home / "config.toml"
    if not path.is_file():
        return {}
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    with path.open("rb") as source:
        config = tomllib.load(source)
    result = {key: config[key] for key in (
        "model", "model_provider", "model_providers", "model_reasoning_effort",
    ) if key in config}
    # Provider 中的 headers helper 也可能是可执行命令，不继承到文档解读。
    if isinstance(result.get("model_providers"), dict):
        fields = {"name", "base_url", "wire_api", "env_key", "experimental_bearer_token",
                  "http_headers", "env_http_headers", "requires_openai_auth", "supports_websockets",
                  "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms",
                  "websocket_connect_timeout_ms"}
        result["model_providers"] = {name: {key: value for key, value in provider.items() if key in fields}
                                    for name, provider in result["model_providers"].items() if isinstance(provider, dict)}
    return result


def _codex_restrictions() -> dict[str, Any]:
    # environments=[] 去掉执行环境；这些开关同时覆盖较旧 CLI 的本机工具。
    # 临时 CODEX_HOME 不含 MCP、Skills、hooks 或项目配置，避免合并空表仍保留宿主条目。
    return {
        "web_search": "disabled", "project_doc_max_bytes": 0,
        "tools": {"experimental_request_user_input": {"enabled": False}, "update_plan": {"enabled": False}},
        "skills": {"bundled": {"enabled": False}, "include_instructions": False},
        "features": {**{name: False for name in (
            "shell_tool", "unified_exec", "apply_patch_freeform", "view_image",
            "multi_agent", "multi_agent_v2", "apps", "plugins", "remote_plugin",
            "hooks", "skill_search", "skill_mcp_dependency_install", "memories",
            "code_mode", "code_mode_host", "code_mode_only", "js_repl",
            "browser_use", "browser_use_external", "computer_use", "in_app_browser",
            "image_generation", "artifact", "goals", "sleep_tool", "tool_suggest",
            "workspace_dependencies", "shell_snapshot", "request_permissions_tool",
        )}, "skip_host_skill_discovery": True},
    }


async def _codex_text(backend: ModelBackend, content: str, rules: str,
                      home: Path, cwd: Path, model_override: str | None = None,
                      reasoning_effort: str | None = None, images: list[ImageAttachment] | None = None) -> str:
    from .codex_app_server import CodexAppServerProcess, local_app_server_command
    from .codex_office import resolve_codex_cli

    original_env = backend._build_env()
    original_home = Path(original_env.get("CODEX_HOME") or Path.home() / ".codex")
    config = _codex_connection_config(original_home)
    config.update(_codex_restrictions())
    if reasoning_effort:
        config['model_reasoning_effort'] = reasoning_effort
    env = _isolated_env(original_env, home)
    _copy_auth(original_home / "auth.json", home / ".codex" / "auth.json")
    # 原生 provider 配置经 JSON-RPC 传递，凭据不会进入进程命令行。
    http_args = backend._http_provider_args()
    if http_args:
        config.pop("model_provider", None)
        config.pop("model_providers", None)
        # thread/start 的 config 会替代进程启动时的 CLI overrides，必须同时
        # 带上当前 Backend 的 HTTP 路由，否则可能误连默认官方端点。
        for value in http_args[1::2]:
            key, _, raw = value.partition("=")
            config[key] = {"true": True, "false": False}.get(raw, raw)
    if backend._system_proxy_enabled():
        config["features"]["respect_system_proxy"] = True
    startup_args = ["--config", "web_search=disabled", "--config", "project_doc_max_bytes=0"]
    for feature, enabled in _codex_restrictions()["features"].items():
        startup_args.extend(["--config", f"features.{feature}={str(enabled).lower()}"])
    startup_args.extend(["--config", "skills.bundled.enabled=false", "--config", "skills.include_instructions=false"])
    conn = CodexAppServerProcess(launch_command=local_app_server_command(
        resolve_codex_cli(backend.config.cli_path),
        (["--enable", "respect_system_proxy"] if backend._system_proxy_enabled() else [])
        + http_args + startup_args,
    ), env=env, cwd=str(cwd))
    try:
        await conn.start()
        params: dict[str, Any] = {
            "cwd": str(cwd), "ephemeral": True, "approvalPolicy": "never",
            "sandbox": "read-only", "environments": [], "dynamicTools": [],
            "selectedCapabilityRoots": [],
            "baseInstructions": rules, "developerInstructions": "只返回文档解读正文。",
            "config": config,
        }
        model = model_override or backend.config.model or backend.get_env("OPENAI_MODEL")
        if model and model != "default":
            params["model"] = model
        started = await conn.request("thread/start", params, timeout=45)
        tid = (started.get("thread") or {}).get("id")
        if not tid:
            raise RuntimeError("Codex did not start an isolated thread")
        # 新版 Codex 始终声明 skills.list/read；它们只能读已发现的包。
        # 在提交第三方文档之前验证目录为空，不能仅假定临时 HOME 就足够。
        inventory = await conn.request("skills/list", {"cwds": [str(cwd)], "forceReload": True}, timeout=20)
        entries = inventory.get("data")
        if not isinstance(entries, list) or any(entry.get("skills") or entry.get("errors") for entry in entries):
            raise RuntimeError("Codex isolated skill catalog is not empty")
        await conn.request("turn/start", {
            "threadId": tid, "input": [{"type": "text", "text": content}] + [
                {"type": "image", "url": f"data:{image.mime_type};base64,{image.base64}"} for image in images or []],
            "environments": [], "approvalPolicy": "never",
        }, timeout=45)
        partial = ""
        final = ""
        while True:
            event = await conn.next_message()
            method = event.get("method", "")
            data = event.get("params") or {}
            if "id" in event and method:
                # 不代确认、不执行动态工具，也不把交互请求转发到当前聊天。
                await conn.respond(event["id"], error={"code": -32601, "message": "Text-only generation: tools are disabled"})
                raise RuntimeError("Codex requested a tool during text-only generation")
            if method == "item/agentMessage/delta":
                partial = (partial + str(data.get("delta") or ""))[:24000]
            elif method in {"item/started", "item/completed"}:
                item = data.get("item") or {}
                if item.get("type") == "agentMessage":
                    if method == "item/completed":
                        final = str(item.get("text") or "")[:24000]
                elif item.get("type") not in {"userMessage", "reasoning", "contextCompaction"}:
                    raise RuntimeError("Unexpected Codex tool event in text-only generation")
            elif method == "error":
                if data.get("willRetry"):
                    continue
                raise RuntimeError("Codex text generation failed: " + str((data.get("error") or {}).get("message") or "unknown error"))
            elif method == "turn/completed":
                turn = data.get("turn") or {}
                if turn.get("status") != "completed":
                    raise RuntimeError("Codex text generation did not complete")
                return final or partial
    finally:
        await conn.close()


async def _deny_tool(*_args: Any, **_kwargs: Any) -> dict[str, str]:
    return {"behavior": "deny", "message": "文档解读禁用所有工具，请直接返回正文。"}


def _assistant_text(blocks: list[Any]) -> str:
    texts = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get("type") == "tool_use":
                raise RuntimeError("Tool requested during text-only generation")
            if block.get("type") == "text":
                texts.append(str(block.get("text") or ""))
        elif type(block).__name__ == "ToolUseBlock":
            raise RuntimeError("Tool requested during text-only generation")
        elif type(block).__name__ == "TextBlock":
            texts.append(block.text)
    return "".join(texts)


async def _qwen_text(backend: ModelBackend, content: str, rules: str,
                     home: Path, cwd: Path, model_override: str | None = None,
                     images: list[ImageAttachment] | None = None) -> str:
    from qwen_code_sdk import query
    original_env = backend._build_env()
    env = _isolated_env(original_env, home)
    _copy_auth(Path(original_env.get("USERPROFILE") or original_env.get("HOME") or Path.home())
               / ".qwen" / "oauth_creds.json", home / ".qwen" / "oauth_creds.json")
    # 系统层设置也隔离，防止全局 MCP/扩展/钩子绕过临时 HOME。
    empty_settings = home / "empty-settings.json"
    empty_settings.write_text("{}", encoding="utf-8")
    env.update(QWEN_CODE_SYSTEM_SETTINGS_PATH=str(empty_settings),
               QWEN_CODE_SYSTEM_DEFAULTS_PATH=str(empty_settings))
    model = model_override or backend.get_env("QWEN_MODEL") or backend.config.model
    auth = backend.get_env("QWEN_PROVIDER") or backend.get_env("QWEN_AUTH_TYPE") or "openai"
    if backend.config.base_url:
        env.setdefault("OPENAI_BASE_URL" if auth != "anthropic" else "ANTHROPIC_BASE_URL", backend.config.base_url)
    backend._ensure_project_auth_settings(str(cwd), auth, model, enable_image_input=bool(images))
    # SDK 会省略 []，CLI 则将空 core-tools 当作全部工具。使用已知工具的
    # 单项白名单再排除它，交集严格为空；回调作为额外拒绝边界。
    options = dict(cwd=str(cwd), env=env, path_to_qwen_executable=backend._resolve_cli(),
                   model=model if model != "default" else None, auth_type=auth,
                   permission_mode="default", core_tools=["read_file"],
                   exclude_tools=["read_file"], can_use_tool=_deny_tool,
                   system_prompt=rules, max_session_turns=1)
    text = ""
    completed = False
    # JSON 中的 @ 转为等价转义，避免 CLI 将第三方文档误作 @文件附件展开。
    prompt = content.replace("@", "\\u0040")
    if images:
        # Qwen SDK 的 stream-json 只接受文本；仅为已核验的本轮图片生成原生附件引用。
        # 文件位于一次性 workspace，成功、报错和取消都会随 TemporaryDirectory 清理。
        attachments = cwd / 'reference-images'
        attachments.mkdir()
        refs = []
        for index, image in enumerate(images):
            filename = f'{index}.{image.mime_type.split("/")[-1]}'
            (attachments / filename).write_bytes(base64.b64decode(image.base64))
            refs.append(f'@reference-images/{filename}')
        prompt = '\n'.join(refs) + '\n\n' + prompt
    async with query(prompt, options) as result:
        async for message in result:
            if message.get("type") == "assistant":
                text = _assistant_text((message.get("message") or {}).get("content") or [])
            elif message.get("type") == "result":
                if message.get("is_error") or message.get("subtype") != "success":
                    raise RuntimeError("Qwen text generation did not complete")
                text = str(message.get("result") or text)
                completed = True
                break
    if not completed:
        raise RuntimeError("Qwen did not return a final result")
    return text


async def _claude_text(backend: ModelBackend, content: str, rules: str,
                       home: Path, cwd: Path, images: list[ImageAttachment] | None = None) -> str:
    from claude_agent_sdk import ClaudeAgentOptions, query
    from .base import resolve_claude_cli
    from .claude_code import ClaudeCodeOfficialBackend

    original_env = ClaudeCodeOfficialBackend(backend.config)._build_env()
    env = _isolated_env(original_env, home)
    auth_home = Path(original_env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    _copy_auth(auth_home / ".credentials.json", home / ".claude" / ".credentials.json")
    if backend.config.api_key:
        env.setdefault("ANTHROPIC_API_KEY", backend.config.api_key)
    if backend.config.base_url:
        env.setdefault("ANTHROPIC_BASE_URL", backend.config.base_url)
    model = backend.get_env("ANTHROPIC_MODEL") or backend.config.model
    options = ClaudeAgentOptions(
        cwd=str(cwd), env=env, cli_path=resolve_claude_cli(backend.config.cli_path),
        model=model if model and model != "default" else None,
        tools=[], allowed_tools=[], mcp_servers={}, setting_sources=[],
        permission_mode="default", can_use_tool=_deny_tool, system_prompt=rules,
        max_turns=1, extra_args={"strict-mcp-config": None, "disable-slash-commands": None,
                                "no-session-persistence": None},
    )

    async def prompt() -> AsyncIterator[dict[str, Any]]:
        blocks = [{"type": "image", "source": {"type": "base64", "media_type": image.mime_type,
                   "data": image.base64}} for image in images or []] + [{"type": "text", "text": content}]
        yield {"type": "user", "message": {"role": "user", "content": blocks if images else content}}

    text = ""
    completed = False
    stream = query(prompt=prompt(), options=options)
    try:
        async for message in stream:
            if type(message).__name__ == "AssistantMessage":
                text = _assistant_text(message.content)
            elif type(message).__name__ == "ResultMessage":
                if message.is_error or message.subtype != "success":
                    raise RuntimeError("Claude text generation did not complete")
                text = message.result or text
                completed = True
    finally:
        await stream.aclose()
    if not completed:
        raise RuntimeError("Claude did not return a final result")
    return text


async def send_text_only(backend: ModelBackend, *, content: str, constraints: str,
                         session_id: str, message_id: str,
                         on_delta: Callable[[StreamDelta], None],
                         model_override: str | None = None, reasoning_effort: str | None = None,
                         images: list[ImageAttachment] | None = None) -> None:
    images = _reference_images(images)
    kind = getattr(backend.config.type, "value", backend.config.type)
    if kind not in TEXT_ONLY_BACKENDS:
        raise ValueError("请选择支持文本解读的 Backend（图像生成 Backend 不适用）")
    if kind in {"openai-compatible", "anthropic-api"}:
        errors: list[str] = []
        def receive(delta: StreamDelta) -> None:
            if delta.type == 'error':
                errors.append(delta.error or '模型未能完成答疑')
            else:
                on_delta(delta)
        await backend.send_message(messages=[], content=content, images=images or None,
            session_id=session_id, message_id=message_id, on_delta=receive,
            constraints=constraints, extra_tools=None, on_tool_call=None)
        if errors:
            raise RuntimeError(('图片与手册答疑失败，请确认当前模型支持图片。' if images else '文档答疑失败。') + errors[-1][:500])
        return
    with tempfile.TemporaryDirectory(prefix="awu-text-only-") as root:
        home, cwd = Path(root) / "home", Path(root) / "work"
        home.mkdir()
        cwd.mkdir()
        for directory in (".codex", ".qwen", ".claude", ".config"):
            (home / directory).mkdir()
        runner = _codex_text if kind == "codex-office" else _qwen_text if kind == "qwen-code-cli" else _claude_text
        runtime: dict[str, Any] = {}
        if images:
            runtime['images'] = images
        if kind in {'codex-office', 'qwen-code-cli'} and model_override:
            runtime['model_override'] = model_override
        if kind == 'codex-office' and reasoning_effort:
            runtime['reasoning_effort'] = reasoning_effort
        text = await runner(backend, content, constraints, home, cwd, **runtime)
        on_delta(StreamDelta(session_id, message_id, "text_delta", text=text[:24000]))

"""显式 MCP 配置到原生客户端的 DTO。凭据只经当次协议传递，不写 patch。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


def normalize_servers(raw: Any, *, cwd: str) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, dict) or len(raw) > 8:
        raise ValueError("Harness MCP 配置必须是最多 8 个服务器的对象")
    servers = []
    for name, source in raw.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name) or not isinstance(source, dict):
            raise ValueError("Harness MCP 名称/配置无效")
        if set(source) - {"transport", "type", "command", "args", "env", "cwd", "url", "headers", "toolCallTimeoutMs", "disabled"}:
            raise ValueError("Harness MCP 包含未支持的字段，不能静默忽略")
        if "disabled" in source and type(source["disabled"]) is not bool:
            raise ValueError("Harness MCP disabled 必须是布尔值")
        if source.get("disabled") is True:
            continue
        if source.get("transport") and source.get("type") and source["transport"] != source["type"]:
            raise ValueError("Harness MCP transport/type 冲突")
        kind = source.get("transport") or source.get("type") or ("stdio" if source.get("command") else "streamable-http")
        if kind == "http":
            kind = "streamable-http"
        if kind not in {"stdio", "streamable-http"}:
            raise ValueError("Harness MCP 仅支持 stdio/streamable-http")
        incompatible = {"url", "headers"} if kind == "stdio" else {"command", "args", "env", "cwd"}
        if incompatible.intersection(source):
            raise ValueError("Harness MCP 包含其他 transport 的字段，不能静默忽略")
        timeout = source.get("toolCallTimeoutMs", 60000)
        if type(timeout) is not int or not 100 <= timeout <= 120000:
            raise ValueError("Harness MCP toolCallTimeoutMs 必须在 100–120000 之间")
        config: dict[str, Any] = {"serverName": name, "transport": kind, "toolCallTimeoutMs": timeout,
            "failOnStartupError": True, "maxInstructionBytes": 32768,
            "reconnect": {"enabled": False, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 1}}
        if kind == "stdio":
            command, args = source.get("command"), source.get("args", [])
            if not isinstance(command, str) or not command.strip() or "\x00" in command:
                raise ValueError("Harness MCP command 必须是独立可执行文件，不是 shell 程序")
            if not isinstance(args, list) or len(args) > 100 or any(not isinstance(arg, str) or "\x00" in arg for arg in args):
                raise ValueError("Harness MCP args 必须是独立字符串参数数组")
            env = source.get("env", {})
            if (not isinstance(env, dict) or len(env) > 100
                    or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                           or not isinstance(value, str) or "\x00" in value for key, value in env.items())):
                raise ValueError("Harness MCP env 无效")
            directory = source.get("cwd", cwd)
            if not isinstance(directory, str) or "\x00" in directory:
                raise ValueError("Harness MCP cwd 无效")
            path = Path(directory)
            if not path.is_absolute():
                path = Path(cwd) / path
            if not path.is_dir():
                raise ValueError("Harness MCP cwd 不存在")
            config.update(command=command, args=list(args), env=dict(env), cwd=str(path.resolve()))
        else:
            url = source.get("url")
            if not isinstance(url, str) or urlsplit(url).scheme not in {"http", "https"} or not urlsplit(url).hostname:
                raise ValueError("Harness MCP URL 必须是明确的 HTTP(S) 地址")
            headers = source.get("headers", {})
            if (not isinstance(headers, dict) or len(headers) > 100
                    or any(not isinstance(key, str) or not isinstance(value, str) or any(c in key + value for c in "\r\n\x00")
                           for key, value in headers.items())):
                raise ValueError("Harness MCP headers 无效")
            config.update(url=url, headers=dict(headers))
        servers.append(config)
    return servers

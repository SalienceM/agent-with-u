"""用户触发的只读目录查询；不共享活动 turn，不持久化候选或认证。"""

import asyncio
import json
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

from ..model_options import normalize_model_options
from .codex_app_server import CodexAppServerProcess, local_app_server_command

CATALOG_TIMEOUT = 25
MAX_PAGES = 20
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class CatalogError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class CatalogProcess(CodexAppServerProcess):
    """目录查询不保留原始 stderr/通知，错误只输出固定的安全分类。"""

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        stream = self.proc.stderr
        while await stream.read(4096):
            pass

    async def _read_one(self, timeout: float | None = None) -> dict[str, Any]:
        try:
            return await super()._read_one(timeout)
        except RuntimeError as exc:
            if isinstance(exc.__cause__, json.JSONDecodeError):
                raise CatalogError("invalid", "Codex 目录协议 JSON 无效，原候选未修改。") from None
            if isinstance(exc.__cause__, (ValueError, asyncio.LimitOverrunError)):
                raise CatalogError("limit", "Codex 单条目录响应超过安全上限，原候选未修改。") from None
            raise

    async def request(self, method: str, params: dict[str, Any], timeout: float = 12) -> Any:
        request_id = self._next_id
        self._next_id += 1
        await self.send({"method": method, "id": request_id, "params": params})
        # 防止通知洪流绕过超时、无限增长 _queued 或等待客户端批准。
        for _ in range(128):
            msg = await self._read_one(timeout)
            if "method" in msg and "id" in msg:
                raise CatalogError("unexpected_request", "目录查询请求了交互操作，已停止；可继续手工维护。")
            if msg.get("id") != request_id:
                continue
            if "error" in msg:
                error = msg["error"]
                code = error.get("code") if isinstance(error, dict) else None
                if code in (-32601, -32602):
                    raise CatalogError("unsupported", "当前 Codex 不支持目录查询协议，请升级目标节点 Codex 或手工维护。")
                if code in (401, 403):
                    raise CatalogError("auth", "Codex 目录认证或访问权限不可用；请检查目标 Backend 的登录和配置。")
                raise CatalogError("query_failed", "Codex 目录查询失败；请检查目标 Backend 的认证、网络及版本，或手工维护。")
            if "result" in msg:
                return msg["result"]
            raise CatalogError("invalid", "Codex 返回了无效目录协议，原候选未修改。")
        raise CatalogError("limit", "Codex 目录协议消息超过安全上限，原候选未修改。")

    async def close(self) -> None:
        # npm shim 可能带有子进程；只清理本查询创建的进程树，不按名称杀进程。
        proc = self.proc
        if proc and proc.returncode is None:
            if sys.platform == "win32":
                killer = None
                try:
                    killer = await asyncio.create_subprocess_exec(
                        "taskkill", "/F", "/T", "/PID", str(proc.pid),
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    await asyncio.wait_for(killer.wait(), 3)
                except (OSError, asyncio.TimeoutError):
                    if killer and killer.returncode is None:
                        killer.kill()
                        await killer.wait()
            else:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        await super().close()
        if proc and proc.returncode is None:
            await asyncio.wait_for(proc.wait(), 2)


def parse_catalog_page(value: object) -> tuple[list[dict[str, str]], str | None]:
    if not isinstance(value, dict) or not isinstance(value.get("data"), list):
        raise CatalogError("invalid", "Codex 目录格式无效，原候选未修改。")
    cursor = value.get("nextCursor")
    if cursor is not None and (not isinstance(cursor, str) or not cursor or len(cursor) > 4096):
        raise CatalogError("invalid", "Codex 目录分页信息无效，原候选未修改。")
    rows: list[dict[str, str]] = []
    for item in value["data"]:
        if not isinstance(item, dict):
            raise CatalogError("invalid", "Codex 目录条目无效，原候选未修改。")
        # 协议 model 是提交给运行参数的模型名；不能使用展示用 id 或首项默认值。
        rows.append({"id": item.get("model"), **(
            {"label": item["displayName"]} if "displayName" in item else {}
        )})
    try:
        normalized = normalize_model_options(rows)
    except ValueError:
        # 不回显可能含敏感内容的原始字段/重复 ID。
        raise CatalogError("invalid", "Codex 目录含非法、重复或超过 100 项的候选，原候选未修改。") from None
    return normalized or [], cursor


async def query_codex_catalog(codex_cli: str, env: dict[str, str],
                              global_args: list[str], cwd: str | None = None) -> dict[str, Any]:
    conn = CatalogProcess(
        launch_command=local_app_server_command(codex_cli, global_args), env=env, cwd=cwd,
        stream_limit=1024 * 1024, isolated_process_group=True,
    )

    async def collect() -> list[dict[str, str]]:
        await conn.start()
        rows: list[dict[str, str]] = []
        cursor = None
        seen: set[str] = set()
        size = 0
        for _ in range(MAX_PAGES):
            value = await conn.request("model/list", {"limit": 100, "cursor": cursor, "includeHidden": False})
            size += len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
            if size > MAX_RESPONSE_BYTES:
                raise CatalogError("limit", "Codex 目录超过安全大小上限，原候选未修改。")
            page, cursor = parse_catalog_page(value)
            rows.extend(page)
            try:
                normalize_model_options(rows)
            except ValueError:
                raise CatalogError("invalid", "Codex 目录存在重复或超过 100 项，原候选未修改。") from None
            if cursor is None:
                if not rows:
                    raise CatalogError("empty", "Codex 返回空目录，未清空候选；可继续手工维护。")
                return rows
            if cursor in seen:
                raise CatalogError("incomplete", "Codex 目录分页重复，未取得完整结果。")
            seen.add(cursor)
        raise CatalogError("incomplete", "Codex 目录分页超过安全上限，未取得完整结果。")

    try:
        rows = await asyncio.wait_for(collect(), CATALOG_TIMEOUT)
        return {"status": "ok", "modelOptions": rows, "source": "codex-app-server",
                "freshness": "unknown", "upstreamUpdatedAt": None,
                "fetchedAt": datetime.now(timezone.utc).isoformat()}
    except asyncio.TimeoutError:
        raise CatalogError("timeout", "Codex 目录查询超时，原候选未修改；可重试或手工维护。") from None
    except CatalogError:
        raise
    except Exception:
        raise CatalogError("unavailable", "无法读取 Codex 目录；请检查目标节点 CLI、网络和认证配置，或手工维护。") from None
    finally:
        # 取消同样执行清理，清理失败也只输出固定文案，不能宣称成功。
        try:
            await conn.close()
        except Exception:
            raise CatalogError("cleanup", "目录查询进程清理失败，未应用结果；请检查目标节点。") from None

"""Harness 结构化配置；无 SDK 导入、进程启动或隐式目录扫描。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

VERSION = "0.2.1rc3"
RUNTIME_VERSION = "0.2.1-rc.3"
COMMIT = "1f81c047fc48fa190a683e469daa699857e9afe8"
PROTOCOL_VERSION = 1
PERMISSION_MODES = frozenset({"read-only", "workspace-write", "danger-full-access"})
REASONING_EFFORTS = frozenset({"off", "low", "high", "max"})  # rc.3 deepseek-official route


def validate_config_fields(data: dict[str, Any]) -> None:
    provider = data.get("harnessProvider")
    if provider is not None and provider != "deepseek-official":
        raise ValueError("Harness 当前仅验证 deepseek-official provider")
    mode = data.get("harnessPermissionMode")
    if mode is not None and mode not in PERMISSION_MODES:
        raise ValueError("Harness 访问策略无效")
    maximum = data.get("harnessMaxTokens")
    if maximum is not None and (type(maximum) is not int or maximum <= 0):
        raise ValueError("harnessMaxTokens 必须是正整数")
    runtime = data.get("cliPath")
    if runtime is not None and (not isinstance(runtime, str) or not Path(runtime).is_absolute()):
        raise ValueError("Harness runtime 必须是本地可执行文件绝对路径，不能是命令字符串")
    for field in ("model", "baseUrl"):
        value = data.get(field)
        if value is not None and (not isinstance(value, str) or "\x00" in value):
            raise ValueError(f"Harness {field} 无效")
    # 任意环境覆盖不能偷偷替换受信 profile/主运行时/插件与日志开关。
    for key, value in (data.get("env") or {}).items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Harness 环境变量名称无效")
        if not isinstance(value, str) or "\x00" in value:
            raise ValueError("Harness 环境变量值必须是无 NUL 的文本")
        if key.startswith("DSH_") or key in {"NODE_OPTIONS", "NODE_PATH"}:
            raise ValueError("Harness 内部运行变量不能通过 Backend env 覆盖")

"""
集中管理 AgentWithU 后端的数据根目录。

历史上各 store（SessionStore / SkillStore / BackendStore …）各自硬编码
``Path.home() / ".agent-with-u"``。现在统一从这里取，目的：

  1. 部署隔离：通过环境变量 ``AGENT_WITH_U_DATA_ROOT`` 把整个数据目录
     重定向到别处。多用户自托管场景下，可以给每个用户起一个独立的
     后端进程，各自 ``AGENT_WITH_U_DATA_ROOT=~/agent-data/<user>``，
     实现彻底的数据隔离，且业务代码零改动。
  2. 单一切换点：将来若要在同一进程内做 per-user 子目录，只需改这一处。

注意：日志 / PID 文件仍然走 ws_main 里的 ``%APPDATA%/AgentWithU``（Windows）
分支——那是刻意与数据根目录分开的，不在本模块管辖范围内。

数据根目录默认值（所有平台一致，与历史行为保持一致，避免 Windows 上
数据被迁移）：``~/.agent-with-u``。
"""

from __future__ import annotations

import os
from pathlib import Path

_ENV_VAR = "AGENT_WITH_U_DATA_ROOT"
_DEFAULT = Path.home() / ".agent-with-u"


def data_root() -> Path:
    """返回数据根目录（不创建）。受 AGENT_WITH_U_DATA_ROOT 环境变量控制。"""
    env = os.environ.get(_ENV_VAR)
    if env:
        return Path(env).expanduser()
    return _DEFAULT


def sub(*parts: str) -> Path:
    """data_root() 下的子路径，例如 sub('sessions')、sub('skill-images')。"""
    return data_root().joinpath(*parts)

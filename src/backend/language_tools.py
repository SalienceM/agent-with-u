"""固定只读适配/格式化进程；有界输出、自然退出结果与所属树清理分别核对。"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
from typing import Any

from .engineering_process import EngineeringProcess
from .language_protocol import LspError


def asset(name: str) -> Path:
    root = Path(getattr(sys, '_MEIPASS')) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[2] / 'tools'
    return root / 'engine-providers' / name


def clean_environment(cache: Path) -> dict[str, str]:
    env = dict(os.environ)
    for key in ('NODE_OPTIONS', 'NODE_PATH', 'TSS_LOG', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS'):
        env.pop(key, None)
    env.update(PYTHONNOUSERSITE='1', PYTHONSAFEPATH='1', GRADLE_USER_HOME=str(cache / 'gradle'))
    return env


async def run_tool(row: Any, argv: list[str], data: bytes = b'', *, timeout: float = 20, limit: int = 3 * 1024 * 1024) -> str:
    output = bytearray()
    stderr = 0
    failed = False
    done = asyncio.Event()

    def receive(stream: str, block: bytes) -> None:
        nonlocal failed, stderr
        if stream == 'stderr':
            stderr += len(block)
            failed = failed or stderr > 1024 * 1024
        elif len(output) + len(block) <= limit:
            output.extend(block)
        else:
            failed = True
        if failed:
            done.set()

    def state() -> None:
        if process.exit_code is not None or process.failed:
            done.set()

    process = EngineeringProcess(receive, state)
    row.helpers.add(process)
    try:
        async def execute() -> None:
            await process.start(argv, row.plan.workspace.workingDir, clean_environment(row.cache))
            await process.write(data)
            await process.close_input()
            await done.wait()
        await asyncio.wait_for(execute(), timeout)
        if failed or process.failed or process.exit_code != 0 or not process.stdout_eof:
            raise LspError('language_tool_failed_or_excess_output')
        return output.decode('utf-8', errors='strict')
    finally:
        # 未确认的 helper 始终留在原服务上；不能随调用取消而释放活动。
        if await process.stop():
            row.helpers.discard(process)
        else:
            row.status = 'unknown'; row.reason = 'language_helper_exit_unconfirmed'
            raise LspError('language_helper_exit_unconfirmed')


def full_text_edit(before: str, after: str) -> list[dict[str, Any]]:
    if before == after:
        return []
    tail = before.rsplit('\n', 1)[-1]
    return [{'range': {'start': {'line': 0, 'character': 0}, 'end': {
        'line': before.count('\n'), 'character': len(tail.encode('utf-16-le')) // 2}}, 'newText': after}]

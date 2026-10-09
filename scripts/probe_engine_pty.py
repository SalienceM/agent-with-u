"""显式 ConPTY 原型验收；无应用 RPC、Shell 配置、模型或用户工程。"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

from scripts.probe_engine_providers import isolated_env
from src.backend.owned_process_tree import OwnedProcessTree


class NativeProcess:
    """将本次 PTY 原子句柄的状态适配到 owned Job 清理；不重开/按名称杀进程。"""
    def __init__(self, pty: Any) -> None:
        self.pty = pty
        self.pid = pty.pid

    @property
    def returncode(self) -> int | None:
        return None if self.pty.isalive() else self.pty.get_exitstatus()

    async def wait(self) -> int | None:
        while self.pty.isalive():
            await asyncio.sleep(.025)
        return self.pty.get_exitstatus()


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    args = parser.parse_args()
    if not args.run_native or os.name != 'nt':
        parser.error('Explicit --run-native on Windows is required')
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / 'tools' / 'engine-providers' / '.python'))
    from winpty import PTY
    from winpty.enums import Backend
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-pty-')
    temp = Path(temporary.name).resolve()
    if temp.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError('Not an exclusively owned test root')
    home = temp / 'home'
    home.mkdir()
    child = temp / 'terminal_child.py'
    shutil.copyfile(root / 'tests' / 'fixtures' / 'engine' / 'terminal_child.py', child)
    pty = PTY(80, 24, backend=Backend.ConPTY)
    env = isolated_env(home)
    env_text = '\0'.join(f'{key}={value}' for key, value in env.items()) + '\0'
    pty.spawn(sys.executable, cwd=str(temp), env=env_text,
              cmdline=' ' + subprocess.list2cmdline(['-I', str(child)]))
    process = NativeProcess(pty)
    owner = OwnedProcessTree(process)
    result: dict[str, Any] = {'platform': 'windows', 'adapter': 'pywinpty-2.0.15-ConPTY',
                              'interactiveInput': False, 'resize': False, 'childTracked': False}
    tail = ''
    async def expect(pattern: str) -> re.Match:
        nonlocal tail
        deadline = asyncio.get_running_loop().time() + 8
        while asyncio.get_running_loop().time() < deadline:
            data = await asyncio.to_thread(pty.read, 4096, False)
            if data:
                tail = (tail + data)[-65536:]
            match = re.search(pattern, tail)
            if match:
                return match
            await asyncio.sleep(.02)
        raise TimeoutError('PTY fixture did not acknowledge operation')
    try:
        if not owner.complete:
            raise RuntimeError('Owned Job could not be assigned')
        await expect('FIXTURE_READY')
        pty.write('hello\r')
        await expect('FIXTURE_ECHO_OK')
        result['interactiveInput'] = True
        pty.set_size(103, 37)
        pty.write('size\r')
        await expect('FIXTURE_SIZE_103_37')
        result['resize'] = True
        pty.write('child\r')
        pid = int((await expect(r'FIXTURE_CHILD_(\d+)')).group(1))
        owner.capture()
        result['childTracked'] = pid in owner.handles
        if not result['childTracked']:
            raise RuntimeError('Child not held by owned handle')
    finally:
        result['exitConfirmed'] = await owner.stop()
        if result['exitConfirmed']:
            result['allHandlesExited'] = owner.exit_confirmed()
            owner.release()
            del pty
            temporary.cleanup()
        else:
            # 不删除未确认进程占用的数据，不将停止请求当成退出证据。
            temporary._finalizer.detach()
        print(json.dumps(result, indent=2))
    return 0 if all(result.get(key) is True for key in (
        'interactiveInput', 'resize', 'childTracked', 'exitConfirmed', 'allHandlesExited')) else 2


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

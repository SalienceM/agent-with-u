"""显式原生宿主验收：固定 PTY 夹具与 stdio 子进程，绝不使用生产 Session。"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from scripts.probe_engine_providers import isolated_env
from src.backend.engineering_process import EngineeringProcess


async def probe(host: Path | None = None) -> int:
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-pty-')
    root = Path(temporary.name).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError('test root required')
    home = root / 'home'; home.mkdir()
    env = isolated_env(home)
    env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1] / 'tools/engine-providers/.python')
    env.update(TERM='xterm-256color', LANG='C.UTF-8')
    fixture = root / 'terminal_child.py'
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'tests/fixtures/engine/terminal_child.py', fixture)
    tail = ''
    def output(stream: str, data: bytes) -> None:
        nonlocal tail
        tail = (tail + data.decode(errors='replace'))[-65536:]
    async def expect(text: str) -> None:
        deadline = asyncio.get_running_loop().time() + 10
        while text not in tail:
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError('native fixture response missing: ' + text)
            await asyncio.sleep(.02)
    resource = EngineeringProcess(output)
    if host:
        resource.helper_command = [str(host.resolve(strict=True)), '--agentwithu-engine-host']
    result = {'platform': sys.platform, 'input': False, 'resize': False, 'child': False, 'exitConfirmed': False}
    try:
        await resource.start([sys.executable, '-I', str(fixture)], str(root), env, mode='pty')
        await expect('FIXTURE_READY')
        newline = '\r' if os.name == 'nt' else '\n'
        await resource.write(('hello' + newline).encode()); await expect('FIXTURE_ECHO_OK'); result['input'] = True
        await resource.resize(103, 37)
        await resource.write(('size' + newline).encode()); await expect('FIXTURE_SIZE_103_37'); result['resize'] = True
        await resource.write(('child' + newline).encode()); await expect('FIXTURE_CHILD_'); result['child'] = True
        if sys.platform.startswith('linux'):
            await resource.write(b'daemon\n'); await expect('FIXTURE_DAEMON_'); result['daemon'] = True
    finally:
        result['exitConfirmed'] = await resource.stop()
        if result['exitConfirmed']:
            temporary.cleanup()
        else:
            temporary._finalizer.detach()
        print(json.dumps(result))
    return 0 if all(value is True for key, value in result.items() if key != 'platform') else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    parser.add_argument('--host', type=Path)
    args = parser.parse_args()
    if not args.run_native:
        parser.error('--run-native required')
    raise SystemExit(asyncio.run(probe(args.host)))

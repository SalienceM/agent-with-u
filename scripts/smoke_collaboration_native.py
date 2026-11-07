"""显式执行的无模型 smoke：独立测试用户目录，仅启动协议/版本检查。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.backend.codex_office import resolve_codex_cli, _codex_launch_command
from src.backend.codex_app_server import CodexAppServerProcess


async def main() -> None:
    codex = resolve_codex_cli()
    claude = shutil.which('claude')
    node = shutil.which('node')
    npm = Path(os.environ.get('APPDATA', '')) / 'npm/node_modules'
    qwen = npm / '@qwen-code/qwen-code/cli.js'
    harness = npm / '@deepseek-ai/dsh/lib/bin.js'
    report = {'isolation': 'temporary user/home/workspace; no production credentials, sessions or model calls', 'backends': {}}
    with tempfile.TemporaryDirectory(prefix='awu-collaboration-native-') as temporary:
        root = Path(temporary).resolve(); workspace = root / 'workspace'; workspace.mkdir()
        home = root / 'test-user'; home.mkdir()
        env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP'}}
        for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AGENT_WITH_U_DATA_ROOT'):
            folder = home / key.lower(); folder.mkdir(); env[key] = str(folder)
        env.update(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1')
        def version(argv: list[str]) -> str:
            return subprocess.check_output(argv + ['--version'], cwd=workspace, env=env, stderr=subprocess.DEVNULL, timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0).decode('utf-8').strip()[:200]
        try:
            codex_version = version(_codex_launch_command(codex, []))
            server = CodexAppServerProcess(launch_command=_codex_launch_command(codex, ['app-server', '--listen', 'stdio://']), env=env, cwd=str(workspace))
            try:
                await server.start()
                threads = await server.request('thread/list', {'limit': 10, 'sourceKinds': ['cli', 'vscode', 'exec', 'appServer', 'unknown']}, timeout=10)
                if threads.get('data'): raise RuntimeError('isolated inventory unexpectedly nonempty')
                report['backends']['codex-node'] = {'version': codex_version, 'initialize': 'passed', 'isolatedThreadList': 'empty', 'questions': 'fixture-tested; live model not invoked'}
            finally: await server.close()
        except Exception as error: report['backends']['codex-node'] = {'status': 'unverified', 'reason': type(error).__name__}
        for name, argv in [('claude-cli', [claude] if claude else []), ('qwen-sdk-cli', [node, str(qwen)] if node and qwen.is_file() else []),
                           ('harness', [node, str(harness)] if node and harness.is_file() else [])]:
            if not argv:
                report['backends'][name] = {'status': 'not-installed-at-discovered-entry', 'questions': 'not live-tested'}; continue
            try:
                reported_version = await asyncio.to_thread(version, argv)
                report['backends'][name] = {'version': reported_version or 'CLI did not report a version',
                    'startup': 'version command passed' if reported_version else 'exited 0 without version; protocol not verified',
                    'questions': 'fixture/locked contract only; no live model'}
            except Exception as error: report['backends'][name] = {'status': 'unverified', 'reason': type(error).__name__}
        report['backends']['ssh'] = {'status': 'not-tested', 'reason': 'no isolated SSH target selected'}
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__': asyncio.run(main())

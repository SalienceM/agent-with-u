"""显式原生 LSP 初始化探针；不是语义能力验收，不连接 AWU 或任何模型。

python -m scripts.probe_engine_providers --run-native
只运行仓库中预先准备的固定依赖，不下载工具或加载用户工程。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any

from src.backend.owned_process_tree import OwnedProcessTree

REPO = Path(__file__).resolve().parents[1]
TOOLS = REPO / 'tools' / 'engine-providers'
MODULES = TOOLS / 'node_modules'
MAX_FRAME = 1024 * 1024
CAPABILITIES = ('completionProvider', 'definitionProvider', 'referencesProvider',
                'diagnosticProvider', 'documentFormattingProvider', 'renameProvider')
UNRESOLVED_OWNERS: list[OwnedProcessTree] = []


def isolated_env(home: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'}}
    env.update({key: str(home) for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
                                         'TEMP', 'TMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME')})
    env.update({'CODEX_HOME': str(home / '.codex'), 'CLAUDE_CONFIG_DIR': str(home / '.claude'),
                'AGENT_WITH_U_DATA_ROOT': str(home / 'awu'), 'PYTHONNOUSERSITE': '1',
                'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': ''})
    return env


class Probe:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process
        self.frames = 0
        self.bytes_read = 0

    async def send(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.process.stdin.write(f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii') + body)
        await self.process.stdin.drain()

    async def receive(self) -> dict[str, Any]:
        header = await self.process.stdout.readuntil(b'\r\n\r\n')
        if len(header) > 4096:
            raise ValueError('oversized header')
        lengths = [line.partition(b':')[2].strip() for line in header.split(b'\r\n')
                   if line.lower().startswith(b'content-length:')]
        if len(lengths) != 1 or not lengths[0].isdigit():
            raise ValueError('invalid frame')
        length = int(lengths[0])
        self.frames += 1
        self.bytes_read += length
        if length > MAX_FRAME or self.frames > 256 or self.bytes_read > 4 * MAX_FRAME:
            raise ValueError('probe output budget exceeded')
        return json.loads(await self.process.stdout.readexactly(length))

    async def response(self, request_id: int) -> dict[str, Any]:
        while True:
            frame = await self.receive()
            if frame.get('id') == request_id and 'method' not in frame:
                if 'error' in frame:
                    raise ValueError('provider rejected probe')
                return frame.get('result') or {}
            if 'id' in frame and 'method' in frame:
                # 不执行 provider 请求的命令/编辑或安装；只回答只读配置握手。
                if frame['method'] == 'workspace/configuration':
                    await self.send({'jsonrpc': '2.0', 'id': frame['id'], 'result':
                                     [None for _ in frame.get('params', {}).get('items', [])]})
                else:
                    await self.send({'jsonrpc': '2.0', 'id': frame['id'], 'error':
                                     {'code': -32601, 'message': 'Not enabled in isolated probe'}})


async def run_probe(name: str, command: list[str], project: Path,
                    home: Path, options: dict[str, Any]) -> dict[str, Any]:
    if not Path(command[0]).is_file():
        return {'provider': name, 'status': 'unverified', 'reason': 'missing_prepared_dependency'}
    process = await asyncio.create_subprocess_exec(*command, cwd=project, env=isolated_env(home),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=8192, creationflags=subprocess.CREATE_NO_WINDOW)
    owner = OwnedProcessTree(process)
    probe = Probe(process)
    result: dict[str, Any] = {'provider': name, 'status': 'failed'}
    try:
        if not owner.complete:
            raise ValueError('process ownership incomplete')
        async def initialize() -> dict[str, Any]:
            await probe.send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'processId': os.getpid(), 'rootUri': project.as_uri(),
                'workspaceFolders': [{'uri': project.as_uri(), 'name': 'isolated-fixture'}],
                'capabilities': {'textDocument': {'publishDiagnostics': {},
                    'rename': {'prepareSupport': True}, 'completion': {}, 'definition': {},
                    'references': {}, 'formatting': {}}, 'workspace': {'configuration': True}},
                'initializationOptions': options}})
            return await probe.response(1)
        initialized = await asyncio.wait_for(initialize(), 20)
        capabilities = initialized.get('capabilities', {})
        await probe.send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
        result.update(status='handshake_only', declaredCapabilities={
            key: key in capabilities and capabilities[key] is not False for key in CAPABILITIES})
        await probe.send({'jsonrpc': '2.0', 'id': 2, 'method': 'shutdown', 'params': None})
        await asyncio.wait_for(probe.response(2), 5)
        await probe.send({'jsonrpc': '2.0', 'method': 'exit'})
    except (ValueError, OSError, asyncio.TimeoutError, asyncio.IncompleteReadError,
            asyncio.LimitOverrunError) as error:
        # 不收集真实输出/异常内容，记录有界类别即可。
        result.update(status='failed', reason=type(error).__name__)
    finally:
        confirmed = await owner.stop()
        result['exitConfirmed'] = confirmed
        if not confirmed:
            result.update(status='unresolved', reason='owned_process_exit_not_confirmed')
            UNRESOLVED_OWNERS.append(owner)
        else:
            owner.release()
    return result


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    parser.add_argument('--jdtls-home', type=Path)
    parser.add_argument('--java', type=Path)
    args = parser.parse_args()
    if not args.run_native:
        parser.error('Explicit --run-native is required; this starts isolated local provider processes')
    if os.name != 'nt':
        parser.error('This probe currently verifies Windows owned Job cleanup only; POSIX is unverified')
    node = shutil.which('node')
    if not node:
        parser.error('Node must be explicitly prepared on PATH')
    results = []
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-native-')
    try:
        root = Path(temporary.name).resolve()
        if root.parent != Path(tempfile.gettempdir()).resolve():
            raise RuntimeError('not an isolated test root')
        home = root / 'home'
        home.mkdir()
        for name in ('python', 'react', 'vue', 'java'):
            shutil.copytree(REPO / 'tests' / 'fixtures' / 'engine' / name, root / name)
        tsdk = str(MODULES / 'typescript' / 'lib')
        commands = [
            ('pyright', [node, str(MODULES / 'pyright' / 'langserver.index.js'), '--stdio'], 'python', {}),
            ('typescript', [node, str(MODULES / 'typescript-language-server' / 'lib' / 'cli.mjs'), '--stdio'],
             'react', {'tsserver': {'path': str(MODULES / 'typescript' / 'lib' / 'tsserver.js')}}),
            ('vue', [node, str(MODULES / '@vue' / 'language-server' / 'bin' / 'vue-language-server.js'), '--stdio'],
             'vue', {'typescript': {'tsdk': tsdk}, 'vue': {'hybridMode': False}}),
            ('ruff', [str(TOOLS / '.python' / 'bin' / 'ruff.exe'), 'server'], 'python', {}),
        ]
        for name, command, project, options in commands:
            # 第二个参数可能是子命令而非路径，依赖检查由已知路径单独完成。
            if not Path(command[0]).is_file() or (name != 'ruff' and not Path(command[1]).is_file()):
                results.append({'provider': name, 'status': 'unverified', 'reason': 'missing_prepared_dependency'})
                continue
            results.append(await run_probe(name, command, root / project, home, options))
            if UNRESOLVED_OWNERS:
                break
        if args.jdtls_home and args.java and not UNRESOLVED_OWNERS:
            jdt = args.jdtls_home.resolve(strict=True)
            java = args.java.resolve(strict=True)
            launchers = list((jdt / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))
            cores = list((jdt / 'plugins').glob('org.eclipse.jdt.ls.core_1.42.0.*.jar'))
            if len(launchers) != 1 or len(cores) != 1:
                raise ValueError('Expected the prepared JDT LS 1.42.0 artifact')
            command = [str(java), '-Declipse.application=org.eclipse.jdt.ls.core.id1',
                '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product',
                '-Dosgi.checkConfiguration=true', '-Dosgi.configuration.cascaded=true',
                '-Dosgi.sharedConfiguration.area=' + str(jdt / 'config_win'),
                '-Dosgi.sharedConfiguration.area.readOnly=true', '-Duser.home=' + str(home),
                '-Djava.io.tmpdir=' + str(home), '-Xmx1G', '--add-modules=ALL-SYSTEM',
                '--add-opens', 'java.base/java.util=ALL-UNNAMED',
                '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(launchers[0]),
                '-configuration', str(home / 'jdt-configuration'), '-data', str(home / 'jdt-data')]
            results.append(await run_probe('jdtls', command, root / 'java', home, {
                'settings': {'java': {'autobuild': {'enabled': False},
                    'import': {'maven': {'enabled': False}, 'gradle': {'enabled': False}},
                    'configuration': {'updateBuildConfiguration': 'disabled'}}}}))
        else:
            results.append({'provider': 'jdtls', 'version': '1.42.0', 'status': 'unverified',
                            'reason': 'explicit_JDT_LS_home_and_Java_path_required'})
    finally:
        if UNRESOLVED_OWNERS:
            # 清理未知不删除仍可能被占用的测试数据；不宣布退出成功。
            temporary._finalizer.detach()
        else:
            temporary.cleanup()
    print(json.dumps({'schemaVersion': 1, 'platform': 'windows', 'scope': 'initialize_only',
                      'results': results}, ensure_ascii=False, indent=2))
    return 0 if all(item['status'] == 'handshake_only' for item in results) else 2


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

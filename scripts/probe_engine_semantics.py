"""真实离线语言工程验收；所有写入限于自有临时 HOME/工程，结果不含源码。"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import venv
from unittest.mock import patch
import uuid

from scripts.probe_engine_providers import isolated_env
from src.backend.engine_workbench import WorkspaceIdentity, EngineeringActivity
from src.backend.workspace_languages import LanguageManager
from src.backend.language_protocol import LspChannel

REPO = Path(__file__).resolve().parents[1]
MODULES = REPO / 'tools/engine-providers/node_modules'


class ProbeBridge:
    def __init__(self, workspace):
        self.workspace = workspace
        self.active = {}

    def _engineering_admit(self, sid, expected, revision, kind):
        self.workspace.require_match(expected)
        lease = EngineeringActivity(self.workspace, uuid.uuid4().hex, kind, 0)
        self.active[lease.activity_id] = lease
        return lease

    def _engineering_recheck(self, lease):
        assert self.active.get(lease.activity_id) is lease

    def _engineering_confirm_finished(self, lease):
        assert self.active.pop(lease.activity_id) is lease

    async def _send_for_session(self, *args, **kwargs):
        pass


async def probe(args) -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-language-')
    root = Path(temporary.name).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError('not an isolated root')
    home = root / 'home'; home.mkdir()
    project = root / args.provider
    shutil.copytree(REPO / 'tests/fixtures/engine' / args.provider, project)
    if args.provider in ('react', 'vue'):
        # 只链接已准备的固定依赖，不执行 npm 或项目脚本。
        (project / 'node_modules').mkdir()
        for name in (['react', '@types/react', 'csstype'] if args.provider == 'react' else ['vue', '@vue']):
            source, target = MODULES / name, project / 'node_modules' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target)
    workspace = WorkspaceIdentity('engine-native-fixture', uuid.uuid4().hex, 'fixture', os.path.normcase(str(project)), 'a' * 64)
    bridge = ProbeBridge(workspace)
    protocol_errors = []
    class ProbeChannel(LspChannel):
        def _message(self, message):
            if 'error' in message and len(protocol_errors) < 8:
                protocol_errors.append(str(message['error'])[:2000])
            if message.get('method') == 'window/logMessage' and message.get('params', {}).get('type') == 1 and len(protocol_errors) < 8:
                protocol_errors.append(str(message['params'].get('message', ''))[:2000])
            super()._message(message)
    manager = LanguageManager(bridge, ProbeChannel)
    env = isolated_env(home)
    config = {'provider': args.provider}
    if args.provider == 'java':
        if not args.java or not args.jdt_home:
            raise ValueError('--java and --jdt-home required')
        config.update(javaPath=str(args.java.resolve()), projectJdk=str(args.java.resolve().parents[1]), jdtHome=str(args.jdt_home.resolve()))
        config.update(mavenImport=args.build == 'maven', gradleImport=args.build == 'gradle')
        if args.build == 'maven':
            if not args.maven_repository:
                raise ValueError('--maven-repository required')
            copied_repository = root / 'maven-repository'
            shutil.copytree(args.maven_repository.resolve(), copied_repository)
            config['mavenRepository'] = str(copied_repository)
        if args.build == 'gradle':
            if not args.gradle_home:
                raise ValueError('--gradle-home required')
            config['gradleHome'] = str(args.gradle_home.resolve())
    else:
        config.update(nodePath=shutil.which('node'), toolsHome=str(MODULES))
        if args.provider == 'python':
            environment = root / 'venv'
            venv.EnvBuilder(with_pip=False).create(environment)
            config.update(pythonPath=str(environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')),
                ruffPath=str(REPO / 'tools/engine-providers/.python/bin/ruff.exe'))
        else:
            config['typescriptHome'] = str(MODULES / 'typescript')
    paths = {'python': ('main.py', 'models.py', 'greet'), 'react': ('App.tsx', 'Card.tsx', 'Card'),
             'vue': ('App.vue', 'Card.vue', 'Card'), 'java': ('src/engine/Main.java', 'src/engine/Greeting.java', 'greet')}
    main, dependency, symbol = paths[args.provider]
    if args.jsx:
        if args.provider != 'react':
            raise ValueError('--jsx requires react')
        main, dependency, symbol = 'AppJS.jsx', 'CardJS.jsx', 'CardJS'
    result = {'provider': args.provider, 'ready': False, 'exitConfirmed': False}
    row = None
    with patch.dict(os.environ, env, clear=True):
        try:
            plan = manager.plan(workspace, config)
            row = manager.start(workspace, {'requestId': 'native-probe', 'planFingerprint': plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'allowBuildImport': args.build != 'none', 'controlRevision': 0})
            await row.task
            result['ready'] = row.status == 'ready'
            if not result['ready']:
                result['reason'] = row.reason
                return 2
            texts = {relative: (project / relative).read_text(encoding='utf-8') for relative in (dependency, main)}
            # 不改磁盘：让格式化必须返回非空、针对未保存缓冲区的修改。
            texts[main] = texts[main].replace(' = ', '=').replace('    int invalid', 'int invalid').replace('  return', 'return')
            for relative in (dependency, main):
                await manager.sync(row, {'relativePath': relative, 'revision': 1, 'text': texts[relative]})
            text = texts[main]
            index = text.index(symbol, text.find('\n') + 1) if args.provider != 'vue' else text.index('<Card') + 1
            prefix = text[:index + 1]
            position = {'line': prefix.count('\n'), 'character': len(prefix.rsplit('\n', 1)[-1].encode('utf-16-le')) // 2}
            payload = {'relativePath': main, 'revision': 1, 'text': text, 'position': position}
            # 给真实索引一个有界可见诊断等待；不是将初始化当语义通过。
            deadline = asyncio.get_running_loop().time() + 30
            while not any(v['items'] and v['relativePath'].lower() == main.lower() for v in row.diagnostics.values()) and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(.1)
            await manager.request(row, {'requestId': 'diagnostics', 'action': 'diagnostics'})
            result['diagnostics'] = [{'file': k, 'count': len(v['items']), 'freshness': v['freshness'],
                'messages': [item['message'] for item in v['items'][:3]]} for k, v in row.diagnostics.items()]
            for action in ('completion', 'definition', 'references', 'rename', 'format'):
                try:
                    selected = payload
                    rename_symbol = symbol
                    if action == 'rename':
                        rename_symbol = 'title' if args.provider == 'vue' else symbol
                        source = texts[dependency]; offset = source.index(rename_symbol) + 1
                        prefix = source[:offset]
                        selected = {'relativePath': dependency, 'text': source, 'revision': 1,
                            'position': {'line': prefix.count('\n'), 'character': len(prefix.rsplit('\n', 1)[-1].encode('utf-16-le')) // 2}}
                    response = await manager.request(row, {**selected, 'requestId': action, 'action': action, 'newName': rename_symbol + 'Renamed'})
                    value = response['result']
                    result[action] = {'received': value is not None, 'count': len(value) if isinstance(value, list) else len(value.get('items', [])) if isinstance(value, dict) else 0}
                    if action == 'rename':
                        result[action]['files'] = len(value.get('changes', value.get('documentChanges', []))) if isinstance(value, dict) else 0

                except (ValueError, RuntimeError, asyncio.TimeoutError) as error:
                    result[action] = {'error': str(error)[:80]}
            result['sixSemanticsVerified'] = (any(d['freshness'] == 'current' and any(
                'not assignable' in m or 'Type mismatch' in m for m in d['messages']) for d in result['diagnostics'])
                and all(result.get(a, {}).get('count', 0) > 0 for a in ('completion', 'definition', 'references', 'format'))
                and result.get('rename', {}).get('files', 0) >= 2)
            if args.provider == 'java':
                doc = next(d for d in row.documents.values() if d.path.lower() == main.lower())
                details = await row.channel.request('workspace/executeCommand', {'command': 'awu.java.versionedDiagnostics',
                    'arguments': [{'uri': doc.uri, 'text': doc.text, 'revision': doc.revision}]}, timeout=15)
                result['projectNatures'] = details.get('projectNatures')
                expected = {'maven': 'org.eclipse.m2e.core.maven2Nature', 'gradle': 'org.eclipse.buildship.core.gradleprojectnature'}
                result['buildImportVerified'] = args.build == 'none' or expected[args.build] in (result['projectNatures'] or [])
                result['sixSemanticsVerified'] = result['sixSemanticsVerified'] and result['buildImportVerified']
        finally:
            if row:
                await manager.stop(row)
                if row.notice:
                    row.notice.cancel()
                result['exitConfirmed'] = row.status == 'stopped' and not bridge.active
            else:
                result['exitConfirmed'] = True
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if protocol_errors:
                print(json.dumps({'fixtureProtocolErrors': protocol_errors}, ensure_ascii=False, indent=2))
                log = row.cache / 'jdt-data/.metadata/.log' if row else None
                if log and log.is_file():
                    with log.open('rb') as stream:
                        stream.seek(max(0, log.stat().st_size - 12000))
                        print(stream.read(12000).decode('utf-8', errors='replace'))
            if result['exitConfirmed']:
                temporary.cleanup()
            else:
                temporary._finalizer.detach()
    return 0 if result.get('sixSemanticsVerified') and result['exitConfirmed'] else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    parser.add_argument('--provider', choices=['java', 'python', 'react', 'vue'], required=True)
    parser.add_argument('--java', type=Path); parser.add_argument('--jdt-home', type=Path)
    parser.add_argument('--build', choices=['none', 'maven', 'gradle'], default='none')
    parser.add_argument('--gradle-home', type=Path)
    parser.add_argument('--maven-repository', type=Path)
    parser.add_argument('--jsx', action='store_true')
    args = parser.parse_args()
    if not args.run_native:
        parser.error('--run-native required')
    raise SystemExit(asyncio.run(probe(args)))

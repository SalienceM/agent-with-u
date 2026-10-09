"""Opt-in actual Shell/TerminalManager verification in a fresh isolated home."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from unittest.mock import patch
import uuid

from scripts.probe_engine_providers import isolated_env
from src.backend.engine_workbench import EngineeringActivity, WorkspaceIdentity, WorkbenchError
from src.backend.engineering_process import EngineeringProcess
from src.backend.workspace_terminals import TerminalManager, terminal_shells, OUTPUT_LIMIT, READ_LIMIT


async def probe(host: Path | None, shell: str | None) -> int:
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-shell-')
    root = Path(temporary.name).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError('isolated root required')
    home = root / 'home'; home.mkdir()
    command = root / 'shell_command.py'
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'tests/fixtures/engine/shell_command.py', command)
    env = isolated_env(home)
    env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1] / 'tools/engine-providers/.python')
    workspace = WorkspaceIdentity('native-shell-fixture', uuid.uuid4().hex, 'shell-fixture', os.path.normcase(str(root)), 'a' * 64)
    class Bridge:
        active = {}
        def _engineering_admit(self, session, expected, revision, kind):
            workspace.require_match(expected)
            row = EngineeringActivity(workspace, uuid.uuid4().hex, kind, 0)
            self.active[row.activity_id] = row
            return row
        def _engineering_recheck(self, row):
            assert self.active.get(row.activity_id) is row
        def _engineering_confirm_finished(self, row):
            assert self.active.pop(row.activity_id) is row
        async def _send_for_session(self, *args, **kwargs):
            pass  # Simulates a disconnected subscriber, not a disconnected execution process.
    def factory(data, state):
        process = EngineeringProcess(data, state)
        if host:
            process.helper_command = [str(host.resolve(strict=True)), '--agentwithu-engine-host']
        return process
    bridge = Bridge(); manager = TerminalManager(bridge, factory)
    selected = shell or ('cmd' if os.name == 'nt' else 'bash')
    if selected not in [item['id'] for item in terminal_shells()]:
        raise RuntimeError('selected Shell unavailable')
    result = {'platform': sys.platform, 'frozen': bool(host), 'shell': selected}
    row = None
    with patch.dict(os.environ, env, clear=True):
        try:
            creation = {'requestId': 'shell-probe', 'shell': selected, 'controlRevision': 0}
            row = manager.create(workspace, creation); await row.task
            assert row.status == 'running'
            assert manager.create(workspace, creation) is row
            result['createIdempotent'] = True
            async def expect(marker, seconds=15):
                deadline = asyncio.get_running_loop().time() + seconds
                while marker not in ''.join(text for _, text, _ in row.chunks):
                    if asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError('Missing fixed fixture marker: ' + marker)
                    await asyncio.sleep(.025)
            async def send(action):
                prefix = '& ' if selected == 'powershell' else ''
                text = f'{prefix}"{sys.executable}" -I "{command}" {action}' + ('\r' if os.name == 'nt' else '\n')
                payload = {'requestId': uuid.uuid4().hex, 'sequence': row.input_sequence + 1, 'text': text}
                assert (await manager.input(row, payload))['status'] == 'accepted'
                return payload
            payload = await send('ready'); await expect('AWU_SHELL_READY')
            assert (await manager.input(row, payload))['status'] == 'duplicate'
            result['inputAndDedupe'] = True
            await manager.resize(row, 103, 37)
            await send('size'); await expect('AWU_SIZE_103_37'); result['resize'] = True
            await send('wait'); await expect('AWU_WAITING')
            await manager.input(row, {'requestId': 'control-c', 'sequence': row.input_sequence + 1, 'text': '\x03'})
            await expect('AWU_CTRL_C')
            assert row.status == 'running' and bridge.active
            await send('ready'); result['controlCLeavesShellAlive'] = True
            await manager.resize(row, 500, 24)
            await send('flood'); await expect('AWU_FLOOD_DONE', 90)
            sequence = row.input_sequence; position = 0; chunks = []
            for page in range(32):
                reply = row.read(position)
                if page == 0:
                    assert reply['gap']
                assert sum(len(c['text'].encode('utf-8')) for c in reply['chunks']) <= READ_LIMIT
                chunks.extend(c['text'] for c in reply['chunks']); position = reply['through']
                if position == row.sequence:
                    break
            assert 'AWU_FLOOD_DONE' in ''.join(chunks)
            assert row.input_sequence == sequence and row.size <= OUTPUT_LIMIT
            assert row.read(position)['chunks'] == []
            result['boundedReconnectWithoutInputReplay'] = True
            try:
                TerminalManager(bridge, factory).require(workspace, row.resource_id, row.generation)
            except WorkbenchError:
                result['restartDoesNotAdoptOldPid'] = True
            else:
                raise AssertionError('new manager adopted a process')
        except Exception:
            if row:
                result['fixtureOutputTail'] = ''.join(text for _, text, _ in row.chunks)[-2400:]
            raise
        finally:
            if row:
                await manager.stop(row, 'stop-native')
                again = await manager.stop(row, 'stop-native')
                result['exitConfirmed'] = again['exitConfirmed'] and not bridge.active
                if row.notice:
                    row.notice.cancel()
            if result.get('exitConfirmed'):
                temporary.cleanup()
            else:
                temporary._finalizer.detach()
            print(json.dumps(result))
    return 0 if all(result.get(key) for key in ('createIdempotent', 'inputAndDedupe', 'resize', 'controlCLeavesShellAlive',
        'boundedReconnectWithoutInputReplay', 'restartDoesNotAdoptOldPid', 'exitConfirmed')) else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true'); parser.add_argument('--host', type=Path)
    parser.add_argument('--shell', choices=['cmd', 'powershell', 'bash', 'sh'])
    args = parser.parse_args()
    if not args.run_native:
        parser.error('--run-native required')
    raise SystemExit(asyncio.run(probe(args.host, args.shell)))

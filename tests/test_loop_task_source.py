import asyncio
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.loop_task_source import (SourceError, TaskSourceReader, environment, command,
    normalize_snapshot, task_rows, scope_diff, snapshot_fresh, reconcile, validate_source, run_query)
from src.backend.loop_store import LoopState
from tests.test_loop_delivery import report


class Project:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.change = self.root / 'openspec/changes/test-change'
        self.change.mkdir(parents=True)
        (self.root / 'openspec/config.yaml').write_text('schema: spec-driven\n', encoding='utf-8')
        self.tasks = self.change / 'tasks.md'
        self.tasks.write_text('- [ ] 1.1 Build login shell and verify behavior\n- [ ] 1.2 Attributes and skills\n', encoding='utf-8')
        self.design = self.change / 'design.md'
        self.design.write_text('Acceptance conditions: login shell, attributes and skills.', encoding='utf-8')

    def payloads(self):
        rows = task_rows(self.root, self.tasks)
        return ({'changeRoot': str(self.change), 'schemaName': 'spec-driven'},
                {'state': 'all_done' if all(r['done'] for r in rows) else 'ready',
                 'tasks': [{'id': str(i + 1), 'description': row['description'], 'done': row['done']} for i, row in enumerate(rows)],
                 'contextFiles': {'tasks': [str(self.tasks)], 'design': [str(self.design)]}})

    def snapshot(self):
        return normalize_snapshot(self.root, 'test-change', *self.payloads(), '1.13.1')

    def binding(self):
        return {'executor': 'fixture-node', 'sessionId': 's', 'workspace': str(self.root),
                'backendId': 'b', 'environmentDigest': 'env', 'cli': 'fixture-cli'}


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Project(self.temp.name)

    def test_positional_ids_and_rich_locations_match_real_source(self):
        p = self.project
        snap = p.snapshot()
        self.assertEqual([t['id'] for t in snap['tasks']], ['1.1', '1.2'])
        status, apply = p.payloads()
        for task, row in zip(apply['tasks'], snap['tasks']):
            task.update(sourcePath=row['sourcePath'], line=row['line'])
        self.assertEqual(normalize_snapshot(p.root, 'test-change', status, apply, '1.13.1')['tasks'], snap['tasks'])
        apply['tasks'][0]['line'] += 1
        with self.assertRaises(SourceError):
            normalize_snapshot(p.root, 'test-change', status, apply, '1.13.1')

    def test_checkbox_whitespace_fence_and_scope(self):
        p = self.project
        initial = p.snapshot()
        p.tasks.write_text('```md\n- [x] 8.8 not a task\n```\n\n* [X] 1.1   Build login shell and verify behavior\n- [ ] 1.2 Attributes and skills\n', encoding='utf-8')
        changed = p.snapshot()
        self.assertEqual(changed['scopeDigest'], initial['scopeDigest'])
        self.assertNotEqual(changed['stateDigest'], initial['stateDigest'])
        self.assertFalse(snapshot_fresh(initial))
        self.assertTrue(snapshot_fresh(changed))
        p.tasks.write_text('- [ ] 1.2 Attributes and skills\n- [x] 1.1 Build login shell and verify behavior\n', encoding='utf-8')
        self.assertEqual(p.snapshot()['scopeDigest'], initial['scopeDigest'])
        p.tasks.write_text('- [ ] 1.3 A semantic replacement\n', encoding='utf-8')
        difference = scope_diff(changed, p.snapshot())
        self.assertEqual(difference['removed'], ['1.1', '1.2'])
        self.assertEqual(difference['added'], ['1.3'])

    def test_invalid_protocol_ids_duplicate_ambiguous_and_paths(self):
        p = self.project
        status, apply = p.payloads()
        for mutate in [lambda a: a.update(tasks=None), lambda a: a.update(state='new-state'),
                       lambda a: a['tasks'][0].update(done='false'),
                       lambda a: a['tasks'].pop(), lambda a: a['tasks'][0].update(description='different')]:
            obj = copy.deepcopy(apply)
            mutate(obj)
            with self.assertRaises(SourceError):
                normalize_snapshot(p.root, 'test-change', status, obj, '1.13.1')
        for contents in ['- [ ] no stable number\n', '- [ ] 1.1 first\n- [x] 1.1 duplicate\n',
                         ''.join(f'- [ ] 1.{i} task\n' for i in range(101))]:
            p.tasks.write_text(contents, encoding='utf-8')
            with self.assertRaises(SourceError):
                p.snapshot()
        with self.assertRaises(SourceError):
            task_rows(p.root, '../outside.md')

    def test_multifile_ambiguity_and_artifact_semantics(self):
        p = self.project
        before = p.snapshot()
        p.design.write_text('Acceptance conditions changed.', encoding='utf-8')
        after = p.snapshot()
        self.assertNotEqual(before['scopeDigest'], after['scopeDigest'])
        self.assertTrue(scope_diff(before, after)['artifactsChanged'])
        second = p.change / 'tasks-extra.md'
        second.write_text('- [ ] 1.1 Duplicate task in another file\n', encoding='utf-8')
        status, apply = p.payloads()
        apply['contextFiles']['tasks'].append(str(second))
        with self.assertRaises(SourceError) as ctx:
            normalize_snapshot(p.root, 'test-change', status, apply, '1.13.1')
        self.assertEqual(ctx.exception.code, 'duplicate_id')

    def test_reconciliation_never_accepts_checkboxes_alone(self):
        p = self.project
        snap = p.snapshot()
        candidate = report('verified', source='openspec/changes/test-change/tasks.md', items=[dict(id=t['id'], status='verified', evidence='tested') for t in snap['tasks']])
        self.assertEqual(reconcile(snap, candidate)['uncheckedVerified'], ['1.1', '1.2'])
        self.assertTrue(reconcile(snap, candidate)['mappingValid'])
        self.assertFalse(reconcile(snap, candidate)['valid'])
        manual = copy.deepcopy(candidate)
        for item in manual['items']:
            item.update(status='manual', manualBasis='User explicitly requests device acceptance')
        self.assertTrue(reconcile(snap, manual)['valid'])
        candidate['items'].pop()
        self.assertEqual(reconcile(snap, candidate)['missing'], ['1.2'])
        self.assertFalse(reconcile(snap, candidate)['mappingValid'])
        self.assertEqual(p.tasks.read_text(encoding='utf-8').count('[ ]'), 2)
        candidate['valid'] = False
        self.assertFalse(reconcile(snap, candidate)['valid'])

    def test_environment_local_priority_backend_path_and_restrictions(self):
        p = self.project
        config = SimpleNamespace(id='b', env={'PATH': ''}, type='codex-office')
        session = SimpleNamespace(id='s', working_dir=str(p.root), codex_connection_mode='')
        with self.assertRaises(SourceError):
            environment(session, config, 'node')
        local = p.root / 'node_modules/.bin' / ('openspec.cmd' if os.name == 'nt' else 'openspec')
        local.parent.mkdir(parents=True)
        local.write_text('fixture', encoding='utf-8')
        binding, env = environment(session, config, 'node')
        self.assertEqual(binding['cli'], str(local))
        self.assertEqual(env['PATH'], '')
        self.assertNotIn('PATH', binding)
        session.codex_connection_mode = 'ssh'
        with self.assertRaises(SourceError):
            environment(session, config, 'node')
        session.codex_connection_mode = ''
        (p.root / 'openspec/config.yaml').write_text('store: external\n', encoding='utf-8')
        with self.assertRaises(SourceError):
            environment(session, config, 'node')
        session.working_dir = str(p.root / 'child')
        with self.assertRaises(SourceError):
            environment(session, config, 'node')

    def test_argv_and_bounded_persistence(self):
        for args in [['init'], ['instructions', 'apply', '--change', 'x & bad', '--json'], ['status', '--change', '../x', '--json']]:
            with self.assertRaises(SourceError):
                command('openspec.cmd', args)
        self.assertTrue(command('C:/Program Files/openspec.cmd', ['list', '--json']))
        snap = self.project.snapshot()
        source = {'version': 1, 'status': 'current', 'revision': 1, 'binding': {**self.project.binding(), 'change': 'test-change'}, 'snapshot': snap}
        state = LoopState('s', task_source=source)
        self.assertEqual(LoopState.from_dict(state.to_dict()).task_source, source)
        bad = copy.deepcopy(source)
        bad['snapshot']['tasks'].append(bad['snapshot']['tasks'][0])
        self.assertEqual(validate_source(bad)['status'], 'invalid')
        self.assertEqual(validate_source({'huge': 'x' * 3_145_729})['status'], 'invalid')


class ReaderTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(shutil.which('openspec.cmd' if os.name == 'nt' else 'openspec'), 'OpenSpec CLI not installed')
    async def test_installed_cli_readonly_contract_isolated_home(self):
        with tempfile.TemporaryDirectory(prefix='loop-contract-') as temp:
            root = Path(temp) / 'project & spaces'
            home = Path(temp) / 'isolated-home'
            home.mkdir()
            p = Project(root)
            (p.change / '.openspec.yaml').write_text('schema: spec-driven\ncreated: 2026-10-06\n', encoding='utf-8')
            (p.change / 'proposal.md').write_text('## Why\nFixture.\n## What Changes\nFixture.\n## Capabilities\n### New Capabilities\n- `fixture`: fixture\n## Impact\nFixture.\n', encoding='utf-8')
            spec = p.change / 'specs/fixture/spec.md'
            spec.parent.mkdir(parents=True)
            spec.write_text('## ADDED Requirements\n### Requirement: Fixture\nThe system SHALL work.\n#### Scenario: Fixture\n- **WHEN** tested\n- **THEN** works\n', encoding='utf-8')
            env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home), 'APPDATA': str(home / 'appdata'),
                   'LOCALAPPDATA': str(home / 'local'), 'XDG_CONFIG_HOME': str(home / 'config'), 'XDG_DATA_HOME': str(home / 'data'),
                   'OPENSPEC_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'CI': '1'}
            cli = shutil.which('openspec.cmd' if os.name == 'nt' else 'openspec')
            before = {str(f.relative_to(root)): f.read_bytes() for f in root.rglob('*') if f.is_file()}
            binding = {**p.binding(), 'cli': cli}
            result = await TaskSourceReader().read(binding, env, 'contract', 1, 'test-change')
            self.assertTrue(result['valid'])
            self.assertRegex(result['cliVersion'], r'^\d+\.\d+\.\d+')
            self.assertEqual([t['id'] for t in result['tasks']], ['1.1', '1.2'])
            self.assertEqual(result['cliState'], 'ready')
            self.assertEqual(before, {str(f.relative_to(root)): f.read_bytes() for f in root.rglob('*') if f.is_file()})

    async def test_coalesces_boundary_and_transient_retry_is_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            p = Project(root)
            calls = []
            async def runner(cli, args, cwd, env):
                calls.append(args)
                await asyncio.sleep(.001)
                self.assertEqual(cwd, p.root)
                if args == ['--version']:
                    return '1.13.1\n'
                if args == ['list', '--json']:
                    return json.dumps({'root': {'path': str(p.root)}, 'changes': [{'name': 'test-change'}]})
                return json.dumps(p.payloads()[0 if args[0] == 'status' else 1])
            reader = TaskSourceReader(runner)
            a, b = await asyncio.gather(*(reader.read(p.binding(), {}, 'prepare', 1, 'test-change') for _ in range(2)))
            self.assertEqual(a, b)
            self.assertEqual(len(calls), 4)
            await reader.read(p.binding(), {}, 'prepare', 1, 'test-change')
            self.assertEqual(len(calls), 4)
            p.tasks.write_text(p.tasks.read_text(encoding='utf-8').replace('[ ]', '[x]', 1), encoding='utf-8')
            await reader.read(p.binding(), {}, 'prepare', 1, 'test-change')
            self.assertEqual(len(calls), 8)
            a, b = await asyncio.gather(*(reader.read(p.binding(), {}, 'prepare', 1, 'test-change', force=True) for _ in range(2)))
            self.assertEqual(a, b)
            self.assertEqual(len(calls), 12)
            await reader.read(p.binding(), {}, 'prepare', 1, 'test-change')
            self.assertEqual(len(calls), 12)
            calls.clear()
            async def unavailable(*args):
                calls.append(args)
                raise SourceError('timeout', 'timeout', transient=True)
            with self.assertRaises(SourceError):
                await TaskSourceReader(unavailable).read(p.binding(), {}, 'prepare', 1, 'test-change')
            self.assertEqual(len(calls), 2)
            calls.clear()
            async def invalid(*args):
                calls.append(args)
                return 'unsupported'
            with self.assertRaises(SourceError):
                await TaskSourceReader(invalid).read(p.binding(), {}, 'prepare', 1, 'test-change')
            self.assertEqual(len(calls), 1)

    async def test_real_process_timeout_overflow_and_exit(self):
        # A tiny isolated Python fixture exercises actual process pipes and cancellation.
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / 'fake.py'
            script.write_text('import sys,time\nprint("x"*int(sys.argv[1]),flush=True)\ntime.sleep(float(sys.argv[2]))\n', encoding='utf-8')
            with patch('src.backend.loop_task_source.command', return_value=[sys.executable, str(script), '1048600', '0']):
                with self.assertRaises(SourceError) as ctx:
                    await run_query('fixture', [], Path(root), dict(os.environ))
                self.assertEqual(ctx.exception.code, 'output_limit')
            with patch('src.backend.loop_task_source.command', return_value=[sys.executable, str(script), '0', '5']), patch('src.backend.loop_task_source.PROCESS_TIMEOUT', .05):
                with self.assertRaises(SourceError) as ctx:
                    await run_query('fixture', [], Path(root), dict(os.environ))
                self.assertEqual(ctx.exception.code, 'timeout')


if __name__ == '__main__':
    unittest.main()

import asyncio
import io
import json
import threading
import unittest
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.workspace_search import SearchBudget, _git_read, git_comparison, search_workspace
from tests.engine_workbench_fixtures import EngineFixture


class WorkspaceSearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._sync_ignore_patterns = lambda: ['node_modules', '*.log']

    async def asyncSetUp(self):
        self.token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.identity = self.bridge._workbench_identity(self.session.id)
        self.encoded = json.dumps(self.identity.to_dict())

    async def asyncTearDown(self):
        await asyncio.gather(*getattr(self.bridge, '_workspace_search_tasks', set()).copy(), return_exceptions=True)
        _REQUEST_OWNER_ID.reset(self.token)

    async def search(self, mode='files', query='', limit=200, identity=None, rid='search-1'):
        return json.loads(await self.bridge._rpc_workspaceSearch(self.session.id,
            identity or self.encoded, rid, mode, query, limit))

    def file(self, path, text='needle'):
        return self.fixture.write_project_file(path, text)

    async def test_nested_gitignore_negation_and_application_rules(self):
        self.file('.gitignore', '*.tmp\n!keep.tmp\n/private.txt\nignored/\n')
        self.file('sub/.gitignore', '*.py\n!keep.py\n')
        for path in ('one.tmp', 'keep.tmp', 'private.txt', 'sub/private.txt', 'sub/a.py',
                     'sub/keep.py', 'node_modules/a.js', 'one.log', 'ignored/hide.py', '.git/config'):
            self.file(path)
        result = await self.search()
        self.assertEqual(result['status'], 'ok')
        paths = {row['relativePath'] for row in result['results']}
        self.assertEqual(paths - {'.gitignore', 'sub/.gitignore'}, {'keep.tmp', 'sub/private.txt', 'sub/keep.py'})
        self.assertFalse(result['truncated'])

    async def test_content_search_has_exact_version_utf16_locations_and_limits(self):
        self.file('a.py', '🙂 needle\nneedle\nneedle\n')
        result = await self.search('content', 'needle', 2)
        self.assertEqual(len(result['results']), 2)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['results'][0]['column'], 4)
        self.assertEqual(result['results'][0]['line'], 1)
        self.assertEqual(len(result['results'][0]['version']['sha256']), 64)
        self.assertEqual((await self.search(limit=501))['reasonCode'], 'invalid_request')
        self.assertEqual((await self.search('content', ''))['reasonCode'], 'invalid_request')

    async def test_no_regex_execution_and_binary_or_large_files_skipped(self):
        self.file('literal.txt', '(a+)+$')
        self.file('large.txt', 'a' * 100)
        self.file('binary.txt', 'needle\0')
        with patch('src.backend.workspace_search.MAX_FILE_BYTES', 50):
            result = await self.search('content', '(a+)+$')
        self.assertEqual([row['relativePath'] for row in result['results']], ['literal.txt'])
        self.assertEqual(result['skippedFiles'], 2)

    async def test_scan_and_byte_budgets_are_reported_not_silently_complete(self):
        for index in range(5):
            self.file(f'{index}.py', 'needle')
        with patch('src.backend.workspace_search.MAX_ENTRIES', 2):
            result = await self.search()
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['results']), 2)
        with patch('src.backend.workspace_search.MAX_SEARCH_BYTES', 7):
            result = await self.search('content', 'needle')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['results']), 1)

    async def test_unreadable_ignore_rules_fail_closed(self):
        self.file('.gitignore', '*.py\0')
        self.file('private.py')
        result = await self.search()
        self.assertEqual(result['reasonCode'], 'ignore_unreadable')
        self.assertNotIn('results', result)

    async def test_wrong_identity_and_user_are_rejected(self):
        self.assertEqual((await self.search(identity='{}'))['reasonCode'], 'stale_workspace')
        token = _REQUEST_OWNER_ID.set('other-user')
        try:
            with self.assertRaises(PermissionError):
                await self.search()
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_cancellation_keeps_owned_slot_until_worker_stops(self):
        self.file('a.py')
        entered, finish = threading.Event(), threading.Event()
        def slow(*args):
            entered.set()
            finish.wait(3)
            return search_workspace(*args)
        with patch('src.backend.workspace_search_bridge.search_workspace', side_effect=slow):
            request = asyncio.create_task(self.search())
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            duplicate = await self.search()
            self.assertEqual(duplicate['reasonCode'], 'search_in_progress')
            cancel = json.loads(self.bridge._rpc_workspaceSearchCancel(self.session.id, self.encoded, 'search-1'))
            self.assertTrue(cancel['cancelRequested'])
            self.assertEqual(len(self.bridge._workspace_searches), 1)
            finish.set()
            self.assertEqual((await request)['reasonCode'], 'search_cancelled')
        self.assertEqual(len(self.bridge._workspace_searches), 0)

    async def test_late_result_never_returns_previous_workspace_data(self):
        self.file('a.py')
        entered, finish = threading.Event(), threading.Event()
        def slow(*args):
            result = search_workspace(*args)
            entered.set()
            finish.wait(3)
            return result
        with patch('src.backend.workspace_search_bridge.search_workspace', side_effect=slow):
            request = asyncio.create_task(self.search())
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            self.session.working_dir = str(self.fixture.home)
            finish.set()
            result = await request
        self.assertEqual(result['reasonCode'], 'stale_workspace')
        self.assertNotIn('results', result)

    def test_git_comparison_uses_fixed_object_reads_no_write_or_diff(self):
        self.file('a.py', 'new\n')
        commit, blob = 'a' * 40, 'b' * 40
        def fake(root, args, budget):
            if args[0] == 'rev-parse':
                return commit.encode()
            if args[0] == 'ls-tree':
                return f'100644 blob {blob}\ta.py\0'.encode()
            self.assertEqual(args, ['cat-file', 'blob', blob])
            return b'old\n'
        with patch('src.backend.workspace_search._git_read', side_effect=fake) as git:
            result = git_comparison(self.identity, 'a.py', threading.Event())
        self.assertEqual([call.args[1][0] for call in git.call_args_list], ['rev-parse', 'ls-tree', 'cat-file'])
        self.assertEqual(result['baseline']['text'], 'old\n')
        self.assertEqual(result['disk']['text'], 'new\n')
        self.assertEqual((self.fixture.workspace / 'a.py').read_text(), 'new\n')

    def test_git_rejects_paths_symlink_objects_and_nonblob_modes(self):
        with patch('src.backend.workspace_search._git_read') as git:
            for relative in ('../home/private', 'C:/private', '.git/config'):
                with self.assertRaises(WorkbenchError):
                    git_comparison(self.identity, relative, threading.Event())
            git.assert_not_called()
        responses = [b'a' * 40, b'120000 blob ' + b'b' * 40 + b'\ta.py\0']
        with patch('src.backend.workspace_search._git_read', side_effect=responses):
            with self.assertRaisesRegex(WorkbenchError, 'git_nontext_entry'):
                git_comparison(self.identity, 'a.py', threading.Event())

    def test_git_command_is_hardened_and_output_bounded(self):
        self.file('.git/HEAD', 'ref: refs/heads/main')
        class Process:
            returncode = 0
            stdout = io.BytesIO(b'x' * 100)
            def poll(self): return 0
            def wait(self, timeout=None): return 0
        with patch('src.backend.workspace_search.shutil.which', return_value='C:/tools/git.exe'), \
                patch('src.backend.workspace_search.subprocess.Popen', return_value=Process()) as spawn, \
                patch('src.backend.workspace_search.MAX_GIT_BYTES', 50):
            with self.assertRaisesRegex(WorkbenchError, 'git_output_limit'):
                _git_read(self.identity.workingDir, ['cat-file', 'blob', 'b' * 40], SearchBudget(threading.Event()))
        args = spawn.call_args.args[0]
        self.assertIn('protocol.allow=never', args)
        self.assertIn('core.fsmonitor=false', args)
        self.assertIn('--no-replace-objects', args)
        self.assertNotIn('GIT_DIR', spawn.call_args.kwargs['env'])
        self.assertFalse(spawn.call_args.kwargs.get('shell', False))
        with self.assertRaisesRegex(WorkbenchError, 'git_operation_denied'):
            _git_read(self.identity.workingDir, ['commit'], SearchBudget(threading.Event()))


if __name__ == '__main__':
    unittest.main()

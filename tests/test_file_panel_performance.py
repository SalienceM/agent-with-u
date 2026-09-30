import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID, _REQUEST_CLIENT
from src.backend.git_status import parse_worktree_status


class GitTreeReadTests(unittest.TestCase):
    def test_nul_status_preserves_paths_renames_conflicts_and_branch(self):
        raw = '\0'.join([
            '# branch.head main', '# branch.upstream origin/main', '# branch.ab +12 -3',
            '1 .M N... 100644 100644 100644 abc abc 中文 空格.txt',
            '2 R. N... 100644 100644 100644 abc abc R100 new -> file.txt', 'old\nname.txt',
            'u DD N... 100644 100644 100644 100644 abc abc abc conflict.txt',
            '? new\nfile.txt', '',
        ])
        result = parse_worktree_status(raw, BridgeWS._xy_to_status)
        self.assertEqual((result['branch'], result['ahead'], result['behind']), ('main', 12, 3))
        self.assertEqual([f['path'] for f in result['files']],
                         ['中文 空格.txt', 'new -> file.txt', 'conflict.txt', 'new\nfile.txt'])
        self.assertEqual([f['status'] for f in result['files']], ['modified', 'renamed', 'conflicted', 'untracked'])
        self.assertEqual(result['stagedCount'], 2)

    def test_lightweight_reads_skip_repeated_status_and_diff(self):
        bridge = BridgeWS.__new__(BridgeWS)
        with tempfile.TemporaryDirectory() as root, patch('src.backend.bridge_ws._git_is_repo', return_value=True):
            bridge._git_run = Mock(return_value=(0, '# branch.head main\0? added.txt\0', ''))
            self.assertTrue(json.loads(bridge._rpc_gitDetect(root, True))['isRepo'])
            bridge._git_run.assert_not_called()
            result = json.loads(bridge._rpc_gitStatus(root, False))
            self.assertEqual(result['totalChanges'], 1)
            bridge._git_run.assert_called_once()
            self.assertIn('--no-optional-locks', bridge._git_run.call_args.args[1])
            bridge._git_run.reset_mock()
            bridge._git_run.return_value = (1, '', 'test git failure')
            self.assertIn('error', json.loads(bridge._rpc_gitStatus(root, False)))

    def test_native_git_unborn_modified_and_rename(self):
        bridge = BridgeWS.__new__(BridgeWS)
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                return subprocess.run(['git', *args], cwd=root, capture_output=True, check=True)
            git('init')
            path = Path(root) / '中文 file.txt'
            path.write_text('first\n', encoding='utf-8')
            self.assertEqual(json.loads(bridge._rpc_gitStatus(root, False))['files'][0]['path'], path.name)
            git('add', '.')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
            git('mv', path.name, 'renamed space.txt')
            result = json.loads(bridge._rpc_gitStatus(root, False))
            self.assertEqual(result['files'][0], {'path': 'renamed space.txt', 'status': 'renamed', 'staged': True})
            (Path(root) / 'renamed space.txt').write_text('changed\n', encoding='utf-8')
            full = json.loads(bridge._rpc_gitStatus(root))
            self.assertEqual(full['files'][0]['addedLines'], 1)

    def test_directory_resolves_parent_once_not_every_normal_child(self):
        bridge = BridgeWS.__new__(BridgeWS)
        with tempfile.TemporaryDirectory() as root:
            for i in range(2000):
                (Path(root) / f'{i}.txt').touch()
            original = Path.resolve
            calls = []
            def resolve(path, *args, **kwargs):
                calls.append(path)
                return original(path, *args, **kwargs)
            with patch.object(Path, 'resolve', resolve):
                entries = json.loads(bridge._rpc_listDirectory('', root, True))
            self.assertEqual(len(entries), 2000)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(isinstance(entry['mtime'], int) for entry in entries))

    def test_directory_still_excludes_external_symlinks(self):
        bridge = BridgeWS.__new__(BridgeWS)
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            (Path(root) / 'inside').mkdir()
            try:
                os.symlink(outside, Path(root) / 'escape', target_is_directory=True)
                os.symlink(Path(root) / 'inside', Path(root) / 'alias', target_is_directory=True)
            except OSError as error:
                self.skipTest(f'Symlink unavailable: {error}')
            entries = json.loads(bridge._rpc_listDirectory('', root, True))
            self.assertNotIn('escape', [e['name'] for e in entries])
            self.assertEqual(next(e['path'] for e in entries if e['name'] == 'alias'), 'inside')
            self.assertIn('error', json.loads(bridge._rpc_listDirectory('escape', root, True)))


class Client:
    identity_src = 'relay'
    can_claim_legacy = False

    def __init__(self, identity):
        self.identity = identity
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self.incoming.get()
        if message is None:
            raise StopAsyncIteration
        return message

    async def send(self, raw):
        await self.outgoing.put(json.loads(raw))

    def request(self, id, method):
        self.incoming.put_nowait(json.dumps({'id': id, 'method': method, 'params': []}))


class FilePanelConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._clients = set()
        self.bridge._client_meta = {}
        self.bridge._owner_id_for_client = lambda client: client.identity
        self.bridge._emit_clients_changed = Mock()
        self.bridge._ensure_kit_scheduler = Mock()
        self.bridge._authorize_rpc = Mock()
        self.clients = []
        self.release = threading.Event()

    def client(self, identity):
        client = Client(identity)
        task = asyncio.create_task(self.bridge.handle_client(client))
        self.clients.append((client, task))
        return client, task

    async def asyncTearDown(self):
        self.release.set()
        for client, _ in self.clients:
            client.incoming.put_nowait(None)
        await asyncio.gather(*(task for _, task in self.clients))

    async def test_slow_git_does_not_block_directory_ping_or_other_identity_and_writes_stay_ordered(self):
        entered = threading.Event()
        def slow():
            entered.set()
            self.release.wait(3)
            return _REQUEST_OWNER_ID.get()
        self.bridge._rpc_gitStatus = slow
        self.bridge._rpc_listDirectory = lambda: (_REQUEST_OWNER_ID.get(), _REQUEST_CLIENT.get().identity)
        mutation = Mock(return_value='ok')
        self.bridge._rpc_testWrite = mutation
        alice, _ = self.client('alice')
        bob, _ = self.client('bob')
        alice.request(1, 'gitStatus')
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        alice.request(2, 'listDirectory')
        alice.request(3, 'ping')
        bob.request(4, 'listDirectory')
        replies = [await asyncio.wait_for(alice.outgoing.get(), .5) for _ in range(2)]
        self.assertEqual({r['id'] for r in replies}, {2, 3})
        self.assertEqual(next(r['result'] for r in replies if r['id'] == 2), ['alice', 'alice'])
        self.assertEqual((await asyncio.wait_for(bob.outgoing.get(), .5))['result'], ['bob', 'bob'])
        alice.request(5, 'testWrite')
        alice.request(6, 'listDirectory')
        await asyncio.sleep(.02)
        mutation.assert_not_called()
        self.release.set()
        replies = [await asyncio.wait_for(alice.outgoing.get(), 1) for _ in range(3)]
        self.assertEqual([r['id'] for r in replies], [1, 5, 6])
        self.assertEqual(replies[0]['result'], 'alice')
        self.assertEqual(self.bridge._authorize_rpc.call_count, 6)

    async def test_disconnect_cancels_read_reply_without_waiting_for_slow_thread(self):
        entered = threading.Event()
        def slow():
            entered.set()
            self.release.wait(3)
            return 'late'
        self.bridge._rpc_gitDetect = slow
        client, task = self.client('alice')
        client.request(1, 'gitDetect')
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        client.incoming.put_nowait(None)
        await asyncio.wait_for(task, .5)
        self.release.set()
        await asyncio.sleep(.02)
        self.assertTrue(client.outgoing.empty())

    async def test_concurrent_reads_still_authorize_before_entering_the_worker(self):
        self.bridge._authorize_rpc = Mock(side_effect=PermissionError('denied'))
        handler = Mock(return_value='private files')
        self.bridge._rpc_listDirectory = handler
        client, _ = self.client('untrusted')
        client.request(1, 'listDirectory')
        reply = await asyncio.wait_for(client.outgoing.get(), .5)
        self.assertEqual(reply['error'], 'denied')
        handler.assert_not_called()

    async def test_read_concurrency_is_bounded(self):
        entered = threading.Event()
        lock = threading.Lock()
        count = 0
        maximum = 0
        def slow():
            nonlocal count, maximum
            with lock:
                count += 1
                maximum = max(maximum, count)
                if count == 16:
                    entered.set()
            self.release.wait(3)
            with lock:
                count -= 1
            return 'ok'
        self.bridge._rpc_listDirectory = slow
        client, _ = self.client('alice')
        for id in range(24):
            client.request(id, 'listDirectory')
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        self.release.set()
        replies = [await asyncio.wait_for(client.outgoing.get(), 1) for _ in range(24)]
        self.assertEqual(len({r['id'] for r in replies}), 24)
        self.assertEqual(maximum, 16)


if __name__ == '__main__':
    unittest.main()

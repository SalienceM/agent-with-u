import asyncio
import os
from pathlib import Path
import socket
import subprocess
import unittest
from unittest.mock import patch

from tests.engine_workbench_fixtures import EngineFixture, FakeEngineBackend, FakeLanguageServer, FakePty
from src.backend import paths


class EngineFixtureEventLoopTests(unittest.TestCase):
    def test_guard_allows_only_event_loop_self_pipe(self):
        with EngineFixture():
            loop = asyncio.new_event_loop()
            try:
                self.assertEqual(loop.run_until_complete(asyncio.sleep(0, result=42)), 42)
                with socket.socket() as connection, self.assertRaisesRegex(RuntimeError, 'forbids'):
                    connection.connect(('127.0.0.1', 44321))
            finally:
                loop.close()


class EngineFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def test_isolated_paths_and_credentials(self):
        original_home = Path.home()
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic-do-not-inherit'}):
            with EngineFixture() as fixture:
                self.assertEqual(paths.data_root(), fixture.data)
                self.assertEqual(Path.home(), fixture.home)
                self.assertNotIn('OPENAI_API_KEY', os.environ)
                for unsafe in (original_home, original_home / '.agent-with-u', fixture.root,
                               fixture.workspace / '../../outside'):
                    with self.subTest(path=unsafe), self.assertRaises(ValueError):
                        fixture.require_path(unsafe)
                path = fixture.write_project_file('src/main.py', 'answer = 42\n')
                self.assertEqual(path.read_text(encoding='utf-8'), 'answer = 42\n')
                with self.assertRaises(ValueError):
                    fixture.write_project_file('../data/not-a-project-file', 'bad')
                root = fixture.root
            self.assertFalse(root.exists())
            self.assertEqual(os.environ['OPENAI_API_KEY'], 'synthetic-do-not-inherit')

    async def test_real_network_and_processes_are_denied(self):
        with EngineFixture():
            with self.assertRaisesRegex(RuntimeError, 'forbids'):
                socket.create_connection(('127.0.0.1', 44321))
            with socket.socket() as connection:
                with self.assertRaisesRegex(RuntimeError, 'forbids'):
                    connection.connect(('127.0.0.1', 44322))
            with self.assertRaisesRegex(RuntimeError, 'forbids'):
                subprocess.Popen(['never-launch-a-model'])

    async def test_fixture_rejects_production_sessions_and_changed_workspace(self):
        with EngineFixture() as fixture:
            backend = FakeEngineBackend(fixture)
            with self.assertRaises(ValueError):
                await backend.send_message([], '', None, 'production-session', 'm', lambda _: None)
            session = fixture.session()
            session.working_dir = str(fixture.workspace.parent)
            with self.assertRaises(ValueError):
                fixture.require_session(session.id)
            self.assertEqual(backend.calls, 0)

    async def test_backend_streams_synthetic_events_without_provider(self):
        with EngineFixture() as fixture:
            session = fixture.session()
            backend = FakeEngineBackend(fixture, ('one', 'two'))
            events = []
            await backend.send_message([], 'fixture', None, session.id, 'm', events.append)
            self.assertEqual([event.type for event in events], ['text_delta', 'text_delta', 'done'])
            self.assertEqual([event.text for event in events[:-1]], ['one', 'two'])
            self.assertEqual(backend.calls, 1)
            backend.abort(session.id)
            self.assertEqual((await backend.send_message([], '', None, session.id, 'm2', events.append))['status'], 'cancelled')

    async def test_language_replies_can_be_out_of_order_cancelled_or_crash(self):
        with EngineFixture() as fixture:
            server = FakeLanguageServer(fixture, fixture.session())
            first = asyncio.create_task(server.request('first', {'version': 1}))
            second = asyncio.create_task(server.request('second', {'version': 2}))
            await asyncio.sleep(0)
            server.reply(2, {'version': 2})
            self.assertEqual(await second, {'version': 2})
            self.assertFalse(first.done())
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            failed = asyncio.create_task(server.request('third', {}))
            await asyncio.sleep(0)
            server.crash()
            with self.assertRaisesRegex(RuntimeError, 'Injected'):
                await failed
            self.assertEqual(server.pending, {})

    async def test_terminal_stop_does_not_fabricate_exit(self):
        with EngineFixture() as fixture:
            terminal = FakePty(fixture, fixture.session())
            terminal.write(b'fixed input')
            terminal.resize(100, 30)
            terminal.emit(b'first')
            terminal.emit(b'second')
            terminal.stop()
            self.assertFalse(terminal.exit_confirmed)
            with self.assertRaises(RuntimeError):
                terminal.write(b'late')
            terminal.confirm_exit()
            self.assertTrue(terminal.exit_confirmed)
            self.assertEqual(terminal.size, (100, 30))
            self.assertEqual(terminal.outputs, [(1, b'first'), (2, b'second')])

    async def test_session_store_is_owned_and_cleaned_before_root(self):
        with EngineFixture() as fixture:
            store = fixture.session_store()
            session = fixture.session()
            store.save(session, async_=False)
            self.assertEqual(store.load(session.id).owner_id, session.owner_id)
            self.assertTrue(fixture.data in store._session_path(session.id).parents)
        self.assertFalse(store._io_thread.is_alive())


if __name__ == '__main__':
    unittest.main()

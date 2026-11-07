import asyncio
from pathlib import Path
import tempfile
import unittest

from src.backend.session_collaboration_store import CollaborationStore, CollaborationScope, CollaborationError
from src.backend.user_interactions import UserInteractionRegistry, UserInteractionRequest


class InteractionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CollaborationStore(Path(self.temp.name) / 's.db')
        self.scope = CollaborationScope('owner', 'node')
        self.events = []
        self.registry = UserInteractionRegistry(self.store, self.events.append)

    def question(self, native='n', **kwargs):
        return UserInteractionRequest('s', 'm', native, questions=[{'id': 'q', 'question': '选择', 'options': [
            {'label': 'A', 'description': 'a'}, {'label': 'B', 'description': 'b'}]}], **kwargs)

    async def wait_pending(self, count=1):
        for _ in range(200):
            if len(self.registry.pending) >= count: return
            await asyncio.sleep(.01)
        self.fail('pending 未出现')

    async def test_answer_bound_to_request_and_transport_receipt(self):
        request = self.question()
        task = asyncio.create_task(self.registry.ask(self.scope, request, skip=True))
        await self.wait_pending()
        row = self.events[-1]
        self.assertIn('仍需回答', row['notice'])
        with self.assertRaises(CollaborationError):
            await self.registry.respond(self.scope, 's', row['id'], {'kind': 'answers', 'answers': {'q': []}})
        with self.assertRaises(PermissionError):
            await self.registry.respond(self.scope, 'wrong', row['id'], {'kind': 'cancelled'})
        await self.registry.respond(self.scope, 's', row['id'], {'kind': 'answers', 'answers': {'q': ['B']}})
        self.assertEqual(await task, {'kind': 'answers', 'answers': {'q': ['B']}})
        self.assertEqual(self.events[-1]['status'], 'responding')
        await request.delivered(True)
        self.assertEqual(self.events[-1]['status'], 'answered')
        self.assertEqual(self.events[-1]['receiptLevel'], 'transport_write')

    async def test_multiple_requests_and_two_controller_race(self):
        tasks = [asyncio.create_task(self.registry.ask(self.scope, self.question(str(i)))) for i in range(2)]
        await self.wait_pending(2)
        keys = list(self.registry.pending)
        results = await asyncio.gather(*[self.registry.respond(self.scope, 's', keys[0], {'kind': 'answers', 'answers': {'q': [v]}})
                                         for v in ['A', 'B']], return_exceptions=True)
        self.assertEqual(sum(isinstance(r, CollaborationError) for r in results), 1)
        await self.registry.respond(self.scope, 's', keys[1], {'kind': 'cancelled'})
        self.assertEqual((await tasks[0])['answers'], {'q': ['A']})
        self.assertEqual((await tasks[1])['kind'], 'cancelled')

    async def test_skip_is_protocol_capability_not_recommended_option(self):
        request = self.question(skip_response={'skipped': True})
        self.assertEqual(await self.registry.ask(self.scope, request, skip=True), {'kind': 'skipped'})
        await request.delivered(True)
        self.assertEqual(self.events[-1]['status'], 'auto_handled')
        self.assertEqual(self.events[-1]['answers'], {})
        approval = UserInteractionRequest('s', 'm', 'approval', kind='approval')
        self.assertTrue((await self.registry.ask(self.scope, approval, skip=True))['approved'])

    async def test_secret_not_saved_and_unknown_not_replayed(self):
        request = self.question()
        request.questions = [{'id': 'password', 'question': '保密输入', 'isSecret': True}]
        task = asyncio.create_task(self.registry.ask(self.scope, request))
        await self.wait_pending()
        key = next(iter(self.registry.pending))
        await self.registry.respond(self.scope, 's', key, {'kind': 'answers', 'answers': {'password': ['secret-value']}})
        await task
        await request.delivered(False)
        row = self.store.read(self.scope, 'interaction', key)
        self.assertNotIn('secret-value', str(row))
        self.assertEqual(row['status'], 'unknown')
        with self.assertRaises(CollaborationError):
            await self.registry.ask(self.scope, request)

    async def test_cancellation_settles_only_own_waiter(self):
        stop = False
        task = asyncio.create_task(self.registry.ask(self.scope, self.question(cancelled=lambda: stop)))
        await self.wait_pending()
        stop = True
        self.assertEqual((await task)['kind'], 'cancelled')
        self.assertEqual(self.events[-1]['status'], 'cancelled')

    async def test_deadline_and_restart_never_resume_old_request(self):
        task = asyncio.create_task(self.registry.ask(self.scope, self.question(timeout=1)))
        await self.wait_pending()
        key = next(iter(self.registry.pending))
        restarted = UserInteractionRegistry(self.store, lambda _: None)
        stale = await restarted.respond(self.scope, 's', key, {'kind': 'answers', 'answers': {'q': ['A']}})
        self.assertEqual(stale['status'], 'interrupted')
        self.assertFalse(task.done())
        self.assertEqual((await task)['reason'], 'expired')
        self.assertEqual(self.events[-1]['status'], 'expired')

    async def test_legacy_bool_adapter_uses_typed_approval_and_visible_receipt(self):
        from src.backend.session_collaboration_bridge import SessionCollaborationBridge
        from src.backend.base import PermissionRequest
        bridge = SessionCollaborationBridge()
        bridge._await_user_interaction = lambda request: self.registry.ask(self.scope, request, skip=True)
        bridge._has_interaction_client = lambda: True
        granted = await bridge._await_bool_interaction(PermissionRequest('s', 'm', 'tool', 'Bash', 'echo test'), lambda: False)
        self.assertTrue(granted)
        self.assertEqual(self.events[-1]['status'], 'auto_handled')
        self.assertTrue(self.events[-1]['approved'])
        self.assertEqual(self.events[-1]['receiptLevel'], 'callback_return')

    async def test_only_app_question_skip_can_continue_and_product_confirmation_cannot_enter(self):
        from src.backend.api_user_questions import ApiQuestionTool
        import json
        tool = ApiQuestionTool('s', 'm', lambda request: self.registry.ask(self.scope, request, skip=True), lambda: False)
        result = await tool.execute('question-call', {'questions': [{'id': 'name', 'question': 'Name?', 'required': True}]})
        self.assertEqual(json.loads(result), {'status': 'skipped'})
        self.assertEqual(self.events[-1]['status'], 'auto_handled')
        self.assertEqual(self.events[-1]['answers'], {})
        for kind in ['kit', 'install', 'workspace']:
            with self.assertRaises(CollaborationError):
                await self.registry.ask(self.scope, UserInteractionRequest('s', 'm', kind, kind=kind), skip=True)

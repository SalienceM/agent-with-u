import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch


class ComposerSubmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from tests.test_chat_kits import ChatKitTests
        ChatKitTests.setUp(self)
        self.bridge._async_send = AsyncMock()
        self.bridge._prepare_session_skills = AsyncMock()
        self.payload = {'version': 1, 'requestId': 'input-1', 'sessionId': self.session.id, 'backendId': 'fake',
                        'messageId': 'answer-1', 'userMessageId': 'user-1', 'draftRevision': 7, 'content': 'my original input',
                        'textAttachments': [{'id': 'block', 'name': 'notes.txt', 'content': 'edited block', 'size': 12, 'source': 'file'}]}

    async def asyncTearDown(self):
        await asyncio.gather(*self.bridge._active_chat_turn_tasks(self.session.id), return_exceptions=True)
        from tests.test_chat_kits import ChatKitTests
        await ChatKitTests.asyncTearDown(self)

    def submit(self, queue=False):
        return json.loads(self.bridge._rpc_composerSubmit(self.session.id, json.dumps(self.payload), queue))

    def status(self):
        return json.loads(self.bridge._rpc_composerStatus(self.session.id, self.payload['requestId']))

    async def test_confirmed_persistence_and_retry_returns_original_without_duplicate(self):
        self.assertEqual(self.submit()['state'], 'preparing')
        await asyncio.gather(*self.bridge._active_chat_turn_tasks(self.session.id))
        receipt = self.status()
        self.assertEqual((receipt['state'], receipt['draftRevision']), ('accepted', 7))
        self.assertEqual(self.submit()['state'], 'accepted')
        self.bridge._async_send.assert_awaited_once()
        saved = self.bridge._session_store.load(self.session.id)
        user = next(item for item in saved.messages if item.id == 'user-1')
        self.assertEqual(user.text_attachments[0].content, 'edited block')
        self.payload['content'] = 'different'
        with self.assertRaisesRegex(ValueError, 'requestId'):
            self.submit()

    async def test_rejected_busy_keeps_original_revision_and_never_dispatches(self):
        with patch.object(self.bridge, '_check_chat_turn_allowed', side_effect=ValueError('busy')):
            self.assertEqual(self.submit()['state'], 'rejected')
        self.assertEqual(self.submit()['state'], 'rejected')
        self.bridge._async_send.assert_not_awaited()

    async def test_queue_commit_and_lost_final_receipt_reconcile_without_requeue(self):
        original = self.bridge._finish_composer_submission
        with patch.object(self.bridge, '_finish_composer_submission', side_effect=OSError('receipt write lost')):
            with self.assertRaises(OSError):
                self.submit(True)
        self.assertEqual(self.status()['state'], 'queued')
        self.assertEqual(self.submit(True)['state'], 'queued')
        self.assertEqual(len(self.bridge._chat_extras_get(self.session.id).seq_tasks), 1)
        self.bridge._async_send.assert_not_awaited()

    async def test_queue_cannot_inherit_opt_in_and_journal_contains_no_authorization(self):
        self.payload['kitApprovalDelegation'] = True
        self.assertEqual(self.submit(True)['state'], 'rejected')
        row = self.bridge._collaboration_store().request(self.bridge._collaboration_scope(self.session.id), 'input-1')
        self.assertNotIn('kitApprovalDelegation', json.dumps(row))
        self.assertNotIn('my original input', json.dumps(row))
        self.assertFalse(self.bridge._chat_extras_get(self.session.id).seq_tasks)

    async def test_restart_before_dispatch_is_unknown_and_does_not_replay(self):
        with patch.object(self.bridge, '_start_chat_turn'):
            self.assertEqual(self.submit()['state'], 'preparing')
        self.assertEqual(self.status()['state'], 'unknown')
        self.assertEqual(self.submit()['state'], 'unknown')
        self.bridge._async_send.assert_not_awaited()

    async def test_steer_submission_retains_draft_until_real_receipt_and_deduplicates(self):
        self.payload['deliveryMode'] = 'steer'
        started, release = asyncio.Event(), asyncio.Event()
        async def steer(*args):
            self.assertEqual(args[1], self.payload['content'])
            self.assertEqual(args[4], 'user-1')
            self.assertEqual(json.loads(args[3])[0]['content'], 'edited block')
            started.set()
            await release.wait()
            return json.dumps({'status': 'ok'})
        with patch.object(self.bridge, '_rpc_steerMessage', side_effect=steer) as method:
            self.assertEqual(self.submit()['state'], 'preparing')
            await started.wait()
            release.set()
            await asyncio.gather(*self.bridge._composer_steer_tasks)
            self.assertEqual(self.status()['state'], 'accepted')
            self.assertEqual(self.submit()['state'], 'accepted')
            method.assert_awaited_once()
        self.bridge._async_send.assert_not_awaited()

    async def test_late_and_unknown_steers_never_start_or_queue_a_turn(self):
        self.payload['deliveryMode'] = 'steer'
        for result, state in [('turn_finished', 'rejected'), ('unknown', 'unknown')]:
            self.payload['requestId'] = result
            with patch.object(self.bridge, '_rpc_steerMessage', return_value=json.dumps({'status': result})) as method:
                self.assertEqual(self.submit()['state'], 'preparing')
                await asyncio.gather(*self.bridge._composer_steer_tasks)
                self.assertEqual(self.status()['state'], state)
                self.assertEqual(self.submit()['state'], state)
                method.assert_awaited_once()
        self.assertFalse(self.bridge._chat_extras_get(self.session.id).seq_tasks)
        self.bridge._async_send.assert_not_awaited()

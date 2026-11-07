import unittest
from src.types import Session, ChatMessage, ThinkingBlock
from src.backend.session_collaboration_context import context_snapshot, opinion_reference, visible_text
from src.backend.session_collaboration_store import CollaborationError


class ContextTests(unittest.TestCase):
    def test_snapshot_freezes_visible_material_only(self):
        source = Session('s', 'test', 1, 1, [], '.', 'b')
        source.messages = [ChatMessage('u', 'user', '【当前 Session 的 Kit 调用工具】\nSECRET\n【用户本轮请求】\n实际问题'),
                           ChatMessage('a', 'assistant', '可见回答', thinking_blocks=[ThinkingBlock('hidden')]),
                           ChatMessage('tool', 'tool', '工具令牌'), ChatMessage('next', 'assistant', '未完成', streaming=True)]
        snapshot = context_snapshot(source)
        self.assertEqual(snapshot['targetMessageIds'], ['a'])
        self.assertEqual([m['text'] for m in snapshot['messages']], ['实际问题', '可见回答'])
        old = snapshot['fingerprint']
        source.messages[1].content = '改写回答'
        self.assertEqual(snapshot['messages'][1]['text'], '可见回答')
        self.assertNotEqual(context_snapshot(source)['fingerprint'], old)

    def test_bounds_and_invalid_targets(self):
        source = Session('s', 'test', 1, 1, [ChatMessage(str(i), 'assistant', str(i)) for i in range(30)], '.', 'b')
        result = context_snapshot(source, ['0', '29'])
        self.assertEqual(len(result['messages']), 20)
        self.assertEqual(result['omittedMessageCount'], 10)
        self.assertEqual(result['messages'][0]['id'], '0')
        source.messages[-1].content = 'x' * 64001
        with self.assertRaises(CollaborationError):
            context_snapshot(source)
        with self.assertRaises(CollaborationError):
            context_snapshot(source, ['missing'])
        self.assertEqual(visible_text('【AWU 应用操作工具】未完成封套'), '')

    def test_reference_is_immutable_and_bound_to_revision(self):
        report = {'id': 'r', 'revision': 2, 'status': 'done', 'claims': [{'id': 'c', 'reason': '异议'}]}
        ref = opinion_reference(report, ['c'])
        report['claims'][0]['reason'] = '变更'
        self.assertEqual(ref['claims'][0]['reason'], '异议')
        self.assertEqual(ref['reportRevision'], 2)
        with self.assertRaises(CollaborationError):
            opinion_reference(report, ['missing'])

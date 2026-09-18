import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatAside, ChatExtras
from src.backend.skill_manuals import SkillManuals, skill_references
from src.backend.skill_store import SkillStore
from src.types import Session


class SkillManualTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'demo').mkdir()
        (self.root / 'demo/SKILL.md').write_text('---\nname: demo\n---\nAgent instructions', encoding='utf-8')
        (self.root / 'demo/README.md').write_text('# Original usage\nDo not run this example.', encoding='utf-8')
        self.manuals = SkillManuals(self.root, threading.RLock(), {'demo': {'source': {'repository': 'fixture/repo'}}})

    def test_list_only_metadata_no_bodies_or_disk_writes(self):
        with patch.object(SkillManuals, '_read', side_effect=AssertionError('metadata only')):
            self.assertEqual(self.manuals.list(), [{'name': 'demo', 'hasManual': False}])
        self.assertFalse((self.root / '.manuals').exists())

    def test_original_fallback_edit_conflict_and_source_update(self):
        before = self.manuals.get('demo')
        self.assertEqual(before['originalPath'], 'README.md')
        self.assertFalse(before['hasManual'])
        saved = self.manuals.save('demo', '# Maintained\nHow to use', '')
        self.assertEqual(saved['originalContent'], before['originalContent'])
        self.assertNotEqual(saved['revision'], '')
        with self.assertRaisesRegex(ValueError, 'SKILL_MANUAL_CHANGED'):
            self.manuals.save('demo', 'stale write', '')
        (self.root / 'demo/README.md').write_text('new source', encoding='utf-8')
        changed = self.manuals.get('demo')
        self.assertEqual(changed['content'], saved['content'])
        self.assertTrue(changed['outdated'])
        self.assertEqual(self.manuals.get('demo', 'SKILL.md')['originalContent'], '---\nname: demo\n---\nAgent instructions')

    def test_maximum_size_roundtrip_and_bounded_reference(self):
        self.manuals.save('demo', '\n' * 127999 + 'x', '')
        self.assertEqual(len(self.manuals.get('demo')['content']), 128000)
        context = self.manuals.context(['demo'])
        self.assertIn('已截断', context)
        self.assertLess(len(context), 13000)
        with self.assertRaises(ValueError): self.manuals.save('demo', 'x' * 128001, '')

    def test_explicit_references_bounded_paths_and_missing(self):
        self.assertEqual(skill_references('问 @SKILL:demo，以及 @skill:other @SKILL:demo'), ['demo', 'other'])
        for question in ('@SKILL:../secret', '@SKILL:/root', '@SKILL:a @SKILL:b @SKILL:c @SKILL:d'):
            with self.assertRaises(ValueError): skill_references(question)
        with self.assertRaisesRegex(ValueError, 'SKILL_NOT_INSTALLED'): self.manuals.get('absent')
        with self.assertRaises(ValueError): self.manuals.get('demo', '../README.md')
        self.assertEqual(skill_references('普通问题'), [])

    def test_manual_survives_reinstall_and_follows_rename_delete(self):
        with patch('src.backend.skill_store.LIBRARY_DIR', self.root), patch('src.backend.skill_store.INDEX_FILE', self.root / 'index.json'):
            store = SkillStore()
            store.manuals().save('demo', 'keep my usage guide', '')
            store.install_standard_files({'SKILL.md': b'---\nname: demo\ndescription: new fixture\n---\nnew instructions'}, source={})
            self.assertEqual(store.manuals().get('demo')['content'], 'keep my usage guide')
            store.rename_skill('demo', 'renamed', '# Renamed')
            self.assertEqual(store.manuals().get('renamed')['content'], 'keep my usage guide')
            store.delete_skill('renamed')
            self.assertFalse((self.root / '.manuals/renamed.json').exists())

    def bridge(self, question='@SKILL:demo 怎么用'):
        bridge = BridgeWS.__new__(BridgeWS)
        session = Session(id='session', title='fixture', created_at=1, updated_at=1, messages=[], working_dir=str(self.root), backend_id='fixture')
        attention = bridge._skill_reference_attention(question, {})
        turn = ChatAside(id='turn', question=question, status='answering', context_key=attention['key'])
        extras = ChatExtras(session_id='session', asides=[turn])
        bridge._active_sessions = {'session': session}
        bridge._skill_store = SimpleNamespace(manuals=lambda: self.manuals)
        bridge._chat_extras_get = Mock(return_value=extras)
        bridge._chat_extras_save = Mock()
        bridge._emit_chat_aside_updated = Mock()
        bridge._emit_chat_aside_delta = Mock()
        bridge._chat_aside_running = set()
        bridge._loop_active_backends = {}
        bridge._chat_context_digest = Mock(return_value='fixture snapshot')
        bridge._session_runtime = Mock(return_value={})
        bridge._add_runtime_kwargs = Mock()
        bridge._new_backend_instance = Mock(return_value=Mock())
        return bridge, turn

    async def test_reference_reads_authoritative_document_via_text_only_not_normal_runner(self):
        self.manuals.save('demo', 'authoritative guide', '')
        bridge, turn = self.bridge()
        async def answer(_backend, **kwargs):
            self.assertIn('authoritative guide', kwargs['content'])
            self.assertNotIn('client forged document', kwargs['content'])
        with patch('src.backend.text_only.send_text_only', side_effect=answer) as send:
            await bridge._run_chat_aside('session', 'turn', attention={'content': ''})
            send.assert_awaited_once()
        bridge._new_backend_instance.return_value.send_message.assert_not_called()
        self.assertNotIn('authoritative guide', json.dumps(turn.to_dict()))

    async def test_missing_reference_persists_error_before_model(self):
        bridge, turn = self.bridge('@SKILL:absent 怎么用')
        await bridge._run_chat_aside('session', 'turn')
        bridge._new_backend_instance.assert_not_called()
        self.assertEqual(turn.status, 'error')
        self.assertIn('SKILL_NOT_INSTALLED', turn.answer)

    async def test_cancel_text_only_job_is_bounded_and_cleans_registry(self):
        bridge, _ = self.bridge()
        entered = asyncio.Event()
        async def wait(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()
        with patch('src.backend.text_only.send_text_only', side_effect=wait):
            task = asyncio.create_task(bridge._send_skill_manual_answer(Mock(), {'session_id': 'call', 'content': 'x', 'message_id': 'm', 'on_delta': Mock()}))
            await entered.wait()
            bridge._cancel_skill_manual_answer('call')
            with self.assertRaisesRegex(RuntimeError, '已停止'): await task
        self.assertEqual(bridge._skill_manual_answer_tasks, {})

    async def test_document_runner_preserves_selected_model_and_effort(self):
        bridge, _ = self.bridge()
        with patch('src.backend.text_only.send_text_only', new_callable=AsyncMock) as send:
            await bridge._send_skill_manual_answer(Mock(), {'session_id': 'call', 'content': 'guide',
                'message_id': 'm', 'on_delta': Mock(), 'model_override': 'selected-model', 'reasoning_effort': 'medium'})
        self.assertEqual(send.call_args.kwargs['model_override'], 'selected-model')
        self.assertEqual(send.call_args.kwargs['reasoning_effort'], 'medium')


if __name__ == '__main__': unittest.main()

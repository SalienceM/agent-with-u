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
from src.backend.base import StreamDelta
from src.backend.loop_store import AsideTurn, LoopState
from src.backend.skill_manuals import SkillManuals, skill_references
from src.backend.skill_store import SkillStore
from src.backend.skill_groups import SkillGroups
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
        attention = bridge._skill_reference_attention(question, bridge._parse_attention_json(json.dumps({
            'key': 'session', 'kind': 'session', 'label': 'fixture', 'content': 'project UI snapshot'})))
        turn = ChatAside(id='turn', question=question, status='answering', context_key=attention['key'],
                         context_kind=attention['kind'], context_label=attention['label'])
        extras = ChatExtras(session_id='session', asides=[turn])
        bridge._active_sessions = {'session': session}
        bridge._backend_configs = []
        bridge._skill_store = SimpleNamespace(manuals=lambda: self.manuals,
            groups=lambda: SkillGroups(self.root, self.manuals.lock, self.manuals.index),
            has_installed_skill=lambda names: False,
            command_sources=lambda: {'installed': [], 'profiles': []},
            get_skill=lambda name: {'name': name, 'content': 'fixture'})
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
            kwargs['on_delta'](StreamDelta('session:chataside', 'm', 'text_delta', text='guide answer'))
        with patch('src.backend.text_only.send_text_only', side_effect=answer) as send:
            await bridge._run_chat_aside('session', 'turn', attention={'content': ''})
            send.assert_awaited_once()
        bridge._new_backend_instance.return_value.send_message.assert_not_called()
        self.assertEqual(turn.status, 'done', turn.answer)
        self.assertNotIn('authoritative guide', json.dumps(turn.to_dict()))

    async def test_parent_plus_screenshot_carries_all_guides_and_actual_command_state(self):
        from tests.test_text_only import fixture_image
        groups = SkillGroups(self.root, self.manuals.lock, self.manuals.index)
        parent = groups.list()[0]
        groups.rename(parent['id'], '项目规范', parent['revision'])
        bridge, turn = self.bridge(f"@SKILL:{parent['id']} 截图里的命令为什么没有？")
        bridge._active_sessions['session'].abilities = {'skills': ['demo']}
        (self.root / 'README.md').write_text('Current project: existing todo application', encoding='utf-8')
        bridge._chat_extras_get.return_value.asides.insert(0, ChatAside(id='previous', question='项目要保留旧接口',
            answer='已了解兼容要求', status='done'))
        image = fixture_image()
        async def answer(_backend, **kwargs):
            self.assertIn('Original usage', kwargs['content'])
            self.assertIn('registeredCommandsForReferences', kwargs['content'])
            self.assertIn('registeredProjectCommands', kwargs['content'])
            self.assertIn('"registeredProjectCommands": []', kwargs['content'])
            self.assertNotIn('/opsx-init', kwargs['content'])
            self.assertIn('俺寻思这里只答疑', kwargs['content'])
            self.assertIn('Current project: existing todo application', kwargs['content'])
            self.assertIn('项目要保留旧接口', kwargs['content'])
            self.assertIn('项目规范', kwargs['content'])
            self.assertIn('"sessionId": "session"', kwargs['content'])
            self.assertIn('/skill demo', kwargs['content'])
            self.assertIn('"enabledInSession": true', kwargs['content'])
            self.assertEqual(kwargs['images'], [image])
            kwargs['on_delta'](StreamDelta('session:chataside', 'm', 'text_delta', text='image answer'))
        with patch('src.backend.text_only.send_text_only', side_effect=answer):
            await bridge._run_chat_aside('session', 'turn', images=[image])
        self.assertEqual(turn.context_label, 'fixture')
        self.assertEqual(turn.context_key, 'session')
        self.assertEqual(turn.status, 'done', turn.answer)
        self.assertNotIn(image.base64, json.dumps(turn.to_dict()))
        self.assertNotIn('Current project', json.dumps(turn.to_dict()))
        bridge._new_backend_instance.return_value.send_message.assert_not_called()

    async def test_loop_parent_screenshot_uses_same_isolated_runner(self):
        from tests.test_text_only import fixture_image
        parent = SkillGroups(self.root, self.manuals.lock, self.manuals.index).list()[0]
        bridge, chat_turn = self.bridge(f"@SKILL:{parent['id']} 解释截图")
        turn = AsideTurn.from_dict(chat_turn.to_dict())
        state = LoopState(session_id='session', asides=[turn])
        bridge._loop_state = Mock(return_value=state)
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._emit_aside_delta = Mock()
        bridge._loop_context_digest = Mock(return_value='loop snapshot')
        bridge._loop_runtime = Mock(return_value={})
        bridge._aside_running = set()
        image = fixture_image()
        async def answer(_backend, **kwargs):
            self.assertIn('Original usage', kwargs['content'])
            self.assertIn('registeredCommandsForReferences', kwargs['content'])
            self.assertIn('"enabledInSession": false', kwargs['content'])
            self.assertEqual(kwargs['images'], [image])
            kwargs['on_delta'](StreamDelta('session:aside', 'm', 'text_delta', text='loop image answer'))
        with patch('src.backend.text_only.send_text_only', side_effect=answer) as send:
            await bridge._run_aside('session', 'turn', images=[image])
            send.assert_awaited_once()
        self.assertEqual(turn.status, 'done', turn.answer)
        self.assertEqual(turn.context_label, 'fixture')
        self.assertEqual(turn.context_key, 'session')
        self.assertNotIn(image.base64, json.dumps(state.to_dict()))
        bridge._new_backend_instance.return_value.send_message.assert_not_called()

    async def test_reference_snapshot_only_advertises_project_commands_while_installed(self):
        bridge, _ = self.bridge()
        session = bridge._active_sessions['session']
        self.assertNotIn('/opsx-init', await bridge._skill_reference_snapshot('@SKILL:demo 用法', session))
        bridge._skill_store.command_sources = lambda: {'installed': ['openspec-apply-change'], 'profiles': []}
        self.assertNotIn('/opsx-init', await bridge._skill_reference_snapshot('@SKILL:demo 用法', session))
        self.assertIn('/opsx-init', await bridge._skill_reference_snapshot('@SKILL:openspec-apply-change 用法', session))
        bridge._skill_store.command_sources = lambda: {'installed': [], 'profiles': []}
        self.assertNotIn('/opsx-init', await bridge._skill_reference_snapshot('@SKILL:demo 用法', session))

    async def test_file_attention_survives_reference_and_keeps_visible_content(self):
        bridge, turn = self.bridge()
        attention = bridge._skill_reference_attention(turn.question, bridge._parse_attention_json(json.dumps({
            'key': 'file:remote:src/Todo.tsx', 'kind': 'file', 'label': 'Todo.tsx',
            'content': 'const projectMarker = "actual preview";'})))
        turn.context_key, turn.context_kind, turn.context_label = attention['key'], attention['kind'], attention['label']
        async def answer(_backend, **kwargs):
            self.assertIn('actual preview', kwargs['content'])
            self.assertIn('Original usage', kwargs['content'])
            kwargs['on_delta'](StreamDelta('session:chataside', 'm', 'text_delta', text='file answer'))
        with patch('src.backend.text_only.send_text_only', side_effect=answer):
            await bridge._run_chat_aside('session', 'turn', attention=attention)
        self.assertEqual(turn.status, 'done', turn.answer)
        self.assertEqual(turn.context_key, 'file:remote:src/Todo.tsx')
        self.assertEqual(turn.context_label, 'Todo.tsx')
        self.assertNotIn('actual preview', json.dumps(turn.to_dict()))

    async def test_missing_reference_persists_error_before_model(self):
        bridge, turn = self.bridge('@SKILL:absent 怎么用')
        await bridge._run_chat_aside('session', 'turn')
        bridge._new_backend_instance.assert_not_called()
        self.assertEqual(turn.status, 'error')
        self.assertIn('SKILL_NOT_INSTALLED', turn.answer)

    async def test_plain_followup_does_not_reload_manuals_from_history(self):
        bridge, turn = self.bridge('有报错，看我如何安装呢')
        bridge._chat_extras_get.return_value.asides.insert(0, ChatAside(
            id='earlier', question='@SKILL:demo 如何使用', answer='previous explanation', status='done'))
        bridge._build_session_reference_context = Mock(side_effect=lambda content, _sid: content)
        bridge._send_skill_manual_answer = AsyncMock()
        bridge._skill_reference_snapshot = AsyncMock()
        async def answer(**kwargs):
            # 历史问答可以保留；不能把历史中的 @SKILL 当成本条的新引用。
            self.assertIn('@SKILL:demo 如何使用', kwargs['content'])
            self.assertIn('【用户的问题】\n有报错，看我如何安装呢', kwargs['content'])
            self.assertNotIn('显式引用的 Skill 使用资料', kwargs['content'])
            kwargs['on_delta'](StreamDelta('session:chataside', 'm', 'text_delta', text='plain answer'))
        bridge._new_backend_instance.return_value.send_message = AsyncMock(side_effect=answer)
        with patch.object(self.manuals, 'context', side_effect=AssertionError('no new manual load')) as read:
            await bridge._run_chat_aside('session', 'turn')
            read.assert_not_called()
        self.assertEqual(turn.status, 'done', turn.answer)
        self.assertEqual(turn.question, '有报错，看我如何安装呢')
        bridge._send_skill_manual_answer.assert_not_called()
        bridge._skill_reference_snapshot.assert_not_called()

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

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_commands import (command_catalog, resolve_skill_call,
    parse_skill_command, instruction_digest, SkillCommandError)
from src.types import Session, ModelBackendConfig, BackendType


class SkillCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = ModelBackendConfig(id='backend', label='fixture', type=BackendType.CODEX_OFFICIAL)
        self.session = Session(id='session', title='fixture', created_at=1, updated_at=1,
            messages=[], working_dir=str(self.root), backend_id='backend',
            abilities={'skills': ['demo', 'openspec-apply-change'], 'prompts': []})
        self.skills = {name: {'name': name, 'description': 'fixture', 'content':
            f'---\nname: {name}\ndescription: fixture\n---\nRead {{{{SKILL_DIR}}}}/guide.md\nKeep every instruction.',
            'source': {'repository': 'fixture/repository'}}
            for name in ('demo', 'openspec-apply-change', 'unbound')}
        self.store = SimpleNamespace(get_skill=lambda name: self.skills.get(name))

    def resolve(self, text, invocation=None):
        return resolve_skill_call(self.session, self.config, self.store, text, invocation)

    def ready_openspec(self):
        executable = 'openspec.cmd' if os.name == 'nt' else 'openspec'
        path = self.root / 'node_modules' / '.bin' / executable
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('never execute this fixture', encoding='utf-8')
        (self.root / 'openspec').mkdir(exist_ok=True)
        (self.root / 'openspec/config.yaml').write_text('schema: spec-driven', encoding='utf-8')
        return path

    def test_parser_keeps_arguments_as_data_and_never_owns_app_commands(self):
        args = 'change-1 "quoted"; $(never-run)\nsecond line'
        for command in ('/skill openspec-apply-change', '/opsx-apply', '/OPSX-APPLY'):
            self.assertEqual(parse_skill_command(f'{command} {args}')['arguments'], args)
        for command in ('/new', '/clear', 'explain /opsx-apply'):
            self.assertIsNone(parse_skill_command(command))
        for command, error in [('/skill', 'SKILL_REQUIRED'), ('/skill ../secret', 'INVALID_SKILL_NAME'),
                               ('/opsx:apply x', 'UNKNOWN_SKILL_COMMAND'), ('/native /model', 'NATIVE_COMMAND_UNSUPPORTED')]:
            with self.assertRaisesRegex(SkillCommandError, error):
                self.resolve(command)

    def test_catalog_is_bound_only_content_free_and_does_not_check_cli(self):
        with patch('src.backend.skill_commands.shutil.which', side_effect=AssertionError('no probes on list')):
            data = command_catalog(self.session, self.config, self.store)
        self.assertEqual({c['name'] for c in data['commands']},
            {'/skill demo', '/skill openspec-apply-change', '/opsx-apply'})
        self.assertNotIn('Keep every instruction', json.dumps(data))
        self.assertFalse(data['nativeCommandsSupported'])
        self.assertEqual(data['workingDir'], str(self.root))

    def test_distinguishes_missing_unbound_changed_and_invalid_invocation(self):
        for text, code in [('/skill absent', 'SKILL_NOT_INSTALLED'), ('/skill unbound', 'SKILL_NOT_ENABLED')]:
            with self.assertRaisesRegex(SkillCommandError, code):
                self.resolve(text)
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_CHANGED'):
            self.resolve('/skill demo', {'name': 'demo', 'arguments': '', 'digest': 'old'})
        with self.assertRaisesRegex(SkillCommandError, 'INVALID_SKILL_CALL'):
            self.resolve('/skill demo a', {'name': 'demo', 'arguments': 'b'})
        with self.assertRaisesRegex(SkillCommandError, 'INVALID_SKILL_CALL'):
            self.resolve('/clear', {'name': 'demo'})

    def test_backend_and_workspace_checks_are_fail_closed(self):
        self.config.type = BackendType.OPENAI_COMPATIBLE
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_BACKEND_UNSUPPORTED'):
            self.resolve('/skill demo')
        self.config.type = BackendType.CODEX_OFFICIAL
        self.session.codex_connection_mode = 'ssh'
        with self.assertRaisesRegex(SkillCommandError, 'SSH'):
            self.resolve('/skill demo')
        self.session.codex_connection_mode = None
        self.session.working_dir = str(self.root / 'missing')
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_WORKSPACE_MISSING'):
            self.resolve('/skill demo')

    def test_openspec_checks_cli_before_project_and_never_installs_or_executes(self):
        self.config.env = {'PATH': 'fixture-only-path'}
        with patch('src.backend.skill_commands.shutil.which', return_value=None) as which:
            with self.assertRaisesRegex(SkillCommandError, 'OPENSPEC_CLI_MISSING'):
                self.resolve('/opsx-apply change-1')
            self.assertEqual(which.call_args.kwargs['path'], 'fixture-only-path')
        with patch('src.backend.skill_commands.shutil.which', return_value='/mock/openspec'):
            with self.assertRaisesRegex(SkillCommandError, 'OPENSPEC_PROJECT_NOT_INITIALIZED'):
                self.resolve('/opsx-apply change-1')
        self.assertEqual(list(self.root.iterdir()), [])
        cli = self.ready_openspec()
        with patch('src.backend.skill_commands.shutil.which', side_effect=AssertionError('prefer local CLI')):
            info, instructions = self.resolve('/opsx-apply change-1; echo nope')
        self.assertEqual(info['arguments'], 'change-1; echo nope')
        self.assertIn(cli.name, instructions)
        self.assertIn('未执行版本或业务命令', instructions)
        self.config.type = BackendType.QWEN_CODE_CLI
        self.config.allowed_tools = ['Read']
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_TOOL_UNAVAILABLE'):
            self.resolve('/opsx-apply change-1')

    def test_complete_selected_instructions_only_with_correct_native_reference(self):
        self.config.type = BackendType.QWEN_CODE_CLI
        info, instructions = self.resolve('/skill demo do something')
        self.assertIn('.qwen/skills/demo/guide.md', instructions)
        self.assertIn('Keep every instruction.', instructions)
        self.assertNotIn('openspec-apply-change', instructions)
        self.assertEqual(info['digest'], instruction_digest(self.skills['demo']))
        self.skills['demo']['content'] = 'x' * 128001
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_INSTRUCTIONS_INVALID'):
            self.resolve('/skill demo')

    def bridge(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {self.session.id: self.session}
        bridge._backend_configs = [self.config]
        bridge._session_store = SimpleNamespace(save=Mock(), update_meta=Mock())
        bridge._skill_store = self.store
        bridge._session_runtime = Mock(return_value={})
        bridge._build_session_reference_context = lambda content, sid: content
        bridge._build_prov_reference_context = AsyncMock(side_effect=lambda content, session, images, display: (content, images))
        bridge._prepare_session_skills = AsyncMock()
        bridge._compose_constraints = Mock(return_value='existing constraints')
        bridge._emit_session_updated = Mock()
        bridge._emit_delta = Mock()
        bridge._async_send = AsyncMock()
        return bridge

    async def send(self, bridge, content, **fields):
        await bridge._handle_send_message(json.dumps({'sessionId': self.session.id,
            'backendId': self.session.backend_id, 'content': content, 'messageId': 'answer', **fields}))

    async def test_send_preflight_failure_persists_error_and_never_prepares_or_calls_model(self):
        bridge = self.bridge()
        await self.send(bridge, '/skill absent')
        bridge._prepare_session_skills.assert_not_called()
        bridge._async_send.assert_not_called()
        self.assertEqual(self.session.messages[0].content, '/skill absent')
        self.assertIn('SKILL_NOT_INSTALLED', self.session.messages[1].content)
        self.assertFalse(self.session.messages[1].streaming)
        self.assertEqual([call.args[0].type for call in bridge._emit_delta.call_args_list], ['error', 'done'])
        bridge._session_store.save.assert_called()

    async def test_send_routes_to_existing_turn_without_native_slash_or_persistent_prompt(self):
        bridge = self.bridge()
        await self.send(bridge, '/skill demo inspect')
        bridge._async_send.assert_awaited_once()
        call = bridge._async_send.call_args
        self.assertIs(call.args[0], self.session)
        self.assertFalse(call.args[1].startswith('/'))
        self.assertIn('existing constraints', call.kwargs['constraints'])
        self.assertIn('Keep every instruction.', call.kwargs['constraints'])
        self.assertEqual(self.session.messages[0].content, '/skill demo inspect')
        self.assertNotIn('Keep every instruction.', self.session.constraints or '')

    async def test_unbinding_during_preparation_cannot_run_old_selection(self):
        bridge = self.bridge()
        async def unbind(_session):
            self.session.abilities['skills'] = []
        bridge._prepare_session_skills.side_effect = unbind
        await self.send(bridge, '/skill demo')
        bridge._async_send.assert_not_called()
        self.assertIn('SKILL_NOT_ENABLED', self.session.messages[-1].content)

    async def test_catalog_rpc_is_session_authorized(self):
        bridge = self.bridge()
        bridge._require_session_access = Mock(side_effect=PermissionError('foreign session'))
        with self.assertRaises(PermissionError):
            bridge._authorize_rpc('listSessionSkillCommands', bridge._rpc_listSessionSkillCommands, ['other'])
        self.assertEqual(json.loads(await bridge._rpc_listSessionSkillCommands(self.session.id))['status'], 'ok')

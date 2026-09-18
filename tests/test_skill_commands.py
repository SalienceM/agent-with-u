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
from src.backend.skill_command_presets import OPENSPEC_PROFILE
OPENSPEC_PROJECT_COMMANDS = [item['name'][6:] for item in OPENSPEC_PROFILE['commands'] if item['kind'] == 'project']
from src.backend.skill_store import SkillStore
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
        self.store = SimpleNamespace(get_skill=lambda name: self.skills.get(name),
                                     has_installed_skill=lambda names: any(name in self.skills for name in names),
                                     command_sources=lambda: {'installed': list(self.skills), 'profiles': []})

    def resolve(self, text, invocation=None):
        return resolve_skill_call(self.session, self.config, self.store, text, invocation)

    def ready_cli(self):
        executable = 'openspec.cmd' if os.name == 'nt' else 'openspec'
        path = self.root / 'node_modules' / '.bin' / executable
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('never execute this fixture', encoding='utf-8')
        return path

    def ready_openspec(self):
        path = self.ready_cli()
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
        self.assertEqual({c['name'] for c in data['commands'] if c['kind'] == 'skill'},
            {'/skill demo', '/skill openspec-apply-change', '/opsx-apply'})
        self.assertEqual({c['name'] for c in data['commands'] if c['kind'] == 'project'},
                         {f'/opsx-{action}' for action in OPENSPEC_PROJECT_COMMANDS})
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
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_CLI_MISSING'):
                self.resolve('/opsx-apply change-1')
            self.assertEqual(which.call_args.kwargs['path'], 'fixture-only-path')
        with patch('src.backend.skill_commands.shutil.which', return_value='/mock/openspec'):
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PROJECT_REQUIRED'):
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

    def test_installed_project_catalog_needs_no_binding_or_cli_and_cannot_shadow_app_commands(self):
        self.session.abilities = {}
        self.config.type = BackendType.OPENAI_COMPATIBLE
        self.store.get_skill = Mock(side_effect=AssertionError('installation gate must not read Skill bodies'))
        with patch('src.backend.skill_commands.shutil.which', side_effect=AssertionError('no CLI probe')):
            catalog = command_catalog(self.session, self.config, self.store)
        self.assertEqual(len(catalog['commands']), 8)
        self.assertTrue(all(item['unavailableReason'] for item in catalog['commands']))
        self.assertTrue(all(item['name'].startswith('/opsx-') for item in catalog['commands']))
        for text in ['/init', '/status', '/help', '/cost']:
            self.assertIsNone(parse_skill_command(text))

    def test_init_is_explicit_without_binding_or_project_and_keeps_managed_skills(self):
        self.session.abilities = {}
        cli = self.ready_cli()
        metadata, instructions = self.resolve('/OPSX-INIT')
        self.assertEqual(metadata['name'], 'command:openspec:opsx-init')
        self.assertEqual(metadata['executable'], str(cli))
        self.assertEqual(metadata['argv'], ['init', '--tools', 'none', '--language', 'zh-CN', '--no-animation'])
        self.assertEqual(metadata['workingDir'], str(self.root.resolve()))
        self.assertEqual(metadata['kind'], 'project')
        self.assertIn('不生成重复的 Agent commands/skills', instructions)
        self.assertIn('--help', instructions)
        self.assertFalse((self.root / 'openspec').exists())

    def test_uninstalled_project_commands_are_absent_and_manual_invocations_fail_before_cli_probe(self):
        self.ready_openspec()  # CLI and initialized project alone must never expose an extension.
        old = next(item for item in command_catalog(self.session, self.config, self.store)['commands']
                   if item['name'] == '/opsx-version')
        del self.skills['openspec-apply-change']
        with patch('src.backend.skill_commands.shutil.which', side_effect=AssertionError('no probes')):
            catalog = command_catalog(self.session, self.config, self.store)
            self.assertFalse(any(item['name'].startswith('/opsx-') for item in catalog['commands']))
            for action in OPENSPEC_PROJECT_COMMANDS:
                with self.subTest(action=action), self.assertRaisesRegex(SkillCommandError, 'UNKNOWN_SKILL_COMMAND'):
                    self.resolve(f'/opsx-{action}')
            with self.assertRaisesRegex(SkillCommandError, 'UNKNOWN_SKILL_COMMAND'):
                self.resolve('/opsx-version', {'name': old['skillName'], 'arguments': '', 'digest': old['digest']})
        self.skills['openspec-apply-change'] = {'name': 'openspec-apply-change', 'content': 'restored'}
        self.assertEqual(len([item for item in command_catalog(self.session, self.config, self.store)['commands']
                              if item['kind'] == 'project']), 8)

    def test_installation_gate_reads_real_node_library_not_stale_index_or_skill_body(self):
        library = self.root / 'isolated-library'
        with patch('src.backend.skill_store.LIBRARY_DIR', library), patch('src.backend.skill_store.INDEX_FILE', library / 'index.json'):
            store = SkillStore()
            store._index['openspec-apply-change'] = {'activations': ['global']}
            self.assertFalse(store.has_installed_skill(('openspec-apply-change',)))
            path = library / 'openspec-apply-change' / 'SKILL.md'
            path.parent.mkdir()
            path.write_text('fixture', encoding='utf-8')
            self.session.abilities = {}
            with patch.object(Path, 'read_text', side_effect=AssertionError('no body reads')):
                self.assertEqual(len(command_catalog(self.session, self.config, store)['commands']), 8)
            path.unlink()
            self.assertEqual(command_catalog(self.session, self.config, store)['commands'], [])

    def test_project_queries_compile_only_supported_arguments(self):
        self.ready_openspec()
        cases = {
            '/opsx-update': ['update'], '/opsx-list': ['list', '--json'],
            '/opsx-status change-1': ['status', '--change', 'change-1', '--json'],
            '/opsx-show todo': ['show', 'todo', '--json', '--no-interactive'],
            '/opsx-validate': ['validate', '--all', '--strict', '--no-interactive'],
            '/opsx-validate change-1': ['validate', 'change-1', '--strict', '--no-interactive'],
            '/opsx-validate --specs': ['validate', '--specs', '--strict', '--no-interactive'],
            '/opsx-help': ['--help'], '/opsx-help init': ['init', '--help'],
            '/opsx-version': ['--version'],
        }
        for command, argv in cases.items():
            with self.subTest(command=command):
                metadata, _ = self.resolve(command)
                self.assertEqual(metadata['argv'], argv)
        for command in ['/opsx-init --force', '/opsx-update other', '/opsx-list ../other',
                        '/opsx-status', '/opsx-status x;echo', '/opsx-show ../../other',
                        '/opsx-validate --fix', '/opsx-help $(whoami)', '/opsx-version\nnext']:
            with self.subTest(command=command), self.assertRaisesRegex(SkillCommandError, 'COMMAND_ARGUMENTS'):
                self.resolve(command)

    def test_project_prerequisites_prevent_implicit_reinit_or_wrong_root(self):
        with patch('src.backend.skill_commands.shutil.which', return_value=None):
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_CLI_MISSING'):
                self.resolve('/opsx-init')
        self.ready_cli()
        self.resolve('/opsx-help')
        self.resolve('/opsx-version')
        for command in ['/opsx-update', '/opsx-list', '/opsx-status demo', '/opsx-show demo', '/opsx-validate']:
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PROJECT_REQUIRED'):
                self.resolve(command)
        (self.root / 'openspec').mkdir()
        with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PATH_EXISTS'):
            self.resolve('/opsx-init')
        self.ready_openspec()
        with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PATH_EXISTS'):
            self.resolve('/opsx-init')
        child = self.root / 'nested'
        child.mkdir()
        self.session.working_dir = str(child)
        with patch('src.backend.skill_commands.shutil.which', return_value='/mock/openspec'):
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PARENT_PROJECT'):
                self.resolve('/opsx-init')

    def test_project_invocation_revalidates_digest_backend_and_tools(self):
        self.ready_cli()
        with self.assertRaisesRegex(SkillCommandError, 'INVALID_SKILL_CALL'):
            self.resolve('/opsx-init', {'name': 'command:openspec:opsx-update', 'arguments': ''})
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_CHANGED'):
            self.resolve('/opsx-init', {'name': 'command:openspec:opsx-init', 'arguments': '', 'digest': 'stale'})
        self.session.codex_connection_mode = 'ssh'
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_BACKEND_UNSUPPORTED'):
            self.resolve('/opsx-init')
        self.session.codex_connection_mode = None
        self.config.type = BackendType.QWEN_CODE_CLI
        self.config.allowed_tools = ['Read']
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_TOOL_UNAVAILABLE'):
            self.resolve('/opsx-init')

    def test_project_commands_refuse_external_stores_and_invalid_config(self):
        self.ready_openspec()
        config = self.root / 'openspec/config.yaml'
        config.write_text('store: another-project', encoding='utf-8')
        with self.assertRaisesRegex(SkillCommandError, 'COMMAND_CONFIG_RESTRICTED'):
            self.resolve('/opsx-update')
        config.write_text('invalid: [', encoding='utf-8')
        with self.assertRaisesRegex(SkillCommandError, 'COMMAND_CONFIG_INVALID'):
            self.resolve('/opsx-list')
        self.resolve('/opsx-help')  # CLI help/version don't consume project configuration

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

    async def test_project_send_uses_session_turn_without_skill_deployment(self):
        self.ready_cli()
        bridge = self.bridge()
        await self.send(bridge, '/opsx-init')
        bridge._prepare_session_skills.assert_not_called()
        bridge._async_send.assert_awaited_once()
        call = bridge._async_send.call_args
        self.assertIs(call.args[0], self.session)
        self.assertIn('显式选择的 项目命令', call.args[1])
        self.assertIn('当前轮显式项目命令', call.kwargs['constraints'])
        self.assertNotIn('Keep every instruction', call.kwargs['constraints'])
        self.assertEqual(self.session.messages[0].content, '/opsx-init')
        self.assertFalse((self.root / 'openspec').exists())

    async def test_project_send_error_never_calls_model_or_deploys(self):
        bridge = self.bridge()
        with patch('src.backend.skill_commands.shutil.which', return_value=None):
            await self.send(bridge, '/opsx-init')
        bridge._prepare_session_skills.assert_not_called()
        bridge._async_send.assert_not_called()
        self.assertIn('COMMAND_CLI_MISSING', self.session.messages[-1].content)

    async def test_uninstalled_project_send_never_calls_model_or_deploys(self):
        self.ready_openspec()
        del self.skills['openspec-apply-change']
        bridge = self.bridge()
        await self.send(bridge, '/opsx-init')
        bridge._prepare_session_skills.assert_not_called()
        bridge._async_send.assert_not_called()
        self.assertIn('UNKNOWN_SKILL_COMMAND', self.session.messages[-1].content)

    async def test_catalog_rpc_is_session_authorized(self):
        bridge = self.bridge()
        bridge._require_session_access = Mock(side_effect=PermissionError('foreign session'))
        with self.assertRaises(PermissionError):
            bridge._authorize_rpc('listSessionSkillCommands', bridge._rpc_listSessionSkillCommands, ['other'])
        self.assertEqual(json.loads(await bridge._rpc_listSessionSkillCommands(self.session.id))['status'], 'ok')

    async def test_generic_sequence_uses_registry_and_unknown_never_reaches_send(self):
        from src.backend.sequence_scheduler import dispatch_sequence_message
        profile = {'schemaVersion': 1, 'id': 'demo-suite', 'skillIds': ['demo'], 'commands': [
            {'name': '/demo-plan', 'description': 'Plan', 'kind': 'skill', 'skillId': 'demo'}]}
        self.store.command_sources = lambda: {'installed': ['demo'], 'configured': ['demo'],
            'profiles': [{'owner': 'demo', 'content': json.dumps(profile)}]}
        bridge = self.bridge()
        bridge._handle_send_message = AsyncMock(return_value=True)
        payload = {'sessionId': self.session.id, 'content': '/demo-plan inspect'}
        self.assertTrue(await dispatch_sequence_message(bridge, json.dumps(payload)))
        bridge._handle_send_message.assert_awaited_once()
        bridge._handle_send_message.reset_mock()
        payload['content'] = '/not-registered'
        with self.assertRaisesRegex(ValueError, '未调用模型'):
            await dispatch_sequence_message(bridge, json.dumps(payload))
        bridge._handle_send_message.assert_not_called()

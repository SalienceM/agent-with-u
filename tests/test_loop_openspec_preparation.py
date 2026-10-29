"""临时工作区与 fake Backend：从未初始化方案到正式执行/三方评审。"""
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopState, LoopRecord, STAGE_EXECUTE
from src.backend.loop_task_source import SourceError, TaskSourceReader, environment, validate_source
from src.backend.loop_openspec_preparation import proposal_references
from src.backend.skill_store import SkillStore
from src.types import BackendType, ModelBackendConfig
from tests.test_loop_continuation import bridge_fixture
from tests.test_loop_task_source import Project
from tests.test_aimein import plan, review, settings


class PreparationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='awu-openspec-preparation-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'workspace'
        self.root.mkdir()
        self.project = Project.__new__(Project)
        self.project.root = self.root.resolve()
        self.project.change = self.root / 'openspec/changes/test-change'
        self.project.tasks = self.project.change / 'tasks.md'
        self.project.design = self.project.change / 'design.md'
        self.proposal = self.root / 'docs/proposals/test-change'
        self.proposal.mkdir(parents=True)
        for name, content in {'proposal.md': 'Existing product goal', 'design.md': 'Preserve design',
                              'specs.md': 'Acceptance: saved item can reopen',
                              'tasks.md': '- [ ] 1.1 Build product\n- [ ] 1.2 Verify saved item\n'}.items():
            (self.proposal / name).write_text(content, encoding='utf-8')
        self.original = {p.name: p.read_bytes() for p in self.proposal.iterdir()}
        self.state = LoopState('s', stage=STAGE_EXECUTE,
            goal='基于 @docs/proposals/test-change 使用 OpenSpec 开发', auto=True)
        self.state.policy.intent_guard = False
        self.bridge, self.session = bridge_fixture(self.state, self.project)
        self.config = ModelBackendConfig(id='b', type=BackendType.CODEX_OFFICIAL, label='isolated')
        self.bridge._backend_configs = [self.config]
        self.session.codex_remote_host = ''
        self.session.codex_connection_mode = ''
        self.session.abilities = {'skills': ['openspec-ff-change']}
        for key, val in [('LIBRARY_DIR', Path(self.temp.name) / 'library'),
                         ('INDEX_FILE', Path(self.temp.name) / 'library/index.json'),
                         ('SECRETS_DIR', Path(self.temp.name) / 'secrets')]:
            mock = patch('src.backend.skill_store.' + key, val)
            mock.start(); self.addCleanup(mock.stop)
        self.bridge._skill_store = SkillStore()
        self.bridge._skill_store.install_standard_files({
            'SKILL.md': b'---\nname: openspec-ff-change\ndescription: Fixture\n---\nFixture skill',
            'references/example.txt': b'full skill payload'})
        self.bridge._prepare_session_skills = BridgeWS._prepare_session_skills.__get__(self.bridge)
        def source_environment(session, state, *, allow_uninitialized=False):
            if not (self.root / 'openspec').is_dir() and not allow_uninitialized:
                raise SourceError('project_required', 'No project')
            return self.project.binding(), {}
        self.bridge._loop_source_environment = source_environment
        self.calls = []
        self.bridge._loop_run_agent = AsyncMock(side_effect=self.agent)
        self.bridge._loop_original_intent_brief = lambda *_: 'Product goal'

    async def agent(self, session, prompt, stage, seq, **kwargs):
        self.calls.append((stage, prompt, kwargs))
        if kwargs.get('indep_session_id', '').endswith(':setup'):
            self.assertTrue((self.root / '.agents/skills/openspec-ff-change/references/example.txt').is_file())
            self.assertEqual(kwargs['execution_access'], 'workspace-write')
            self.assertIn('不需要再次询问', prompt)
            self.assertEqual(self.state.task_source['status'], 'preparing')
            if not self.project.change.exists():
                Project(self.root)
            shutil.copyfile(self.proposal / 'tasks.md', self.project.tasks)
            return 'Prepared from docs/proposals; original files preserved', ''
        if stage == 'execute':
            self.project.tasks.write_text(self.project.tasks.read_text(encoding='utf-8').replace('[ ]', '[x]'), encoding='utf-8')
            (self.root / 'product.txt').write_text('saved item can reopen', encoding='utf-8')
            return 'Implemented product and verified saved item', ''
        if stage == 'analysis':
            self.assertEqual(kwargs['execution_access'], 'read-only')
            return json.dumps({'openspecVerify': {'complete': True, 'summary': 'verified', 'issues': []}}), ''
        if stage == 'aimein-plan':
            return json.dumps({'aimeinPlan': plan()}), ''
        if stage.startswith('aimein-review'):
            return json.dumps({'aimeinReview': review(True, True)}), ''
        self.fail('Unexpected stage ' + stage)

    async def run_iteration(self):
        await self.bridge._run_loop_iteration('s')
        return self.state.loops[-1]

    async def test_missing_project_deploys_skill_then_apply_and_independent_verify(self):
        self.assertFalse((self.root / '.agents').exists())
        first = await self.run_iteration()
        self.assertEqual([v[0] for v in self.calls], ['prepare', 'execute'])
        self.assertTrue(first.completed)
        self.assertEqual(first.openspec_run['phase'], 'apply')
        self.assertEqual(first.stage_details['openspecSetup']['status'], 'done')
        self.assertNotEqual(first.task_result, 'verified')
        self.assertEqual(self.state.task_source['binding']['change'], 'test-change')
        second = await self.run_iteration()
        self.assertEqual(second.openspec_run['phase'], 'verify')
        self.assertEqual(second.decision['action'], 'complete')
        self.assertEqual([v[0] for v in self.calls], ['prepare', 'execute', 'analysis'])
        self.assertEqual(self.original, {p.name: p.read_bytes() for p in self.proposal.iterdir()})
        self.assertEqual(LoopRecord.from_dict(first.to_dict()).stage_details['openspecSetup']['status'], 'done')
        self.assertNotIn('rawOutput', first.to_dict(compact=True)['stageDetails']['openspecSetup'])

    async def test_aimein_reaches_three_distinct_fresh_reviews_and_native_verify(self):
        self.state.policy.execution_mode = 'aimein'
        self.state.policy.aimein_reviewers = settings()
        first = await self.run_iteration()
        self.assertFalse(first.error, first.error)
        self.assertTrue(first.aimein_run.get('accepted'), first.aimein_run)
        reviews = [v for v in self.calls if v[0].startswith('aimein-review')]
        self.assertEqual(len(reviews), 3)
        self.assertEqual(len({v[2]['indep_session_id'] for v in reviews}), 3)
        self.assertEqual(len({v[2]['runtime']['model'] for v in reviews}), 3)
        self.assertTrue(all(v[2]['execution_access'] == 'read-only' for v in reviews))
        self.assertNotEqual(self.state.stage, 'loopout')
        second = await self.run_iteration()
        self.assertEqual(second.openspec_run['phase'], 'verify')
        self.assertEqual(second.decision['action'], 'complete')
        self.assertEqual(sum(v[0] == 'prepare' for v in self.calls), 1)

    async def test_preparation_claim_without_files_is_not_success_or_retried(self):
        self.bridge._loop_run_agent = AsyncMock(return_value=('准备完成', ''))
        record = await self.run_iteration()
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)
        self.assertFalse(record.completed)
        self.assertFalse(self.state.auto)
        self.assertEqual(self.state.task_source['code'], 'preparation_incomplete')
        self.assertEqual(record.stage_details['openspecSetup']['status'], 'blocked')
        self.assertIn('source:0', record.decision['basisRefs'])
        self.assertEqual(record.decision['causeRef'], self.state.progress_guard['causeRef'])

    async def test_new_explicit_run_rechecks_existing_files_without_reinitializing(self):
        self.bridge._loop_run_agent = AsyncMock(return_value=('未完成准备', ''))
        await self.run_iteration()
        self.bridge._loop_run_agent = AsyncMock(side_effect=self.agent)
        record = await self.run_iteration()
        self.assertTrue(record.completed)
        self.assertEqual(len(self.state.loops), 2)

    async def test_reported_setup_failure_is_visible_and_original_session_can_retry(self):
        reason = 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors'
        output = json.dumps({'taskBlockers': {'version': 1, 'items': [{
            'id': 'exec-unavailable', 'affectedTaskIds': ['T1'], 'reasonCode': 'check_unavailable',
            'reason': reason, 'resolution': '恢复原生命令工具后，在原会话推进。'}]}})
        self.bridge._loop_run_agent = AsyncMock(return_value=(output, ''))
        record = await self.run_iteration()
        self.assertFalse(record.completed)
        self.assertFalse(self.state.auto)
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)
        self.assertEqual(self.state.task_source['code'], 'preparation_blocked')
        self.assertIn(reason, self.state.task_source['reason'])
        self.assertNotIn('尚未初始化', self.state.task_source['reason'])
        self.assertIn('原会话', self.state.progress_guard['resumeCondition'])
        self.assertEqual(record.stage_details['openspecSetup']['rawOutput'], output)
        self.assertEqual(record.stage_details['openspecSetup']['status'], 'blocked')
        self.assertFalse(self.state.unresolved_blockers)  # 未绑定正式任务，不能伪造任务台账。
        self.bridge._loop_run_agent = AsyncMock(side_effect=self.agent)
        next_record = await self.run_iteration()
        self.assertTrue(next_record.completed)
        self.assertEqual(self.state.session_id, 's')
        self.assertEqual(record.stage_details['openspecSetup']['rawOutput'], output)

    async def test_preparation_report_cannot_replace_existing_native_environment_pause(self):
        async def blocked(*args, **kwargs):
            self.bridge._loop_wait(self.state, self.state.loops[-1], 'env_runner_setup_failed', '原生命令执行器初始化失败', '修复原生执行器')
            return json.dumps({'openspecPreparation': {'status': 'blocked', 'reason': '其他模型判断'}}), ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=blocked)
        record = await self.run_iteration()
        self.assertEqual(self.state.progress_guard['reasonCode'], 'env_runner_setup_failed')
        self.assertEqual(record.stage_details['openspecSetup']['message'], '原生命令执行器初始化失败')
        self.assertEqual(record.stage_details['openspecSetup']['status'], 'paused')
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)

    def test_preparation_blocker_formats_and_bounds(self):
        from src.backend.loop_openspec_preparation import preparation_blocker
        self.assertFalse(preparation_blocker({'taskBlockers': {'version': 1, 'items': []}}))
        self.assertFalse(preparation_blocker({'summary': 'command stdout says access denied'}))
        for raw in [{'openspecPreparation': {'status': 'blocked', 'reason': 'x' * 5000}},
                    {'taskBlockers': {'version': 1, 'items': ['invalid']}}]:
            report = preparation_blocker(raw)
            self.assertTrue(report['reason'])
            self.assertLessEqual(len(report['reason']), 1201)

    async def test_cancellation_goal_change_and_failure_do_not_apply(self):
        for kind in ('stop', 'goal', 'failure', 'pause'):
            with self.subTest(kind=kind):
                self.state.loops = []
                self.state.progress_guard = {}
                self.state.task_source = {}
                self.state.auto = True
                self.bridge._loop_cancel.clear()
                self.state.goal = '基于 @docs/proposals/test-change 使用 OpenSpec 开发'
                async def changed(*args, **kwargs):
                    if kind == 'stop': self.bridge._loop_pending_out.add('s')
                    if kind == 'goal': self.state.goal = '新的目标'
                    if kind == 'failure': raise RuntimeError('isolated setup failure')
                    return json.dumps({'loopControl': {'pause': True, 'reason': 'need input'}}) if kind == 'pause' else 'partial', ''
                self.bridge._loop_run_agent = AsyncMock(side_effect=changed)
                record = LoopRecord(1); self.state.loops = [record]
                if kind == 'failure':
                    with self.assertRaises(RuntimeError):
                        await self.bridge._loop_openspec_source(self.session, self.state, record, 'prepare')
                else:
                    self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, record, 'prepare'))
                self.assertEqual(self.bridge._loop_run_agent.await_count, 1)
                self.assertFalse(record.completed)
                self.assertNotEqual(self.state.task_source.get('status'), 'preparing')
                self.bridge._loop_pending_out.clear()

    async def test_bound_source_missing_after_execution_never_bootstraps(self):
        self.state.task_source = {'binding': {**self.project.binding(), 'change': 'test-change'}, 'revision': 4}
        record = LoopRecord(1)
        for boundary in ('prepare', 'after'):
            self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, record, boundary))
        self.bridge._loop_run_agent.assert_not_called()

    async def test_read_only_discovery_does_not_deploy_or_initialize(self):
        result = json.loads(await self.bridge._rpc_loopTaskSourceDiscover('s'))
        self.assertEqual(result['code'], 'project_required')
        self.assertFalse((self.root / '.agents').exists())
        self.assertFalse((self.root / 'openspec').exists())
        self.bridge._loop_run_agent.assert_not_called()

    async def test_empty_project_prepares_and_ambiguous_project_does_not(self):
        (self.root / 'openspec').mkdir()
        reader = self.bridge._loop_task_reader
        original = reader.read
        async def empty_then_real(*args, **kwargs):
            if not self.project.tasks.exists(): return {'candidates': []}
            return await original(*args, **kwargs)
        reader.read = AsyncMock(side_effect=empty_then_real)
        record = await self.run_iteration()
        self.assertTrue(record.completed)
        self.state.task_source = {}
        self.state.goal = '使用 OpenSpec'
        self.bridge._loop_run_agent.reset_mock()
        reader.read = AsyncMock(return_value={'candidates': [{'name': 'first'}, {'name': 'second'}]})
        await self.run_iteration()
        self.bridge._loop_run_agent.assert_not_called()
        self.assertEqual(self.state.task_source['code'], 'source_selection')

    async def test_missing_artifacts_fill_same_change_then_recheck(self):
        Project(self.root)
        reader = self.bridge._loop_task_reader
        original = reader.read
        async def missing_then_real(*args, **kwargs):
            if len(args) > 4 and not self.calls:
                return {**self.project.snapshot(), 'cliState': 'blocked', 'missingArtifacts': ['specs']}
            return await original(*args, **kwargs)
        reader.read = AsyncMock(side_effect=missing_then_real)
        record = await self.run_iteration()
        self.assertTrue(record.completed)
        self.assertEqual(record.stage_details['openspecSetup']['change'], 'test-change')

    def test_reference_paths_are_confined_and_missing_is_actionable(self):
        self.assertEqual(proposal_references(str(self.root), self.state.goal), ['docs/proposals/test-change'])
        for text in ('@../outside', '@docs/missing'):
            with self.assertRaises(SourceError): proposal_references(str(self.root), text)

    def test_uninitialized_identity_still_rejects_missing_cli_store_and_remote(self):
        with patch('src.backend.loop_task_source.shutil.which', return_value=None):
            with self.assertRaises(SourceError) as result:
                environment(self.session, self.config, 'local', allow_uninitialized=True)
            self.assertEqual(result.exception.code, 'cli_missing')
        self.session.codex_connection_mode = 'ssh'
        with self.assertRaises(SourceError) as result:
            environment(self.session, self.config, 'local', allow_uninitialized=True)
        self.assertEqual(result.exception.code, 'remote_filesystem')
        self.session.codex_connection_mode = ''
        (self.root / 'openspec').mkdir()
        (self.root / 'openspec/config.yaml').write_text('store: external\n', encoding='utf-8')
        with self.assertRaises(SourceError) as result:
            environment(self.session, self.config, 'local', allow_uninitialized=True)
        self.assertEqual(result.exception.code, 'external_store')
        self.assertEqual(validate_source({'status': 'preparing', 'revision': 0})['status'], 'preparing')

    async def test_changed_backend_identity_and_unknown_prior_setup_cannot_continue(self):
        original_env = self.bridge._loop_source_environment
        async def changed(*args, **kwargs):
            self.bridge._loop_source_environment = lambda *a, **kw: ({**self.project.binding(), 'backendId': 'changed'}, {})
            return 'old output', ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=changed)
        record = await self.run_iteration()
        self.assertEqual(self.state.task_source['code'], 'execution_changed')
        self.assertFalse(record.completed)
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)
        self.bridge._loop_source_environment = original_env
        self.bridge._loop_run_agent.reset_mock()
        self.state.progress_guard = {}
        self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, record, 'prepare'))
        self.bridge._loop_run_agent.assert_not_called()

    async def test_active_codex_deploys_even_when_global_cli_path_is_missing(self):
        with patch('shutil.which', return_value=None), patch('src.backend.codex_office.resolve_codex_cli', return_value='missing-codex'):
            await self.bridge._prepare_runtime_skills(self.session, 'b')
        self.assertTrue((self.root / '.agents/skills/openspec-ff-change/SKILL.md').is_file())
        self.assertFalse((self.root / '.claude').exists())


@unittest.skipUnless(os.environ.get('AWU_TEST_REAL_OPENSPEC') == '1', 'opt-in installed CLI; isolated HOME and fake Backend')
class RealCliPreparationTests(unittest.IsolatedAsyncioTestCase):
    setUp = PreparationTests.setUp
    agent = PreparationTests.agent
    run_iteration = PreparationTests.run_iteration

    async def test_real_cli_initialization_import_apply_verify(self):
        # 对应用户的非标准方案形态：多条无稳定编号的 checkbox，原文件保持不变。
        descriptions = [f'Product acceptance condition {i}' for i in range(1, 35)]
        (self.proposal / 'tasks.md').write_text(''.join(f'- [ ] {text}\n' for text in descriptions), encoding='utf-8')
        self.original['tasks.md'] = (self.proposal / 'tasks.md').read_bytes()
        test_home = Path(self.temp.name) / 'home'
        test_home.mkdir()
        self.config.env = {'HOME': str(test_home), 'USERPROFILE': str(test_home), 'APPDATA': str(test_home / 'appdata'),
            'XDG_CONFIG_HOME': str(test_home / 'config'), 'OPENSPEC_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'CI': '1'}
        self.bridge._loop_source_environment = lambda session, state, **kw: environment(session, self.config, 'fixture-node', **kw)
        self.bridge._loop_task_reader = TaskSourceReader()
        cli_binding, cli_env = environment(self.session, self.config, 'fixture-node', allow_uninitialized=True)
        async def cli(*args):
            command = [cli_binding['cli'], *args]
            if os.name == 'nt':
                command = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c', subprocess.list2cmdline(command)]
            result = await asyncio.to_thread(subprocess.run, command, cwd=self.root, env=cli_env,
                capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout
        async def agent(session, prompt, stage, seq, **kw):
            if not kw.get('indep_session_id', '').endswith(':setup'):
                return await self.agent(session, prompt, stage, seq, **kw)
            self.calls.append((stage, prompt, kw))
            await cli('init', '--tools', 'none', '--no-animation', '--no-copilot-cloud')
            await cli('new', 'change', 'test-change')
            for name in ('proposal.md', 'design.md'):
                shutil.copyfile(self.proposal / name, self.project.change / name)
            self.project.tasks.write_text(''.join(f'- [ ] 1.{index} {text}\n' for index, text in enumerate(descriptions, 1)), encoding='utf-8')
            specs = self.project.change / 'specs/product'
            specs.mkdir(parents=True)
            (specs / 'spec.md').write_text('## ADDED Requirements\n\n### Requirement: Saved item\nThe product SHALL reopen saved items.\n\n#### Scenario: Reopen\n- **WHEN** saved\n- **THEN** reopen\n', encoding='utf-8')
            await cli('instructions', 'apply', '--change', 'test-change', '--json')
            return 'prepared using installed CLI', ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=agent)
        first = await self.run_iteration()
        self.assertTrue(first.completed, first.error or self.state.task_source)
        self.assertEqual(first.stage_details['openspecSetup']['status'], 'done')
        self.assertEqual([t['description'] for t in self.state.task_source['snapshot']['tasks']],
                         [f'1.{index} {text}' for index, text in enumerate(descriptions, 1)])
        second = await self.run_iteration()
        self.assertEqual(second.decision['action'], 'complete', second.error or second.decision)
        self.assertEqual(self.original, {p.name: p.read_bytes() for p in self.proposal.iterdir()})

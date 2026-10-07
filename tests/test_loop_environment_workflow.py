import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from src.backend.loop_environment_workflow import workflow_choices, select_workflow, resolve_workflow, WorkflowSelectionError
from src.backend.skill_command_presets import OPENSPEC_PROFILE


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.session = SimpleNamespace(abilities={'skills': ['openspec-apply-change']})
        self.info = {'content': 'original'}
        self.sources = {'installed': ['openspec-apply-change'], 'profiles': []}
        self.store = SimpleNamespace(command_sources=lambda: self.sources, get_skill=lambda name: self.info)

    def reference(self):
        choice = workflow_choices(self.session, self.store)[0]
        return select_workflow(self.session, self.store, choice['command'], choice['digest'], 'goal')

    def test_effective_selection_is_revalidated_and_scope_is_explicit(self):
        ref = self.reference()
        self.assertEqual(resolve_workflow(self.session, self.store, ref, 'goal'), ref)
        with self.assertRaises(WorkflowSelectionError):
            resolve_workflow(self.session, self.store, ref, 'changed goal')
        self.info['content'] = 'updated'
        with self.assertRaises(WorkflowSelectionError):
            resolve_workflow(self.session, self.store, ref, 'goal')

    def test_missing_unbound_conflicting_and_custom_cli_do_not_probe(self):
        ref = self.reference()
        self.session.abilities = {'skills': []}
        self.assertEqual(workflow_choices(self.session, self.store), [])
        with self.assertRaises(WorkflowSelectionError):
            resolve_workflow(self.session, self.store, ref, 'goal')
        self.session.abilities = {'skills': ['openspec-apply-change']}
        self.sources['installed'] = []
        self.assertEqual(workflow_choices(self.session, self.store), [])
        self.sources['installed'] = ['openspec-apply-change']
        self.sources['configured'] = ['openspec-apply-change']
        altered = copy.deepcopy(OPENSPEC_PROFILE)
        altered['commands'][0]['description'] += 'changed'
        self.sources['profiles'] = [{'owner': 'openspec-apply-change', 'content': json.dumps(p)}
                                    for p in [OPENSPEC_PROFILE, altered]]
        self.assertEqual(workflow_choices(self.session, self.store), [])
        altered = copy.deepcopy(OPENSPEC_PROFILE)
        for command in altered['commands']:
            if 'cli' in command:
                command['cli']['executable'] = 'arbitrary'
        self.sources['profiles'] = [{'owner': 'openspec-apply-change', 'content': json.dumps(altered)}]
        self.assertEqual(workflow_choices(self.session, self.store), [])

    def test_no_reference_is_generic_even_when_skill_bound(self):
        self.assertEqual(resolve_workflow(self.session, self.store, {}, 'mentions openspec'), {})
        self.assertEqual(select_workflow(self.session, self.store, '', '', 'goal'), {})


class WorkflowSelectionRpcTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_selection_preserves_blocks_and_never_starts_work(self):
        from src.backend.bridge_ws import BridgeWS
        from src.backend.loop_store import LoopState
        fixture = WorkflowTests()
        fixture.setUp()
        session = fixture.session
        session.id, session.session_type = 's', 'loop'
        state = LoopState(session_id='s', goal='goal', execution_environment={
            'revision': 4, 'status': 'blocked', 'blockers': [{'status': 'blocked', 'reasonCode': 'env_access_denied'}]})
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {'s': session}
        bridge._require_session_access = Mock()
        bridge._loop_state = lambda sid: state
        bridge._skill_store = fixture.store
        bridge._loop_is_running = lambda sid: False
        bridge._loop_has_active_call = lambda sid: False
        bridge._session_destroy_busy_reason = lambda sid: ''
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        choice = workflow_choices(session, fixture.store)[0]
        response = json.loads(await bridge._rpc_loopExecutionEnvironmentSelectWorkflow('s', choice['command'], choice['digest'], 4))
        self.assertEqual(response['status'], 'ok')
        self.assertEqual(state.execution_environment['revision'], 5)
        self.assertEqual(len(state.execution_environment['blockers']), 1)
        self.assertFalse(state.auto)
        self.assertFalse(state.task_source)
        self.assertEqual(state.loops, [])
        self.assertEqual(json.loads(await bridge._rpc_loopExecutionEnvironmentSelectWorkflow('s', '', '', 4))['status'], 'error')

"""Read-only summaries and submission races; isolated state, no application/model I/O."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

from tests.test_loop_environment_integration import fixture
from src.backend.loop_execution_environment import normalize_environment, digest
from src.backend.loop_environment_workflow import WorkflowSelectionError


class IterationRequestTests(unittest.TestCase):
    def test_compact_payload_injects_only_bounded_observations_without_io(self):
        bridge, session, state, *_ = fixture()
        bridge._loop_control_eligibility = lambda *_: {'takeover': {'allowed': True}}
        bridge._engineering_feedback = lambda *_: {}
        state.stage = 'loopexecute'
        state.task_source = {'binding': {'change': 'fixture'}, 'status': 'current', 'revision': 5}
        before = copy.deepcopy(state.to_dict())
        result = bridge._loop_payload(state, compact=True)
        self.assertEqual(result['iterationRequest']['sourceRevision'], 5)
        self.assertTrue(result['iterationRequest']['canRequest'])
        self.assertEqual(result['executionEnvironment']['effectiveDependencies']['sessionId'], session.id)
        self.assertEqual(before, state.to_dict())
        bridge._loop_save.assert_not_called()

    def test_summary_is_pure_and_nonblocking_diagnostics_allow_request(self):
        bridge, session, state, *_ = fixture()
        state.stage = 'loopexecute'
        bridge._schedule_loop_iteration = Mock()
        for status in ('unknown', 'stale', 'unsupported'):
            state.execution_environment = normalize_environment({'latest': {'status': status, 'quiesced': True}})
            before = copy.deepcopy(state.to_dict())
            result = bridge._loop_iteration_request(state)
            self.assertTrue(result['canRequest'])
            self.assertEqual(result['action'], 'resume')
            self.assertEqual(before, state.to_dict())
        bridge._loop_save.assert_not_called()
        bridge._schedule_loop_iteration.assert_not_called()

    def test_request_rechecks_changed_state_and_retains_explicit_recheck_path(self):
        bridge, session, state, *_ = fixture()
        state.stage = 'loopexecute'
        bridge._schedule_loop_iteration = Mock()
        self.assertTrue(bridge._loop_iteration_request(state)['canRequest'])
        state.execution_environment = normalize_environment({'blockers': [{'id': 'actual', 'status': 'blocked',
            'coverage': 'actual_tool', 'quiesced': False}]})
        self.assertFalse(bridge._loop_iteration_request(state)['canRequest'])
        self.assertEqual(json.loads(bridge._rpc_loopRunIteration(session.id))['status'], 'error')
        bridge._schedule_loop_iteration.assert_not_called()
        state.execution_environment['blockers'][0]['quiesced'] = True
        result = bridge._loop_iteration_request(state)
        self.assertTrue(result['canRequest'])  # Explicit recheck, not permission to execute.
        self.assertTrue(result['recheckRequired'])
        self.assertTrue(state.execution_environment['blockers'])
        state.control_operation = {'status': 'running'}
        self.assertEqual(bridge._loop_iteration_request(state)['reasonCode'], 'handoff_busy')
        self.assertEqual(json.loads(bridge._rpc_loopRunIteration(session.id))['status'], 'error')
        state.control_operation = {}
        state.control_mode = 'manual'
        self.assertFalse(bridge._loop_iteration_request(state)['canRequest'])


class DependencySummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_origins_are_separate_bounded_and_do_not_discover(self):
        bridge, session, state, *_ = fixture()
        bridge._skill_store = Mock()
        self.assertEqual(bridge._loop_dependency_summary(state)['items'], [])
        state.task_source = {'binding': {'change': 'fixture'}, 'revision': 2, 'status': 'current'}
        self.assertEqual(await bridge._loop_environment_dependencies(session, state), ['openspec'])
        self.assertEqual(bridge._loop_dependency_summary(state)['items'][0]['origins'][0]['kind'], 'task_source')
        ref = {'command': 'opsx-apply', 'digest': digest('fixture'), 'scope': digest(state.goal)}
        state.execution_environment = normalize_environment({'workflowRef': ref})
        with patch('src.backend.loop_environment_bridge.resolve_workflow', return_value=ref) as resolver:
            self.assertEqual(bridge._loop_dependency_summary(state)['items'][0]['origins'][1]['status'], 'unknown')
            resolver.assert_not_called()
            await bridge._loop_environment_dependencies(session, state)
            origins = bridge._loop_dependency_summary(state)['items'][0]['origins']
            self.assertEqual([item['kind'] for item in origins], ['task_source', 'declaration'])
            self.assertEqual(origins[1]['status'], 'validated')
        with patch('src.backend.loop_environment_bridge.resolve_workflow', side_effect=WorkflowSelectionError('invalid')):
            with self.assertRaises(WorkflowSelectionError):
                await bridge._loop_environment_dependencies(session, state)
        self.assertEqual(bridge._loop_dependency_summary(state)['items'][0]['origins'][1]['status'], 'invalid')
        state.task_source = {}
        self.assertEqual(len(bridge._loop_dependency_summary(state)['items'][0]['origins']), 1)
        state.goal = 'changed'
        self.assertEqual(bridge._loop_dependency_summary(state)['items'][0]['origins'][0]['status'], 'invalid')
        state.task_source = {'binding': {'change': 'fixture'}, 'status': 'current'}
        state.execution_environment['workflowRef'] = {}
        self.assertEqual([v['kind'] for v in bridge._loop_dependency_summary(state)['items'][0]['origins']], ['task_source'])
        self.assertFalse(state.auto)
        bridge._loop_save.assert_not_called()
        bridge._skill_store.assert_not_called()
        self.assertEqual(bridge._skill_store.mock_calls, [])

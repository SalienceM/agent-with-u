import json
import unittest

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.workspace_terminals import terminal_shells
from tests.engine_workbench_fixtures import EngineFixture


class EngineWorkbenchProtocolTests(unittest.TestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        owner = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.addCleanup(_REQUEST_OWNER_ID.reset, owner)

    def capabilities(self, workspace=None):
        return json.loads(self.bridge._rpc_sessionWorkbenchCapabilities(self.session.id, workspace or self.session.working_dir))

    def test_advertises_only_implemented_contracts_without_starting_processes(self):
        result = self.capabilities()
        self.assertEqual(result['protocolVersion'], 1)
        self.assertEqual(result['capabilities'], {'viewMode': 1, 'windowHandoff': 1, 'documents': 1, 'languageServices': 1, 'terminal': int(bool(terminal_shells()))})
        self.assertEqual(result['identity']['ownerId'], self.session.owner_id)
        self.assertEqual(result['identity'], self.capabilities()['identity'])

    def test_wrong_user_and_workspace_fail_closed(self):
        self.assertEqual(self.capabilities(str(self.fixture.home))['reasonCode'], 'stale_workspace')
        token = _REQUEST_OWNER_ID.set('another-user')
        try:
            with self.assertRaises(PermissionError):
                self.capabilities()
        finally:
            _REQUEST_OWNER_ID.reset(token)

    def test_frozen_identity_rejected_after_directory_change_or_restart(self):
        identity = self.capabilities()['identity']
        self.bridge._workbench_identity(self.session.id, identity)
        self.session.working_dir = str(self.fixture.home)
        with self.assertRaises(WorkbenchError):
            self.bridge._workbench_identity(self.session.id, identity)
        self.session.working_dir = str(self.fixture.workspace)
        del self.bridge._workbench_executor_instance
        with self.assertRaises(WorkbenchError):
            self.bridge._workbench_identity(self.session.id, identity)

    def test_mutation_rechecks_frozen_source(self):
        identity = self.capabilities()['identity']
        identity['sessionId'] = 'wrong-session'
        result = json.loads(self.bridge._rpc_updateSessionWorkbench(self.session.id, '{"viewMode":"engine"}', json.dumps(identity)))
        self.assertEqual(result['reasonCode'], 'stale_workspace')
        self.assertEqual(self.session.view_mode, 'chat')

    def test_ssh_and_missing_workspaces_not_mapped_to_executor_local(self):
        self.session.codex_connection_mode = 'ssh'
        self.assertEqual(self.capabilities()['reasonCode'], 'workspace_unavailable')
        self.session.codex_connection_mode = None
        self.session.working_dir = str(self.fixture.workspace / 'missing')
        self.assertEqual(self.capabilities()['reasonCode'], 'workspace_unavailable')

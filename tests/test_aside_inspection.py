import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from src.backend.aside_inspection import InspectionError, QueryBudget, QueryIdentity, ReadQuery, clean_inspection


class QueryContractTests(unittest.TestCase):
    def setUp(self):
        self.session = SimpleNamespace(id='s', owner_id='u', working_dir=str(Path(tempfile.gettempdir())),
                                       constraints='', abilities=None, codex_connection_mode='node')

    def identity(self, **kwargs):
        return QueryIdentity.capture(self.session, owner='u', executor='node-a', backend_id='b', turn_id='t', **kwargs)

    def test_identity_frozen_and_revalidated(self):
        identity = self.identity()
        identity.validate(self.session, owner='u', executor='node-a', backend_id='b')
        for changes in ({'owner': 'other'}, {'executor': 'node-b'}, {'backend_id': 'other'}):
            with self.assertRaises(InspectionError):
                identity.validate(self.session, **{'owner': 'u', 'executor': 'node-a', 'backend_id': 'b', **changes})
        self.session.working_dir += '/different'
        with self.assertRaises(InspectionError):
            identity.validate(self.session, owner='u', executor='node-a', backend_id='b')

    def test_no_root_or_ssh_never_falls_back(self):
        for directory in ('', '.'):
            self.session.working_dir = directory
            with self.assertRaises(InspectionError):
                self.identity().file_root()
        self.session.codex_connection_mode = 'ssh'
        with self.assertRaisesRegex(InspectionError, 'SSH'):
            self.identity().file_root()
        with self.assertRaises(InspectionError):
            QueryIdentity.capture(self.session, owner='u', executor='', backend_id='b', turn_id='t')

    def test_strict_read_operations(self):
        self.assertEqual(ReadQuery.parse({'operation': 'runtime_status'}).arguments, {})
        for packet in ({'operation': 'shell', 'arguments': {'command': 'anything'}},
                       {'operation': 'read_text', 'arguments': {'path': 'a', 'write': True}},
                       {'operation': 'read_text', 'arguments': {'path': 'a', 'offset': True}},
                       {'operation': 'search_text', 'arguments': {'path': '.'}},
                       {'operation': 'read_text', 'arguments': {'path': 'a', 'offset': -1}},
                       {'operation': 'runtime_status', 'executor': 'other'}):
            with self.subTest(packet=packet), self.assertRaises(InspectionError):
                ReadQuery.parse(packet)

    def test_budget_and_persisted_metadata_cannot_contain_content(self):
        budget = QueryBudget(operations=1, total_bytes=2, context_chars=2)
        budget.operation()
        with self.assertRaises(InspectionError):
            budget.operation()
        with self.assertRaises(InspectionError):
            budget.bytes(3)
        self.assertEqual(budget.context({'content': 'abc'})['status'], 'limit')
        self.assertEqual(clean_inspection({'content': 'secret', 'sources': [
            {'path': 'a', 'text': 'secret', 'complete': True}]}), {'sources': [{'path': 'a', 'complete': True}]})


if __name__ == '__main__':
    unittest.main()

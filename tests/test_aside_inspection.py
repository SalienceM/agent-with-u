import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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

    def test_discovery_reserves_answer_time_without_cancelling_request(self):
        budget = QueryBudget(started=100)
        with patch('src.backend.aside_inspection.time.monotonic', return_value=100):
            self.assertEqual(budget.discovery_remaining(), 120)
        with patch('src.backend.aside_inspection.time.monotonic', return_value=220):
            self.assertEqual(budget.remaining(), 60)
            self.assertEqual(budget.finish_reason(), 'answer_reserve')
            with self.assertRaises(InspectionError) as caught:
                budget.check_discovery()
            self.assertEqual(caught.exception.reason, 'answer_reserve')
            budget.check()
            self.assertFalse(budget.cancelled.is_set())
        with patch('src.backend.aside_inspection.time.monotonic', return_value=280):
            with self.assertRaises(InspectionError) as caught:
                budget.check()
            self.assertEqual(caught.exception.code, 'timeout')
        small = QueryBudget(seconds=3, started=100)
        with patch('src.backend.aside_inspection.time.monotonic', return_value=102):
            self.assertEqual(small.discovery_remaining(), 0)
            self.assertEqual(small.remaining(), 1)

    def test_search_allocation_and_total_limit_are_distinct(self):
        budget = QueryBudget(total_bytes=20, search_bytes=10)
        budget.bytes(10, search=True)
        with self.assertRaises(InspectionError) as caught:
            budget.bytes(1, search=True)
        self.assertEqual(caught.exception.reason, 'search_bytes')
        self.assertEqual(budget.finish_reason(), '')
        budget.bytes(10)
        self.assertEqual(budget.used_bytes, 20)
        self.assertEqual(budget.finish_reason(), 'total_bytes')
        with self.assertRaises(InspectionError):
            budget.bytes(1)
        self.assertEqual(budget.used_bytes, 20)
        budget.cancelled.set()
        with self.assertRaises(InspectionError) as caught:
            budget.check_discovery()
        self.assertEqual(caught.exception.code, 'cancelled')

    def test_context_reason_and_safe_source_metadata(self):
        budget = QueryBudget(context_chars=10)
        result = budget.context({'content': 'sensitive body'})
        self.assertEqual(result['limitReason'], 'context_chars')
        self.assertEqual(budget.finish_reason(), 'context_chars')
        source = clean_inspection({'sources': [{'operation': 'read_text', 'status': 'limit',
            'limitReason': 'file_bytes', 'message': 'secret path', 'content': 'body',
            'entryCount': -1, 'visited': 3, 'matchCount': True}]})['sources'][0]
        self.assertEqual(source, {'operation': 'read_text', 'status': 'limit',
                                 'limitReason': 'file_bytes', 'visited': 3})
        self.assertNotIn('limitReason', clean_inspection({'sources': [
            {'limitReason': 'arbitrary secret'}]})['sources'][0])


if __name__ == '__main__':
    unittest.main()

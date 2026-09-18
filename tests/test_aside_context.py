import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.aside_context import project_reference_snapshot


class AsideProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.session = SimpleNamespace(id='project-a', title='项目 A', working_dir=str(self.root), backend_id='b')

    def test_only_bounded_project_documents_no_secrets_or_recursive_source(self):
        (self.root / 'README.md').write_text('Project A: todo app' + 'x' * 20_000, encoding='utf-8')
        (self.root / '.env').write_text('SECRET_MARKER=never-read', encoding='utf-8')
        (self.root / 'src').mkdir()
        (self.root / 'src/private.py').write_text('NEVER_READ_SOURCE', encoding='utf-8')
        (self.root / 'openspec').mkdir()
        (self.root / 'openspec/config.yaml').write_text('schema: spec-driven', encoding='utf-8')
        (self.root / 'openspec/changes').mkdir()
        (self.root / 'openspec/changes/add-feature').mkdir()
        result = project_reference_snapshot(self.session)
        self.assertEqual(result['sessionId'], 'project-a')
        self.assertEqual(result['inspection'], 'bounded_read_only')
        self.assertEqual(result['openspecChanges']['entries'], ['add-feature/'])
        documents = {item['path']: item for item in result['documents']}
        self.assertTrue(documents['README.md']['truncated'])
        self.assertEqual(len(documents['README.md']['content']), 2500)
        self.assertEqual(documents['openspec/config.yaml']['content'], 'schema: spec-driven')
        self.assertNotIn('SECRET_MARKER', json.dumps(result))
        self.assertNotIn('NEVER_READ_SOURCE', json.dumps(result))
        self.assertEqual(documents['package.json']['status'], 'missing')

    def test_ssh_and_unconfigured_workspaces_never_read_executor_cwd(self):
        for values in ({'codex_connection_mode': 'ssh'}, {'working_dir': '.'}, {'working_dir': ''}):
            session = SimpleNamespace(**{**vars(self.session), **values})
            with patch('src.backend.aside_context.os.scandir', side_effect=AssertionError('must not inspect')):
                result = project_reference_snapshot(session)
            self.assertEqual(result['inspection'], 'not_inspected')
            self.assertNotIn('documents', result)

    def test_project_symlink_cannot_read_outside_workspace(self):
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / 'external.md'
            secret.write_text('EXTERNAL_SECRET', encoding='utf-8')
            try:
                (self.root / 'README.md').symlink_to(secret)
            except OSError:
                self.skipTest('symlinks unavailable on this Windows host')
            result = project_reference_snapshot(self.session)
            self.assertNotIn('EXTERNAL_SECRET', json.dumps(result))
            self.assertEqual(result['documents'][0]['status'], 'unavailable')

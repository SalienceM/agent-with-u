"""只读详情并发契约；通过隔离 runner 使用临时目录和假 Git。"""
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.project_merge_workflow import ProjectMergeWorkflow
from src.backend.task_git import TaskGit, canonical_path


class MergeReadConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_sides_overlap_and_keep_independent_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            roots = {}
            for name in ('source', 'target', 'integration'):
                path = Path(folder) / name
                path.mkdir()
                roots[name] = canonical_path(path)

            class Reader(ProjectMergeWorkflow):
                def _collaboration_session(self, sid):
                    return SimpleNamespace(working_dir=roots[sid], title=sid)

                def _require_session_access(self, sid):
                    if sid not in roots: raise PermissionError(sid)

                def _project_activity(self, root):
                    return []

            barrier = threading.Barrier(3, timeout=3)
            calls = []

            def inspect(git):
                calls.append(git.root)
                barrier.wait()
                if git.root == roots['target']: raise OSError('fixture unavailable')
                return {'head': 'a' * 40, 'branch': 'main', 'repositoryId': 'repo',
                        'fingerprint': 'snapshot', 'dirty': []}

            row = {side: {'sessionId': side, 'root': root, 'branch': 'main', 'repositoryId': 'repo',
                          'fingerprint': 'snapshot', 'actual': {'fingerprint': 'snapshot'}} for side, root in roots.items()}
            row.update(status='candidate', candidate='a' * 40, verification={'status': 'not_run'})
            with patch.object(TaskGit, 'inspect', inspect):
                view = await Reader()._merge_workflow_view(row)
            self.assertCountEqual(calls, roots.values())
            self.assertEqual(view['workflow']['sides']['source']['state'], 'known')
            self.assertEqual(view['workflow']['sides']['integration']['state'], 'known')
            self.assertEqual(view['workflow']['sides']['target']['state'], 'unknown')
            self.assertEqual(view['workflow']['diagnostics'][0]['code'], 'unknown')
            self.assertFalse(view['workflow']['gitVerified'])

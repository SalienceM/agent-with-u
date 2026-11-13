"""首次基线与分支创建使用隔离真实 Git 仓库，不访问用户项目。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.task_git import TaskGit
from src.backend.session_collaboration_store import CollaborationError


class InitialCopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='awu-initial-copy-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'project'; self.root.mkdir()
        self.git = TaskGit(str(self.root))

    def create(self, view=None, selected=None):
        view = view or self.git.inspect_for_copy()
        return self.git.create(view, self.base / 'child', 'awu/task/child',
            selected if selected is not None else [row['path'] for row in view['dirty']], self.base / 'scratch', view['initialSkillFiles'])

    def test_initial_project_honors_nested_ignores_and_can_merge_child_back(self):
        (self.root / '.gitignore').write_text('.agents/\ncache/\n')
        nested = self.root / 'nested'; nested.mkdir()
        (nested / '.gitignore').write_text('ignored.txt\n')
        (nested / 'ignored.txt').write_text('ignored')
        (nested / 'source.txt').write_text('source')
        skill = self.root / '.agents/skills/test/SKILL.md'
        skill.parent.mkdir(parents=True); skill.write_text('skill')
        view = self.git.inspect_for_copy()
        self.assertFalse((self.root / '.git').exists())
        self.assertEqual(view['fingerprint'], self.git.inspect_for_copy()['fingerprint'])
        result = self.create(view)
        self.assertEqual(self.git.inspect()['dirty'], [])
        self.assertEqual(result['initializedSource']['head'], self.git.repository()['head'])
        self.assertFalse((self.base / 'child/nested/ignored.txt').exists())
        self.assertEqual((self.base / 'child/.agents/skills/test/SKILL.md').read_text(), 'skill')
        child = TaskGit(str(self.base / 'child'))
        (self.base / 'child/nested/source.txt').write_text('child development')
        child.run('add', 'nested/source.txt'); child.run('commit', '-m', 'child work')
        self.git.merge(child.repository()['head'], fast_forward=True)
        self.assertEqual((nested / 'source.txt').read_text(), 'child development')
        self.assertEqual(self.git.inspect()['dirty'], [])

    def test_empty_folder_gets_valid_empty_baseline(self):
        result = self.create()
        self.assertEqual(self.git.repository()['branch'], 'main')
        self.assertEqual(self.git.repository()['head'], result['head'])

    def test_unborn_keeps_branch_and_unselected_staging_and_copies_current_bytes(self):
        self.git.run('init', '--initial-branch=develop', '--template=')
        (self.root / 'selected.txt').write_text('staged version')
        (self.root / 'keep.txt').write_text('keep staged')
        self.git.run('add', '.')
        before = self.git.run('ls-files', '-s', '--', 'keep.txt')
        (self.root / 'selected.txt').write_text('current version')
        view = self.git.inspect_for_copy()
        self.assertEqual(view['initialization']['kind'], 'initial_commit')
        self.create(view, ['selected.txt'])
        self.assertEqual(self.git.repository()['branch'], 'develop')
        self.assertEqual(self.git.run('show', 'HEAD:selected.txt').decode(), 'staged version')
        self.assertEqual(self.git.run('ls-files', '-s', '--', 'keep.txt'), before)
        self.assertEqual((self.base / 'child/selected.txt').read_text(), 'current version')
        self.assertFalse((self.base / 'child/keep.txt').exists())
        self.assertEqual((self.root / 'selected.txt').read_text(), 'current version')

    def test_stale_files_and_unsafe_selection_fail_before_initializing(self):
        file = self.root / 'source.txt'; file.write_text('before')
        view = self.git.inspect_for_copy(); file.write_text('after')
        with self.assertRaisesRegex(CollaborationError, '变化'):
            self.create(view)
        self.assertFalse((self.root / '.git').exists())
        (self.root / '.env').write_text('PRIVATE_SECRET')
        view = self.git.inspect_for_copy()
        self.assertTrue(next(row for row in view['dirty'] if row['path'] == '.env')['blocked'])
        with self.assertRaises(ValueError):
            self.create(view)
        self.assertFalse((self.root / '.git').exists())

    def test_nested_or_broken_git_is_never_reinitialized(self):
        (self.root / '.git').mkdir()
        (self.root / '.git/keep').write_text('do not remove')
        with self.assertRaisesRegex(CollaborationError, '元数据'):
            self.git.inspect_for_copy()
        self.assertEqual((self.root / '.git/keep').read_text(), 'do not remove')
        parent = TaskGit(str(self.base)); parent.run('init', '--template=')
        nested = self.base / 'nested'; nested.mkdir()
        with self.assertRaisesRegex(CollaborationError, '根目录'):
            TaskGit(str(nested)).inspect_for_copy()
        self.assertFalse((nested / '.git').exists())

    def test_late_failure_keeps_initialization_and_cannot_overwrite_it(self):
        (self.root / 'source.txt').write_text('retained')
        view = self.git.inspect_for_copy()
        run = self.git.run
        def fail_worktree(*args, **kwargs):
            if args[:2] == ('worktree', 'add'):
                raise CollaborationError('fixture checkout failed')
            return run(*args, **kwargs)
        with patch.object(self.git, 'run', side_effect=fail_worktree), self.assertRaisesRegex(CollaborationError, 'checkout'):
            self.create(view)
        baseline = self.git.repository()['head']
        with self.assertRaisesRegex(CollaborationError, '变化'):
            self.create(view)
        self.assertEqual(self.git.repository()['head'], baseline)
        self.assertEqual((self.root / 'source.txt').read_text(), 'retained')

import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from src.backend.task_git import TaskGit
from src.backend.session_collaboration_store import CollaborationError


class TaskGitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name); self.root = self.base / '源 项目'; self.root.mkdir()
        self.git = TaskGit(str(self.root))
        self.git.run('init')
        (self.root / 'same.txt').write_text('baseline\n', encoding='utf-8')
        (self.root / '.gitignore').write_text('ignored.txt\n', encoding='utf-8')
        self.git.run('add', '.')
        self.git.run('commit', '-m', 'baseline')

    def tearDown(self): self.temp.cleanup()

    def create(self, name, view=None, selected=None):
        return self.git.create(view or self.git.inspect(), self.base / name, 'awu/task/' + name, selected or [], self.base / 'scratch')

    def test_fast_forward_never_overwrites_ignored_target_file(self):
        child = self.create('ignored-source')
        work = TaskGit(child['root'])
        (Path(child['root']) / 'ignored.txt').write_text('tracked source output')
        work.run('add', '-f', '--', 'ignored.txt'); work.run('commit', '-m', 'source')
        candidate = work.repository()['head']; original = self.git.repository()['head']
        (self.root / 'ignored.txt').write_text('user ignored data')
        with self.assertRaises(CollaborationError): self.git.merge(candidate, fast_forward=True)
        self.assertEqual((self.root / 'ignored.txt').read_text(), 'user ignored data')
        self.assertEqual(self.git.repository()['head'], original)

    def test_two_worktrees_have_independent_contents_indexes_and_head(self):
        baseline = self.git.inspect(); first = self.create('one', baseline); second = self.create('two', baseline)
        (self.base / 'one/same.txt').write_text('first task', encoding='utf-8')
        (self.base / 'two/same.txt').write_text('second task', encoding='utf-8')
        one = TaskGit(str(self.base / 'one')); one.run('add', 'same.txt'); one.run('commit', '-m', 'first')
        self.assertNotEqual(one.repository()['head'], first['head'])
        self.assertEqual(TaskGit(str(self.base / 'two')).repository()['head'], second['head'])
        self.assertEqual((self.root / 'same.txt').read_text(), 'baseline\n')
        self.assertEqual(self.git.inspect()['dirty'], [])
        self.assertEqual((self.base / 'two/same.txt').read_text(), 'second task')
        from src.backend.engine_workbench import WorkspaceIdentity
        from src.backend.workspace_documents import read_document
        from src.backend.workspace_search import search_workspace
        for name, text in [('one', 'first task'), ('two', 'second task')]:
            identity = WorkspaceIdentity('owner', 'executor', name, str(self.base / name), name)
            self.assertEqual(read_document(identity, 'same.txt')['text'], text)
            found = search_workspace(identity, 'content', text, 10, (), threading.Event())
            self.assertEqual(found['results'][0]['relativePath'], 'same.txt')

    def test_selected_dirty_snapshot_never_changes_source_index_head_or_unselected_files(self):
        (self.root / 'same.txt').write_text('staged', encoding='utf-8'); self.git.run('add', 'same.txt')
        (self.root / 'same.txt').write_text('working content', encoding='utf-8')
        (self.root / 'unselected.txt').write_text('untouched', encoding='utf-8')
        (self.root / 'ignored.txt').write_text('secret', encoding='utf-8')
        (self.root / '.env').write_text('secret', encoding='utf-8')
        original_index = (self.root / '.git/index').read_bytes(); view = self.git.inspect()
        result = self.create('snapshot', view, ['same.txt'])
        self.assertNotEqual(result['baseline'], view['head'])
        self.assertEqual((self.base / 'snapshot/same.txt').read_text(), 'working content')
        self.assertFalse((self.base / 'snapshot/unselected.txt').exists())
        self.assertFalse((self.base / 'snapshot/ignored.txt').exists())
        self.assertFalse((self.base / 'snapshot/.env').exists())
        self.assertEqual((self.root / '.git/index').read_bytes(), original_index)
        self.assertEqual(self.git.repository()['head'], view['head'])
        self.assertTrue(next(row for row in view['dirty'] if row['path'] == '.env')['blocked'])

    def test_changed_revision_conflict_and_existing_output_never_overwrite(self):
        view = self.git.inspect(); (self.root / 'same.txt').write_text('late', encoding='utf-8')
        with self.assertRaisesRegex(CollaborationError, '变化'): self.create('stale', view)
        self.assertFalse((self.base / 'stale').exists())
        self.git.run('branch', 'awu/task/conflict')
        with self.assertRaisesRegex(CollaborationError, '分支已存在'): self.create('conflict')
        (self.base / 'existing').mkdir(); (self.base / 'existing/kept').write_text('keep')
        with self.assertRaisesRegex(CollaborationError, '已存在'): self.create('existing')
        self.assertEqual((self.base / 'existing/kept').read_text(), 'keep')

    def test_no_repository_no_commit_no_git_and_ignored_paths_are_explicit(self):
        folder = self.base / 'empty'; folder.mkdir(); empty = TaskGit(str(folder))
        with self.assertRaises(CollaborationError): empty.inspect()
        self.assertFalse((folder / '.git').exists())
        empty.run('init')
        with self.assertRaises(CollaborationError): empty.inspect()
        with patch('src.backend.task_git.shutil.which', return_value=None), self.assertRaisesRegex(CollaborationError, '未安装'): TaskGit(str(self.root))
        with self.assertRaises(CollaborationError): self.create('ignored', selected=['ignored.txt'])
        for name in ['../escape', '.git/config', 'C:/outside', '.env']:
            with self.assertRaises(ValueError): self.create('invalid', selected=[name])

    def test_checkout_disables_local_filters_and_hooks(self):
        (self.root / '.gitattributes').write_text('same.txt filter=unsafe\n', encoding='utf-8')
        self.git.run('add', '.gitattributes'); self.git.run('commit', '-m', 'attributes')
        self.git.run('config', 'filter.unsafe.smudge', 'nonexistent-command-must-not-run')
        self.git.run('config', 'filter.unsafe.required', 'true')
        hook = self.root / '.git/hooks/post-checkout'
        hook.write_text('#!/bin/sh\nexit 99\n'); hook.chmod(0o755)
        self.create('filtered')
        self.assertEqual((self.base / 'filtered/same.txt').read_text(), 'baseline\n')

    def test_managed_git_comparison_requires_exact_root_common_dir_owner_and_backlink(self):
        from src.backend.engine_workbench import WorkspaceIdentity, WorkbenchError
        from src.backend.workspace_search import git_comparison
        actual = self.create('managed')
        identity = WorkspaceIdentity('owner', 'executor', 'task', actual['root'], 'revision')
        authority = {**actual, 'ownerId': 'owner', 'sessionId': 'task'}
        with self.assertRaises(WorkbenchError): git_comparison(identity, 'same.txt', threading.Event())
        result = git_comparison(identity, 'same.txt', threading.Event(), managed=authority)
        self.assertEqual(result['baseline']['text'], 'baseline\n')
        for patch_fields in [{'ownerId': 'other'}, {'sessionId': 'other'}, {'commonDir': str(self.base)}, {'root': str(self.root)}, {'repositoryId': 'wrong'}]:
            with self.assertRaises(WorkbenchError): git_comparison(identity, 'same.txt', threading.Event(), managed={**authority, **patch_fields})
        gitdir = Path(actual['gitDir']); (gitdir / 'gitdir').write_text(str(self.root / '.git'), encoding='utf-8')
        with self.assertRaises(WorkbenchError): git_comparison(identity, 'same.txt', threading.Event(), managed=authority)

"""Git 元数据扫描只使用临时目录，覆盖规模、worktree 重叠和拒绝不安全边界。"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from src.backend.session_collaboration_store import CollaborationError
from src.backend.task_git import _check_git_metadata


class GitMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='awu-git-metadata-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.common = self.root / 'repo' / '.git'
        self.common.mkdir(parents=True)

    def test_thousands_of_objects_and_linked_worktree_check_concurrently(self):
        # 旧实现对每个对象重复检查祖先，双预览会耗尽 8 秒预算。
        for fanout in range(32):
            directory = self.common / 'objects' / f'{fanout:02x}'
            directory.mkdir(parents=True)
            for item in range(160):
                (directory / f'{item:038x}').touch()
        child = self.common / 'worktrees' / 'branch-copy'
        child.mkdir(parents=True)
        (child / 'HEAD').write_text('ref: refs/heads/awu/task/fixture\n', encoding='utf-8')
        with ThreadPoolExecutor(max_workers=2) as pool:
            main = pool.submit(_check_git_metadata, str(self.common), str(self.common))
            copy = pool.submit(_check_git_metadata, str(self.common), str(child))
            main.result(timeout=15)
            copy.result(timeout=15)

    def test_nested_git_dir_is_not_double_counted_and_count_limit_is_explicit(self):
        child = self.common / 'worktrees' / 'copy'
        child.mkdir(parents=True)
        (child / 'HEAD').touch()
        # 三个条目：worktrees、copy 和 HEAD；git-dir 重叠不消耗第二份预算。
        with patch('src.backend.task_git.MAX_GIT_METADATA_ENTRIES', 3):
            _check_git_metadata(str(self.common), str(child))
        with patch('src.backend.task_git.MAX_GIT_METADATA_ENTRIES', 2):
            with self.assertRaisesRegex(CollaborationError, r'条目超过检查上限（2 项）'):
                _check_git_metadata(str(self.common), str(child))

    def test_timeout_reports_time_budget_not_entry_count(self):
        with patch('src.backend.task_git.time.monotonic', side_effect=[0, 9]):
            with self.assertRaisesRegex(CollaborationError, r'检查超时（8 秒，已检查 0 项）'):
                _check_git_metadata(str(self.common))

    def test_external_objects_are_still_rejected(self):
        info = self.common / 'objects' / 'info'
        info.mkdir(parents=True)
        for name in ('alternates', 'http-alternates'):
            with self.subTest(name=name):
                path = info / name
                path.write_text('/outside/objects', encoding='utf-8')
                with self.assertRaisesRegex(CollaborationError, '外部 Git 对象库'):
                    _check_git_metadata(str(self.common))
                path.unlink()

    def test_unreadable_directory_is_not_silently_skipped(self):
        with patch('src.backend.task_git.os.scandir', side_effect=PermissionError('fixture denied')):
            with self.assertRaisesRegex(CollaborationError, '元数据无法读取'):
                _check_git_metadata(str(self.common))

    def test_unreadable_entry_is_not_silently_skipped(self):
        entry = Mock(name='unreadable-entry')
        entry.stat.side_effect = FileNotFoundError('fixture changed during scan')
        with patch('src.backend.task_git.os.scandir') as scan:
            scan.return_value.__enter__.return_value = iter([entry])
            with self.assertRaisesRegex(CollaborationError, '元数据无法读取'):
                _check_git_metadata(str(self.common))

    def test_symlink_and_windows_reparse_attributes_are_rejected_without_following(self):
        for mode, attributes in ((stat.S_IFLNK, 0), (stat.S_IFDIR, 0x400), (stat.S_IFREG, 0x400)):
            with self.subTest(mode=mode, attributes=attributes):
                entry = Mock()
                entry.stat.return_value = SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                with patch('src.backend.task_git.os.scandir') as scan:
                    scan.return_value.__enter__.return_value = iter([entry])
                    with self.assertRaisesRegex(CollaborationError, '符号链接或重解析点'):
                        _check_git_metadata(str(self.common))
                entry.stat.assert_called_once_with(follow_symlinks=False)

    def test_linked_parent_directory_remains_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        link = self.common / 'linked'
        try:
            os.symlink(outside, link, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'当前测试账户不能创建符号链接：{error}')
        try:
            with self.assertRaisesRegex(CollaborationError, '符号链接或重解析点'):
                _check_git_metadata(str(link))
        finally:
            # 只移除本测试链接，不递归操作目标目录。
            link.unlink()


if __name__ == '__main__':
    unittest.main()

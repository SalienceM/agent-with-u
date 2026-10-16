import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.aside_files import ReadonlyFiles
from src.backend.aside_inspection import InspectionError, QueryBudget, QueryIdentity


class ReadonlyFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.identity = QueryIdentity('u', 'node', 's', str(self.root), 'b', 't')
        self.files = ReadonlyFiles(self.identity, QueryBudget())
        (self.root / 'code.txt').write_text('hello\nworld\n', encoding='utf-8', newline='')

    def test_absolute_relative_read_pages_and_reuse(self):
        first = self.files.text('code.txt', limit=5)
        self.assertEqual(first['content'], 'hello')
        self.assertFalse(first['complete'])
        used = self.files.budget.used_bytes
        rest = self.files.text(str(self.root / 'code.txt'), offset=5, revision=first['revision'])
        self.assertEqual(rest['content'], '\nworld\n')
        self.assertEqual(used, self.files.budget.used_bytes)
        self.assertEqual(self.files.directory()['entries'], [{'name': 'code.txt', 'directory': False}])

    def test_special_paths_and_secrets_denied(self):
        for path in ('../escape', str(self.root) + '-other/file', '.env', 'auth.json',
                     'id_rsa', 'code.txt:stream', '\\\\?\\C:\\file', '\\\\server\\share', '.git/config'):
            with self.subTest(path=path), self.assertRaises(InspectionError):
                self.files.text(path)
        (self.root / 'binary').write_bytes(b'a\0b')
        with self.assertRaises(InspectionError):
            self.files.text('binary')
        (self.root / 'renamed.txt').write_text('-----BEGIN RSA PRIVATE KEY-----\nsecret', encoding='utf-8')
        with self.assertRaisesRegex(InspectionError, '私钥'):
            self.files.text('renamed.txt')

    def test_revision_changes_and_file_limit(self):
        first = self.files.text('code.txt', limit=2)
        (self.root / 'code.txt').write_text('different', encoding='utf-8')
        with self.assertRaisesRegex(InspectionError, '修订'):
            self.files.text('code.txt', offset=2, revision=first['revision'])
        (self.root / 'big.txt').write_bytes(b'x' * 262145)
        with self.assertRaisesRegex(InspectionError, '256'):
            self.files.text('big.txt')

    def test_change_during_read_never_returns_mixed_content(self):
        original = os.read
        def read(fd, amount):
            result = original(fd, amount)
            (self.root / 'code.txt').write_text('changed concurrently', encoding='utf-8')
            return result
        with patch('src.backend.aside_files.os.read', side_effect=read):
            with self.assertRaisesRegex(InspectionError, '期间变化'):
                self.files.text('code.txt')

    def test_directory_page_and_search_are_bounded(self):
        for n in range(205):
            (self.root / f'{n}.txt').write_text('needle', encoding='utf-8')
        page = self.files.directory()
        self.assertFalse(page['complete'])
        self.assertEqual(page['nextOffset'], 200)
        result = self.files.search('.', 'needle', limit=2)
        self.assertEqual(len(result['matches']), 2)
        self.assertFalse(result['complete'])

    @unittest.skipUnless(os.name == 'nt', 'Windows junction fixture')
    def test_windows_junction_cannot_escape(self):
        with tempfile.TemporaryDirectory() as outside:
            (Path(outside) / 'secret.txt').write_text('DO_NOT_RETURN', encoding='utf-8')
            junction = self.root / 'link'
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), outside],
                                    capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0, result.stderr)
            with self.assertRaises(InspectionError):
                self.files.text('link/secret.txt')
            self.assertNotIn('link', [entry['name'] for entry in self.files.directory()['entries']])
            junction.rmdir()

    @unittest.skipUnless(os.name == 'nt', 'Windows handle ownership fixture')
    def test_windows_handle_pins_target_against_replacement(self):
        from src.backend.aside_files import _win_validate
        checked = []
        def validate(handle, expected, directory):
            _win_validate(handle, expected, directory)
            if expected == self.root / 'code.txt':
                with self.assertRaises(OSError):
                    expected.rename(self.root / 'moved.txt')
                checked.append(True)
        with patch('src.backend.aside_files._win_validate', side_effect=validate):
            self.assertEqual(self.files.text('CODE.txt')['content'], 'hello\nworld\n')
        self.assertTrue(checked)


if __name__ == '__main__':
    unittest.main()

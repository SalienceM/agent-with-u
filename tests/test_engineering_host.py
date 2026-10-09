"""宿主放行后才设置 ConPTY；不在测试 runner 的控制台上改全局属性。"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import unittest

from src.backend.engineering_host import Host


class HostTests(unittest.TestCase):
    def test_conpty_resets_inherited_ctrl_c_ignore_before_spawn(self):
        host = Host.__new__(Host)
        host.process = host.pty = host.master = None
        host.children = None; host.threads = []
        calls = []
        factory = MagicMock(side_effect=lambda *a, **k: calls.append('pty') or MagicMock())
        reset = MagicMock(side_effect=lambda *a: calls.append('reset') or 1)
        payload = {'argv': [str(Path(__file__).resolve())], 'cwd': str(Path.cwd()), 'env': {}, 'mode': 'pty', 'cols': 80, 'rows': 24}
        fake_os = SimpleNamespace(name='nt')
        with patch('src.backend.engineering_host.os', fake_os), patch('src.backend.engineering_host.ctypes.windll',
                SimpleNamespace(kernel32=SimpleNamespace(SetConsoleCtrlHandler=reset)), create=True), \
                patch.dict('sys.modules', {'winpty': SimpleNamespace(PTY=factory), 'winpty.enums': SimpleNamespace(Backend=SimpleNamespace(ConPTY=1))}), \
                patch('src.backend.engineering_host.threading.Thread'):
            host.start(payload)
        reset.assert_called_once_with(None, False)
        self.assertEqual(calls, ['reset', 'pty'])
        host.pty.spawn.assert_called_once()

    def test_failed_ctrl_c_initialization_never_starts_shell(self):
        host = Host.__new__(Host)
        host.process = host.pty = host.master = None
        factory = MagicMock()
        with patch('src.backend.engineering_host.os', SimpleNamespace(name='nt')), \
                patch('src.backend.engineering_host.ctypes.windll', SimpleNamespace(kernel32=SimpleNamespace(SetConsoleCtrlHandler=lambda *a: 0)), create=True), \
                patch.dict('sys.modules', {'winpty': SimpleNamespace(PTY=factory), 'winpty.enums': SimpleNamespace(Backend=SimpleNamespace(ConPTY=1))}):
            with self.assertRaisesRegex(OSError, 'console control'):
                host.start({'argv': [str(Path(__file__).resolve())], 'cwd': str(Path.cwd()), 'env': {}, 'mode': 'pty'})
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()

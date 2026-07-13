import os
import unittest

from src.ws_main import _is_pid_alive


class WsMainProcessTests(unittest.TestCase):
    def test_current_process_is_alive(self):
        self.assertTrue(_is_pid_alive(os.getpid()))

    def test_pid_zero_is_not_alive(self):
        self.assertFalse(_is_pid_alive(0))


if __name__ == "__main__":
    unittest.main()

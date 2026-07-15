import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.session_store import SessionStore
from src.types import ChatMessage, Session


class SessionStoreRefreshTests(unittest.TestCase):
    def test_async_save_updates_list_index_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sessions"
            with patch("src.backend.session_store.paths.sub", return_value=root):
                store = SessionStore()
                session = Session(
                    id="session-1",
                    title="新会话",
                    created_at=1.0,
                    updated_at=1.0,
                    messages=[],
                    working_dir=tmp,
                    backend_id="backend-1",
                )

                store.save(session, async_=True)
                first = store.list()
                self.assertEqual(["session-1"], [item["id"] for item in first])
                self.assertEqual(0, first[0]["messageCount"])

                session.title = "立即可见的新标题"
                session.messages.append(ChatMessage(id="m1", role="user", content="hello"))
                store.save(session, async_=True)
                second = store.list()
                self.assertEqual("立即可见的新标题", second[0]["title"])
                self.assertEqual(1, second[0]["messageCount"])

                # list() 必须返回副本，调用方不能污染 store 的权威索引。
                second[0]["title"] = "被前端改坏"
                self.assertEqual("立即可见的新标题", store.list()[0]["title"])

                deadline = time.time() + 2
                session_path = root / "session-1.json"
                while not session_path.exists() and time.time() < deadline:
                    time.sleep(0.01)
                self.assertTrue(session_path.exists())

                store._io_running = False
                if store._io_thread:
                    store._io_thread.join(timeout=1)
                if store._index_save_timer:
                    store._index_save_timer.cancel()


if __name__ == "__main__":
    unittest.main()

"""
SessionStore: Manages session persistence as JSON files.

Sessions stored in ~/.agent-with-u/sessions/<id>.json
Index kept in ~/.agent-with-u/sessions/index.json for fast listing.

★ Optimizations:
- Batch index saves (debounced) to reduce I/O
- Session file writes are still synchronous for data safety
"""

import json
import os
import time
import threading
from pathlib import Path
from typing import Optional

from ..types import Session, ChatMessage, ImageAttachment, ToolCallInfo


class SessionStore:
    def __init__(self):
        self._dir = Path.home() / ".agent-with-u" / "sessions"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self._dir / "index.json"
        self._index: dict[str, dict] = {}
        self._load_index()

        # ★ Debounced index save
        self._index_dirty = False
        self._index_save_timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

        # ★ Worker thread for async file I/O
        self._io_queue: list = []
        self._io_thread: Optional[threading.Thread] = None
        self._io_running = False
        self._start_io_thread()

    def _start_io_thread(self):
        """Start background thread for file I/O operations."""
        def io_loop():
            self._io_running = True
            while self._io_running:
                work_items = []
                with self._lock:
                    if self._io_queue:
                        work_items = self._io_queue[:]
                        self._io_queue.clear()

                # Execute outside lock
                for func, args in work_items:
                    try:
                        func(*args)
                    except Exception as e:
                        print(f"IO thread error: {e}")

                # Small sleep to avoid busy-waiting
                time.sleep(0.01)

        self._io_thread = threading.Thread(target=io_loop, daemon=True)
        self._io_thread.start()

    def _queue_io_operation(self, func, *args):
        """Queue an I/O operation for background execution."""
        with self._lock:
            self._io_queue.append((func, args))

    def _load_index(self):
        if self._index_path.exists():
            try:
                data = json.loads(self._index_path.read_text(encoding="utf-8"))
                self._index = {item["id"]: item for item in data}
            except Exception:
                self._index = {}

    def _save_index_sync(self):
        """Synchronously save index (used on shutdown)."""
        with self._lock:
            entries = sorted(self._index.values(), key=lambda x: x.get("updatedAt", 0), reverse=True)
            self._index_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
            self._index_dirty = False

    def _save_index_debounced(self):
        """Schedule index save with 500ms debounce to reduce I/O."""
        with self._lock:
            # Cancel pending save
            if self._index_save_timer:
                self._index_save_timer.cancel()
            # Schedule new save
            self._index_save_timer = threading.Timer(0.5, self._save_index_sync)
            self._index_save_timer.start()
            self._index_dirty = True

    def _session_path(self, sid: str) -> Path:
        return self._dir / f"{sid}.json"

    def list(self) -> list[dict]:
        return sorted(self._index.values(), key=lambda x: x.get("updatedAt", 0), reverse=True)

    def load(self, sid: str) -> Optional[Session]:
        path = self._session_path(sid)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            messages = []
            for m in data.get("messages", []):
                images = None
                if m.get("images"):
                    images = [ImageAttachment(**img) for img in m["images"]]
                tool_calls = None
                if m.get("toolCalls"):
                    tool_calls = [ToolCallInfo(**tc) for tc in m["toolCalls"]]
                messages.append(ChatMessage(
                    id=m["id"],
                    role=m["role"],
                    content=m["content"],
                    timestamp=m.get("timestamp", 0),
                    images=images,
                    backend_id=m.get("backendId"),
                    usage=m.get("usage"),
                    tool_calls=tool_calls,
                    streaming=False,
                ))
            return Session(
                id=data["id"],
                title=data["title"],
                created_at=data["createdAt"],
                updated_at=data["updatedAt"],
                messages=messages,
                backend_id=data["backendId"],
                agent_session_id=data.get("agentSessionId"),
                working_dir=data.get("workingDir"),
            )
        except Exception as e:
            print(f"Failed to load session {sid}: {e}")
            return None

    def save(self, session: Session, async_: bool = True):
        """Save session to disk. Default is async to avoid blocking UI.

        Args:
            session: Session to save
            async_: If True (default), queue I/O in background thread
        """
        session.updated_at = time.time()

        if async_:
            # Queue I/O operation for background execution
            self._queue_io_operation(self._save_sync_impl, session)
        else:
            self._save_sync_impl(session)

    def _save_sync_impl(self, session: Session):
        """Actual save implementation - can be run in background thread."""
        path = self._session_path(session.id)

        # ★ Write session file (synchronous for data safety)
        path.write_text(
            json.dumps(session.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # ★ Update index in memory
        self._index[session.id] = session.meta_dict()

        # ★ Debounced index save (reduces I/O from 2 writes → 1 delayed write)
        self._save_index_debounced()

    def delete(self, sid: str) -> bool:
        path = self._session_path(sid)
        try:
            if path.exists():
                path.unlink()
            self._index.pop(sid, None)
            self._save_index_sync()
            return True
        except Exception:
            return False

    def export(self, sid: str, target_path: str) -> bool:
        session = self.load(sid)
        if not session:
            return False
        try:
            Path(target_path).write_text(
                json.dumps(session.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return True
        except Exception:
            return False

    def export_all(self, target_path: str) -> bool:
        """Export all sessions and index to a tar file."""
        import tarfile
        try:
            with tarfile.open(target_path, "w:gz") as tar:
                # Add all session files
                for session_file in self._dir.glob("*.json"):
                    if session_file.name != "index.json":
                        tar.add(session_file, arcname=f"sessions/{session_file.name}")
                # Add index file
                if self._index_path.exists():
                    tar.add(self._index_path, arcname="sessions/index.json")
            return True
        except Exception as e:
            print(f"Failed to export sessions: {e}")
            return False

    def import_all(self, source_path: str) -> bool:
        """Import sessions from a tar file, overwriting existing data."""
        import tarfile
        try:
            with tarfile.open(source_path, "r:gz") as tar:
                # Extract to temp directory first
                import tempfile
                with tempfile.TemporaryDirectory() as tmpdir:
                    tar.extractall(tmpdir)

                    # Copy session files
                    sessions_dir = Path(tmpdir) / "sessions"
                    if sessions_dir.exists():
                        # Copy individual session files
                        for session_file in sessions_dir.glob("*.json"):
                            if session_file.name != "index.json":
                                dest = self._dir / session_file.name
                                dest.write_text(session_file.read_text(encoding="utf-8"), encoding="utf-8")

                        # Copy and merge index
                        index_src = sessions_dir / "index.json"
                        if index_src.exists():
                            # Load existing index
                            existing_ids = set(self._index.keys())
                            # Load imported index
                            imported_data = json.loads(index_src.read_text(encoding="utf-8"))
                            imported_index = {item["id"]: item for item in imported_data}
                            # Merge: imported data overwrites existing
                            self._index.update(imported_index)
                            # Mark dirty for save
                            self._index_dirty = True
                            self._save_index_sync()

                    # Reload index to sync with disk
                    self._load_index()
            return True
        except Exception as e:
            print(f"Failed to import sessions: {e}")
            return False

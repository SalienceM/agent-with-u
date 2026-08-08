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

from ..types import Session, ChatMessage, ImageAttachment, TextAttachment, ToolCallInfo
from . import paths


class SessionStore:
    def __init__(self):
        self._dir = paths.sub("sessions")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self._dir / "index.json"
        self._index: dict[str, dict] = {}
        # ★ Debounced index save
        self._index_dirty = False
        self._index_save_timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()
        self._load_index()

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
                with self._lock:
                    self._index = {item["id"]: item for item in data}
            except Exception:
                with self._lock:
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
        with self._lock:
            # 返回副本，避免调用方排序/合并时意外改写内存索引。
            snapshot = [dict(item) for item in self._index.values()]
        return sorted(snapshot, key=lambda x: x.get("updatedAt", 0), reverse=True)

    def get_meta(self, sid: str) -> Optional[dict]:
        """从内存索引读取轻量元数据；不解析可能很大的 session 正文文件。"""
        with self._lock:
            item = self._index.get(sid)
            return dict(item) if item else None

    def update_meta(self, session: Session) -> None:
        """立即更新会话列表使用的内存索引，不等待后台磁盘 I/O。"""
        meta = session.meta_dict()
        with self._lock:
            self._index[session.id] = meta

    def save_meta(
        self,
        session: Session,
        *,
        touch_updated: bool = True,
        immediate: bool = False,
    ) -> None:
        """只持久化 index 摘要，不重写可能很大的消息正文文件。

        侧栏收藏/底色不应把会话伪装成“刚完成一次对话”，因此这类调用会
        touch_updated=False；用户点击后又希望立刻跨重启可靠，使用 immediate=True。
        """
        if touch_updated:
            session.updated_at = time.time()
        self.update_meta(session)
        if immediate:
            self._save_index_sync()
        else:
            self._save_index_debounced()

    def load(self, sid: str) -> Optional[Session]:
        path = self._session_path(sid)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            # sidebar 元数据可独立于巨型 Session 正文落盘；索引是其权威来源。
            # 这样收藏/换色不会为了一次轻量操作重新序列化全部历史消息。
            meta = {}
            if hasattr(self, "_lock"):
                meta = self.get_meta(sid) or {}
            messages = []
            for m in data.get("messages", []):
                images = None
                if m.get("images"):
                    _valid_keys = {"id", "base64", "mime_type", "size", "width", "height", "file_path"}
                    images = [
                        ImageAttachment(**{k: v for k, v in img.items() if k in _valid_keys})
                        for img in m["images"]
                    ]
                text_attachments = None
                if m.get("textAttachments"):
                    _text_keys = {"id", "name", "content", "size", "source"}
                    text_attachments = [
                        TextAttachment(**{k: v for k, v in item.items() if k in _text_keys})
                        for item in m["textAttachments"]
                        if isinstance(item, dict)
                    ]
                tool_calls = None
                if m.get("toolCalls"):
                    tool_calls = [ToolCallInfo(**tc) for tc in m["toolCalls"]]
                messages.append(ChatMessage(
                    id=m["id"],
                    role=m["role"],
                    content=m["content"],
                    timestamp=m.get("timestamp", 0),
                    images=images,
                    text_attachments=text_attachments,
                    backend_id=m.get("backendId"),
                    usage=m.get("usage"),
                    tool_calls=tool_calls,
                    streaming=False,
                    delivery_mode=(
                        m.get("deliveryMode")
                        if m.get("deliveryMode") in {"steer", "redirect"}
                        else None
                    ),
                ))
            return Session(
                id=data["id"],
                title=data["title"],
                created_at=data["createdAt"],
                updated_at=data["updatedAt"],
                messages=messages,
                backend_id=data["backendId"],
                model_override=data.get("modelOverride"),
                reasoning_effort=data.get("reasoningEffort"),
                agent_session_id=data.get("agentSessionId"),
                codex_connection_mode=data.get("codexConnectionMode"),
                codex_remote_host=data.get("codexRemoteHost"),
                # 旧版 node 模式只允许选择既有 thread，可安全迁移为 attached。
                codex_thread_attached=bool(data.get(
                    "codexThreadAttached", data.get("codexConnectionMode") == "node",
                )),
                codex_sync_last_item_id=data.get("codexSyncLastItemId"),
                codex_sync_local_count=max(0, int(data.get("codexSyncLocalCount") or 0)),
                working_dir=data.get("workingDir"),
                auto_continue=data.get("autoContinue", True),
                skip_permissions=data.get("skipPermissions", True),
                # 沙盒功能已下线（UI 移除、支持不完善），一律关闭，忽略历史持久值。
                sandbox_enabled=False,
                constraints=data.get("constraints"),
                abilities=data.get("abilities"),
                session_type=data.get("sessionType", "normal"),
                loop_control_mode=(
                    "manual" if data.get("loopControlMode") == "manual"
                    else "loop" if data.get("loopControlMode") == "loop"
                    else None
                ),
                pinned=bool(meta.get("pinned", data.get("pinned", False))),
                sidebar_color=str(meta.get("sidebarColor", data.get("sidebarColor", "")) or ""),
                auto_commit=data.get("autoCommit", False),
                auto_commit_push=data.get("autoCommitPush", False),
                auto_commit_backend_id=data.get("autoCommitBackendId"),
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
        # 正文可以异步落盘，但列表摘要必须立即可见。否则紧随事件而来的
        # listSessions 会读到旧索引，把前端的乐观更新覆盖回去。
        self.update_meta(session)

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

        # 写盘期间 session 仍可能产生新状态，再同步一次最新摘要。
        self.update_meta(session)

        # ★ Debounced index save (reduces I/O from 2 writes → 1 delayed write)
        self._save_index_debounced()

    def rename(self, sid: str, new_title: str) -> bool:
        """Rename a session title."""
        session = self.load(sid)
        if not session:
            return False
        session.title = new_title.strip()
        self.save(session, async_=False)
        return True

    def delete(self, sid: str) -> bool:
        path = self._session_path(sid)
        try:
            if path.exists():
                path.unlink()
            with self._lock:
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
                            # Load imported index
                            imported_data = json.loads(index_src.read_text(encoding="utf-8"))
                            imported_index = {item["id"]: item for item in imported_data}
                            # Merge: imported data overwrites existing
                            with self._lock:
                                self._index.update(imported_index)
                                self._index_dirty = True
                            self._save_index_sync()

                    # Reload index to sync with disk
                    self._load_index()
            return True
        except Exception as e:
            print(f"Failed to import sessions: {e}")
            return False

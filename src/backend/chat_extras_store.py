"""普通 session 的「侧挂」状态：序列任务队列 + By-the-way 旁路问答。

借鉴 loop 会话里两个好用的设计，下沉给普通会话复用，但放在独立的 sidecar 文件
``~/.agent-with-u/chat-extras/<session_id>.json``，不和主 session 文件（每条消息都
重写）抢写，避免与流式保存竞争。

- **序列任务 SeqTask**：用户预先排好的一串渐进明细的想法/指令。一条答完（模型整轮
  结束）再发下一条；可 auto 自动连发，也可手动一条条触发。未发送的随时可编辑/增删/
  调序。发送由前端的显式 done 信号驱动，但取队首前还必须由后端权威运行态确认主 turn
  已退出；error / Relay 重连都不算完成。队列本身存后端，多端同步、刷新不丢。
- **旁路问答 ChatAside**：随手问，跑在独立 agent 上下文（不 resume 主线、不进
  transcript），带最近几轮聊天的只读摘要，不污染主对话。
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import paths


def _now() -> float:
    return time.time()


def _nid() -> str:
    return str(uuid.uuid4())


@dataclass
class SeqTask:
    """序列任务队列里的一条。附件以 dict 列表落盘，派发时原样送回主消息链路。"""
    id: str
    text: str = ""
    images: list = field(default_factory=list)
    text_attachments: list = field(default_factory=list)
    status: str = "pending"   # pending | sent
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "images": list(self.images or []),
            "imageCount": len(self.images or []),
            "textAttachments": list(self.text_attachments or []),
            "textAttachmentCount": len(self.text_attachments or []),
            "status": self.status,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SeqTask":
        return cls(
            id=d.get("id") or _nid(),
            text=d.get("text", ""),
            images=list(d.get("images") or []),
            text_attachments=list(d.get("textAttachments") or []),
            status=d.get("status", "pending"),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class ChatAside:
    """一条 by-the-way 旁路问答（独立上下文，不污染主对话）。"""
    id: str
    question: str = ""
    answer: str = ""
    status: str = "answering"   # answering | done | error
    image_count: int = 0
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "answer": self.answer,
            "status": self.status,
            "imageCount": self.image_count,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ChatAside":
        return cls(
            id=d.get("id") or _nid(),
            question=d.get("question", ""),
            answer=d.get("answer", ""),
            status=d.get("status", "answering"),
            image_count=int(d.get("imageCount", 0) or 0),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class ChatExtras:
    """单个普通 session 的侧挂状态文件。"""
    session_id: str
    seq_tasks: list[SeqTask] = field(default_factory=list)
    seq_auto: bool = False
    asides: list[ChatAside] = field(default_factory=list)
    aside_backend_id: str = ""   # by-the-way 专用 backend（空=跟随会话 backend）
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def pending_tasks(self) -> list[SeqTask]:
        return [t for t in self.seq_tasks if t.status == "pending"]

    def to_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "seqTasks": [t.to_dict() for t in self.seq_tasks],
            "seqAuto": self.seq_auto,
            "asides": [a.to_dict() for a in self.asides],
            "asideBackendId": self.aside_backend_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ChatExtras":
        return cls(
            session_id=d.get("sessionId", ""),
            seq_tasks=[SeqTask.from_dict(x) for x in d.get("seqTasks", [])],
            seq_auto=bool(d.get("seqAuto", False)),
            asides=[ChatAside.from_dict(x) for x in d.get("asides", [])],
            aside_backend_id=d.get("asideBackendId", "") or "",
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


class ChatExtrasStore:
    """chat-extras sidecar 文件读写，线程安全。"""

    def __init__(self):
        self._dir = paths.sub("chat-extras")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, sid: str) -> Path:
        return self._dir / f"{sid}.json"

    def load(self, sid: str) -> Optional[ChatExtras]:
        path = self._path(sid)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return ChatExtras.from_dict(data)
        except Exception as e:
            print(f"[ChatExtrasStore] failed to load {sid}: {e}")
            return None

    def save(self, ex: ChatExtras) -> None:
        ex.updated_at = _now()
        with self._lock:
            self._path(ex.session_id).write_text(
                json.dumps(ex.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def create(self, sid: str) -> ChatExtras:
        ex = ChatExtras(session_id=sid)
        self.save(ex)
        return ex

    def delete(self, sid: str) -> None:
        try:
            self._path(sid).unlink(missing_ok=True)
        except Exception:
            pass

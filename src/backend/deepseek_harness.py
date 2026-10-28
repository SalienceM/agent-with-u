"""DeepSeek 官方 Harness 后端。可选 SDK 只在显式发送时导入。"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional

from ..types import ChatMessage, ImageAttachment
from .base import ModelBackend, PermissionRequest, StreamDelta


class DeepSeekHarnessBackend(ModelBackend):
    def abort(self, session_id: Optional[str] = None) -> None:
        super().abort(session_id)
        for sid, worker in list(getattr(self, "_harness_workers", {}).items()):
            if session_id is None or sid == session_id:
                worker.request_stop()

    def has_unconfirmed_activity(self, session_id: str) -> bool:
        worker = getattr(self, "_harness_workers", {}).get(session_id)
        return worker is not None and not worker.confirmed

    async def send_message(
        self, messages: list[ChatMessage], content: str, images: Optional[list[ImageAttachment]],
        session_id: str, message_id: str, on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None, working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None,
        constraints: Optional[str] = None, sandbox_enabled: bool = False, **kwargs: object,
    ) -> dict:
        from .deepseek_harness_turn import send_turn
        return await send_turn(
            self, messages=messages, content=content, images=images, session_id=session_id,
            message_id=message_id, on_delta=on_delta, agent_session_id=agent_session_id,
            working_dir=working_dir, skip_permissions=skip_permissions,
            on_permission_request=on_permission_request, constraints=constraints,
            sandbox_enabled=sandbox_enabled, **kwargs,
        )

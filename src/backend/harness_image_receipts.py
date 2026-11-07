"""Harness 图片提交的小型持久台账；不保存输入、图片或临时授权。"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, replace
import hashlib
import json
import re
import time
from typing import Any, Callable
from .deepseek_harness_images import IMAGE_POLICY_REASONS

VERSION = 1
STATES = frozenset({"platform_accepted", "queued", "submitting", "native_received",
                    "succeeded", "rejected", "failed", "cancelled", "unknown"})
TERMINAL = frozenset({"succeeded", "rejected", "failed", "cancelled"})
REASONS = frozenset({"", "preflight_rejected", "runtime_failed", "cancelled", "receipt_unknown",
                     "restarted", "storage_failed", "request_conflict", "route_changed", "queue_revised"}) | IMAGE_POLICY_REASONS
_ID = re.compile(r"[A-Za-z0-9_.:@-]{1,160}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")


class ReceiptError(ValueError):
    """错误不包含磁盘正文、输入载荷或调用者提供的字段。"""

    def __init__(self, code: str = "invalid_receipt") -> None:
        self.code = code if code in {"invalid_receipt", "request_conflict", "stale_receipt", "storage_failed"} else "invalid_receipt"
        super().__init__({"invalid_receipt": "图片提交记录无效，保留原状态且不重发",
                          "request_conflict": "相同 requestId 的输入或身份不一致，未重复提交",
                          "stale_receipt": "图片提交记录已变化，不能用旧回执覆盖",
                          "storage_failed": "图片提交记录保存失败，未启动新提交"}[self.code])


def valid_id(value: Any, *, optional: bool = False) -> str:
    if optional and value == "":
        return ""
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ReceiptError()
    return value


def payload_digest(payload: dict[str, Any]) -> str:
    """只哈希明确的输入字段；独立开关/动态工具令牌不进入恢复台账。"""
    keys = ("content", "images", "textAttachments", "backendId", "workingDir",
            "modelOverride", "reasoningEffort", "skipPermissions", "autoContinue",
            "draftRevision", "userMessageId", "messageId", "skillInvocation")
    selected = {key: payload[key] for key in keys if key in payload}
    try:
        encoded = json.dumps(selected, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise ReceiptError() from None
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ImageSubmission:
    request_id: str
    digest: str
    owner_id: str
    executor_id: str
    session_id: str
    backend_id: str
    user_message_id: str
    assistant_message_id: str
    draft_revision: int
    queue_id: str = ""
    queue_revision: int = 0
    state: str = "platform_accepted"
    native_received: bool = False
    reason: str = ""
    revision: int = 1
    created_at: float = 0
    updated_at: float = 0
    # 内部核对信息，终态可压缩；不返回前端或日志。
    route_fingerprint: str = ""
    generation: str = ""
    dispatch_backend_id: str = ""

    def __post_init__(self) -> None:
        for key in ("request_id", "owner_id", "executor_id", "session_id", "backend_id",
                    "user_message_id", "assistant_message_id"):
            valid_id(getattr(self, key))
        valid_id(self.queue_id, optional=True)
        valid_id(self.generation, optional=True)
        valid_id(self.dispatch_backend_id, optional=True)
        if not isinstance(self.digest, str) or not _HASH.fullmatch(self.digest):
            raise ReceiptError()
        if self.route_fingerprint and (not isinstance(self.route_fingerprint, str)
                                       or not _HASH.fullmatch(self.route_fingerprint)):
            raise ReceiptError()
        for value in (self.draft_revision, self.queue_revision, self.revision):
            if type(value) is not int or value < 0 or value > 2**53 - 1:
                raise ReceiptError()
        if self.revision < 1 or self.state not in STATES or self.reason not in REASONS:
            raise ReceiptError()
        if type(self.native_received) is not bool:
            raise ReceiptError()
        if self.state in {"native_received", "succeeded", "failed"} and not self.native_received:
            raise ReceiptError()
        if self.state in {"platform_accepted", "queued", "submitting", "rejected"} and self.native_received:
            raise ReceiptError()
        for stamp in (self.created_at, self.updated_at):
            if type(stamp) not in {int, float} or not 0 <= stamp < 1e12:
                raise ReceiptError()

    def public(self) -> dict[str, Any]:
        return {"version": VERSION, "requestId": self.request_id, "ownerId": self.owner_id,
                "executorId": self.executor_id, "sessionId": self.session_id,
                "backendId": self.backend_id, "dispatchBackendId": self.dispatch_backend_id,
                "userMessageId": self.user_message_id,
                "messageId": self.assistant_message_id, "draftRevision": self.draft_revision,
                "queueId": self.queue_id, "queueRevision": self.queue_revision,
                "state": self.state, "nativeReceived": self.native_received,
                "reason": self.reason, "revision": self.revision,
                "createdAt": self.created_at, "updatedAt": self.updated_at}

    def to_dict(self) -> dict[str, Any]:
        result = {**self.public(), "payloadDigest": self.digest}
        if self.route_fingerprint:
            result["routeFingerprint"] = self.route_fingerprint
        if self.generation:
            result["generation"] = self.generation
        return result

    @classmethod
    def from_dict(cls, value: Any) -> "ImageSubmission":
        if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != VERSION:
            raise ReceiptError()
        try:
            return cls(request_id=value["requestId"], digest=value["payloadDigest"],
                       owner_id=value["ownerId"], executor_id=value["executorId"], session_id=value["sessionId"],
                       backend_id=value["backendId"], user_message_id=value["userMessageId"],
                       assistant_message_id=value["messageId"], draft_revision=value["draftRevision"],
                       queue_id=value.get("queueId", ""), queue_revision=value.get("queueRevision", 0),
                       state=value["state"], native_received=value["nativeReceived"], reason=value.get("reason", ""),
                       revision=value["revision"], created_at=value["createdAt"], updated_at=value["updatedAt"],
                       route_fingerprint=value.get("routeFingerprint", ""), generation=value.get("generation", ""),
                       dispatch_backend_id=value.get("dispatchBackendId", ""))
        except (KeyError, TypeError):
            raise ReceiptError() from None

    def advance(self, state: str, *, reason: str = "", generation: str = "") -> "ImageSubmission":
        transitions = {
            "queued": {"platform_accepted", "rejected", "cancelled", "unknown"},
            "platform_accepted": {"submitting", "rejected", "cancelled", "unknown"},
            "submitting": {"native_received", "rejected", "unknown"},
            "native_received": {"succeeded", "failed", "cancelled", "unknown"},
            # unknown 仅由同一归属调用的真实证据收口；查询本身不调用此方法。
            "unknown": {"native_received", "succeeded", "failed", "cancelled", "rejected"},
        }
        if state not in transitions.get(self.state, set()):
            raise ReceiptError("stale_receipt")
        return replace(self, state=state, reason=reason,
                       native_received=self.native_received or state == "native_received",
                       revision=self.revision + 1, updated_at=time.time(), generation=generation or self.generation)


def load_records(value: Any, session_id: str) -> dict[str, ImageSubmission]:
    if value is None:
        return {}
    if not isinstance(value, list):
        raise ReceiptError()
    records: dict[str, ImageSubmission] = {}
    for raw in value:
        record = ImageSubmission.from_dict(raw)
        if record.session_id != session_id or record.request_id in records:
            raise ReceiptError()
        records[record.request_id] = record
    return records


def compact_records(records: dict[str, ImageSubmission], *, recent: int = 64) -> dict[str, ImageSubmission]:
    """压缩终态内部信息而非丢弃去重键；历史仍在时永不变成新请求。"""
    terminal = sorted((item for item in records.values() if item.state in TERMINAL),
                      key=lambda item: item.updated_at, reverse=True)
    retained = {item.request_id for item in terminal[:max(0, recent)]}
    return {key: replace(item, route_fingerprint="", generation="")
            if item.state in TERMINAL and key not in retained else item
            for key, item in records.items()}


def recover_records(records: dict[str, ImageSubmission]) -> dict[str, ImageSubmission]:
    """仅首次载入进程缓存时调用；重启后的在途请求没有重放资格。"""
    return {key: item.advance("unknown", reason="restarted")
            if item.state in {"platform_accepted", "submitting", "native_received"} else item
            for key, item in records.items()}


def commit_record(extras: Any, record: ImageSubmission, save: Callable[[Any], None],
                  *, expected_revision: int | None = None) -> tuple[ImageSubmission, bool]:
    """事件循环同步提交：先原子落盘，再安装缓存；调用者仅在 created 后启动副作用。"""
    if record.session_id != extras.session_id:
        raise ReceiptError()
    current = extras.harness_image_submissions.get(record.request_id)
    if expected_revision is None and current:
        identity = ("digest", "owner_id", "executor_id", "session_id", "backend_id",
                    "user_message_id", "assistant_message_id", "draft_revision", "queue_id", "queue_revision")
        if any(getattr(current, key) != getattr(record, key) for key in identity):
            raise ReceiptError("request_conflict")
        return current, False
    if expected_revision is not None and (not current or current.revision != expected_revision
                                         or record.revision != expected_revision + 1):
        raise ReceiptError("stale_receipt")
    if current and any(getattr(current, key) != getattr(record, key) for key in
                       ("digest", "owner_id", "executor_id", "session_id", "backend_id",
                        "user_message_id", "assistant_message_id", "draft_revision", "queue_id", "queue_revision")):
        raise ReceiptError("request_conflict")
    candidate = deepcopy(extras)
    candidate.harness_image_submissions[record.request_id] = record
    candidate.harness_image_submissions = compact_records(candidate.harness_image_submissions)
    try:
        save(candidate)
    except Exception:
        raise ReceiptError("storage_failed") from None
    # 不替换单例对象，避免别处持有的 queue/aside 引用变成旧快照。
    extras.harness_image_submissions = candidate.harness_image_submissions
    extras.updated_at = candidate.updated_at
    return extras.harness_image_submissions[record.request_id], current is None

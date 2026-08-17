"""Relay 轻量用户档案与执行端授权存储。

Relay 仍然不保存 Session；这里只保存身份档案、用户令牌摘要，以及每个用户
获准访问的执行端 ``deviceId``。同一个执行端可以授权给多个用户；Session 的
``ownerId`` 才是隔离边界。每个执行端还可指定一名主用户，只有主用户能够在
该执行端认领升级前没有归属信息的历史 Session。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_AVATAR_RE = re.compile(
    r"^data:image/(?P<kind>png|jpeg|webp);base64,(?P<data>[A-Za-z0-9+/=\r\n]+)$",
    re.IGNORECASE,
)
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_MAX_AVATAR_BYTES = 384 * 1024


class RelayUserError(ValueError):
    """用户档案或授权配置不合法。"""


def default_users_file() -> Path:
    configured = os.environ.get("AGENT_WITH_U_RELAY_USERS_FILE", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".agent-with-u-relay" / "users.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _normalize_username(value: object) -> str:
    username = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not 1 <= len(username) <= 40:
        raise RelayUserError("username must contain 1-40 characters")
    if any(ord(ch) < 32 or ch in "\\/" for ch in username):
        raise RelayUserError("username contains unsupported characters")
    return username


def _normalize_display_name(value: object, fallback: str) -> str:
    display_name = unicodedata.normalize("NFKC", str(value or "")).strip() or fallback
    if len(display_name) > 60 or any(ord(ch) < 32 for ch in display_name):
        raise RelayUserError("displayName must contain at most 60 visible characters")
    return display_name


def _normalize_avatar(value: object) -> str:
    avatar = str(value or "").strip()
    if not avatar:
        return ""
    matched = _AVATAR_RE.fullmatch(avatar)
    if not matched:
        raise RelayUserError("avatarData must be a PNG/JPEG/WebP data URL")
    try:
        decoded = base64.b64decode(matched.group("data"), validate=True)
    except Exception as exc:
        raise RelayUserError("avatarData contains invalid base64") from exc
    if not decoded or len(decoded) > _MAX_AVATAR_BYTES:
        raise RelayUserError(f"avatar image must be 1-{_MAX_AVATAR_BYTES // 1024} KiB")
    return avatar


def _normalize_color(value: object) -> str:
    color = str(value or "").strip() or "#64748b"
    if not _COLOR_RE.fullmatch(color):
        raise RelayUserError("avatarColor must use #RRGGBB")
    return color.lower()


def _token_hash(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(32)


class RelayUserStore:
    """JSON-backed Relay user store with cheap external-change detection."""

    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path is not None else default_users_file()
        self._data: dict[str, Any] = {
            "version": 2,
            "users": [],
            "deviceDefaults": {},
        }
        self._stamp: tuple[int, int] | None = None
        self._load(force=True)

    @property
    def enabled(self) -> bool:
        self._load()
        # 文件一旦存在就进入 fail-closed 多用户模式；即使管理员删除最后一个
        # 用户，也不能悄悄降级成“主 token 可登录 UI”的旧模式。
        return self._stamp is not None

    def _file_stamp(self) -> tuple[int, int] | None:
        try:
            stat = self.path.stat()
            return stat.st_mtime_ns, stat.st_size
        except OSError:
            return None

    def _load(self, *, force: bool = False) -> None:
        stamp = self._file_stamp()
        if not force and stamp == self._stamp:
            return
        if stamp is None:
            self._data = {"version": 2, "users": [], "deviceDefaults": {}}
            self._stamp = None
            return
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RelayUserError(f"cannot read Relay users file: {exc}") from exc
        users = loaded.get("users") if isinstance(loaded, dict) else None
        if not isinstance(users, list):
            raise RelayUserError("Relay users file must contain a users array")
        raw_defaults = loaded.get("deviceDefaults") if isinstance(loaded, dict) else None
        defaults = {
            str(device).strip(): str(user_id).strip()
            for device, user_id in (raw_defaults.items() if isinstance(raw_defaults, dict) else [])
            if str(device).strip() and str(user_id).strip()
        }
        self._data = {
            "version": 2,
            "users": [u for u in users if isinstance(u, dict)],
            "deviceDefaults": defaults,
        }
        self._stamp = stamp

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self._data, ensure_ascii=False, indent=2) + "\n"
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=str(self.path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(temp_name, 0o600)
            except OSError:
                pass
            os.replace(temp_name, self.path)
        finally:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
        self._stamp = self._file_stamp()

    def _users(self) -> list[dict[str, Any]]:
        self._load()
        return self._data["users"]

    def _find(self, identifier: str) -> dict[str, Any] | None:
        wanted = str(identifier or "").strip()
        folded = wanted.casefold()
        for user in self._users():
            if str(user.get("userId") or "") == wanted:
                return user
            if str(user.get("username") or "").casefold() == folded:
                return user
        return None

    @staticmethod
    def public_profile(user: dict[str, Any]) -> dict[str, Any]:
        return {
            "userId": str(user.get("userId") or ""),
            "username": str(user.get("username") or ""),
            "displayName": str(user.get("displayName") or user.get("username") or ""),
            "avatarData": str(user.get("avatarData") or ""),
            "avatarColor": str(user.get("avatarColor") or "#64748b"),
            "managed": True,
        }

    def admin_profile(self, user: dict[str, Any]) -> dict[str, Any]:
        profile = self.public_profile(user)
        user_id = str(user.get("userId") or "")
        profile.update({
            "disabled": bool(user.get("disabled", False)),
            "deviceIds": sorted({str(v) for v in user.get("deviceIds", []) if str(v)}),
            "defaultDeviceIds": sorted(
                device_id for device_id, default_user_id in self._device_defaults().items()
                if default_user_id == user_id
            ),
            "createdAt": str(user.get("createdAt") or ""),
            "updatedAt": str(user.get("updatedAt") or ""),
        })
        return profile

    def _device_defaults(self) -> dict[str, str]:
        defaults = self._data.get("deviceDefaults")
        if not isinstance(defaults, dict):
            defaults = {}
            self._data["deviceDefaults"] = defaults
        return defaults

    def list_users(self) -> list[dict[str, Any]]:
        return [self.admin_profile(user) for user in self._users()]

    def get_user(self, identifier: str) -> dict[str, Any] | None:
        """按稳定 userId（也兼容 username）读取当前磁盘版本。"""
        return self._find(identifier)

    def create_user(
        self,
        username: str,
        *,
        display_name: str = "",
        device_ids: list[str] | None = None,
    ) -> tuple[dict[str, Any], str]:
        username = _normalize_username(username)
        if self._find(username) is not None:
            raise RelayUserError(f"user already exists: {username}")
        requested_devices = sorted({str(v).strip() for v in (device_ids or []) if str(v).strip()})
        token = _new_token()
        now = _now()
        user = {
            "userId": str(uuid.uuid4()),
            "username": username,
            "displayName": _normalize_display_name(display_name, username),
            "avatarData": "",
            "avatarColor": "#64748b",
            "tokenHash": _token_hash(token),
            "disabled": False,
            "deviceIds": requested_devices,
            "createdAt": now,
            "updatedAt": now,
        }
        self._data["users"].append(user)
        # 管理员第一次把设备交给某个用户时，该用户自然成为设备主用户；后续
        # 再授权其他人不会覆盖。共享设备也可用 set-default 显式改选。
        defaults = self._device_defaults()
        for device_id in requested_devices:
            defaults.setdefault(device_id, user["userId"])
        self._save()
        return self.admin_profile(user), token

    def authenticate(self, token: object) -> dict[str, Any] | None:
        presented = str(token or "")
        if not presented:
            return None
        digest = _token_hash(presented)
        for user in self._users():
            if bool(user.get("disabled", False)):
                continue
            if hmac.compare_digest(str(user.get("tokenHash") or ""), digest):
                return user
        return None

    def users_for_device(self, device_id: str) -> list[dict[str, Any]]:
        """Return every user granted access to one shared executor.

        Executor processes are deliberately not user-owned.  A home desktop
        commonly hosts one Backend process for several people; Session.owner_id
        is the isolation boundary after Relay injects the authenticated userId.
        """
        wanted = str(device_id or "").strip()
        if not wanted:
            return []
        return [
            user for user in self._users()
            if wanted in {str(v) for v in user.get("deviceIds", [])}
        ]

    def user_can_access(self, user: dict[str, Any], device_id: str) -> bool:
        return str(device_id or "") in {str(v) for v in user.get("deviceIds", [])}

    def default_user_for_device(self, device_id: str) -> dict[str, Any] | None:
        """Return the explicitly selected primary user for one executor."""
        wanted = str(device_id or "").strip()
        user_id = self._device_defaults().get(wanted, "")
        user = self._find(user_id) if user_id else None
        if user is None or not self.user_can_access(user, wanted):
            return None
        return user

    def user_is_default_for_device(self, user: dict[str, Any], device_id: str) -> bool:
        current = self.default_user_for_device(device_id)
        return bool(
            current is not None
            and str(current.get("userId") or "") == str(user.get("userId") or "")
        )

    def set_default_user(self, identifier: str, device_id: str) -> dict[str, Any]:
        user = self._find(identifier)
        if user is None:
            raise RelayUserError("user not found")
        device_id = str(device_id or "").strip()
        if not device_id:
            raise RelayUserError("deviceId is required")
        if not self.user_can_access(user, device_id):
            raise RelayUserError("default user must already be granted this device")
        self._device_defaults()[device_id] = str(user.get("userId") or "")
        user["updatedAt"] = _now()
        self._save()
        return self.admin_profile(user)

    def clear_default_user(self, device_id: str) -> str:
        device_id = str(device_id or "").strip()
        if not device_id:
            raise RelayUserError("deviceId is required")
        self._device_defaults().pop(device_id, None)
        self._save()
        return device_id

    def update_profile(self, user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        user = self._find(user_id)
        if user is None:
            raise RelayUserError("user not found")
        username = _normalize_username(patch.get("username", user.get("username")))
        for other in self._users():
            if other is not user and str(other.get("username") or "").casefold() == username.casefold():
                raise RelayUserError(f"username already exists: {username}")
        user["username"] = username
        user["displayName"] = _normalize_display_name(
            patch.get("displayName", user.get("displayName")), username
        )
        user["avatarData"] = _normalize_avatar(patch.get("avatarData", user.get("avatarData")))
        user["avatarColor"] = _normalize_color(patch.get("avatarColor", user.get("avatarColor")))
        user["updatedAt"] = _now()
        self._save()
        return self.public_profile(user)

    def reset_token(self, identifier: str) -> tuple[dict[str, Any], str]:
        user = self._find(identifier)
        if user is None:
            raise RelayUserError("user not found")
        token = _new_token()
        user["tokenHash"] = _token_hash(token)
        user["updatedAt"] = _now()
        self._save()
        return self.admin_profile(user), token

    def set_device(self, identifier: str, device_id: str, *, granted: bool) -> dict[str, Any]:
        user = self._find(identifier)
        if user is None:
            raise RelayUserError("user not found")
        device_id = str(device_id or "").strip()
        if not device_id:
            raise RelayUserError("deviceId is required")
        devices = {str(v) for v in user.get("deviceIds", []) if str(v)}
        if granted:
            devices.add(device_id)
            self._device_defaults().setdefault(
                device_id, str(user.get("userId") or ""),
            )
        else:
            devices.discard(device_id)
            if self._device_defaults().get(device_id) == str(user.get("userId") or ""):
                self._device_defaults().pop(device_id, None)
        user["deviceIds"] = sorted(devices)
        user["updatedAt"] = _now()
        self._save()
        return self.admin_profile(user)

    def set_disabled(self, identifier: str, disabled: bool) -> dict[str, Any]:
        user = self._find(identifier)
        if user is None:
            raise RelayUserError("user not found")
        user["disabled"] = bool(disabled)
        user["updatedAt"] = _now()
        self._save()
        return self.admin_profile(user)

    def delete_user(self, identifier: str) -> dict[str, Any]:
        user = self._find(identifier)
        if user is None:
            raise RelayUserError("user not found")
        profile = self.admin_profile(user)
        user_id = str(user.get("userId") or "")
        self._data["users"] = [item for item in self._data["users"] if item is not user]
        self._data["deviceDefaults"] = {
            device_id: default_user_id
            for device_id, default_user_id in self._device_defaults().items()
            if default_user_id != user_id
        }
        self._save()
        return profile

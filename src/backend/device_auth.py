"""Portable web deployment authentication and audit persistence."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import string
import threading
import time
from pathlib import Path
from typing import Callable, Optional


SESSION_COOKIE = "awu_device_session"


def generate_device_code() -> str:
    """Generate a readable code that is refreshed for every process start."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def _normalise_code(value: str) -> str:
    return "".join(ch for ch in (value or "").upper() if ch in string.ascii_uppercase + string.digits)


class DeviceAuthStore:
    """12-hour browser sessions plus per-IP failed-login blocking.

    Only hashes of browser session tokens are persisted. The current process's
    device code remains in memory and therefore changes after every restart.
    """

    def __init__(
        self,
        state_path: Path,
        *,
        session_seconds: int = 12 * 60 * 60,
        max_failures: int = 3,
        block_seconds: int = 12 * 60 * 60,
        device_code: Optional[str] = None,
        trust_loopback_proxy: bool = False,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self.state_path = Path(state_path)
        self.session_seconds = max(60, int(session_seconds))
        self.max_failures = max(1, int(max_failures))
        self.block_seconds = max(60, int(block_seconds))
        self.device_code = device_code or generate_device_code()
        self.trust_loopback_proxy = bool(trust_loopback_proxy)
        self._now = now_fn
        self._lock = threading.RLock()
        self._state = self._load()
        self._prune_and_save()

    def client_ip(self, peer_ip: str, x_real_ip: str = "", x_forwarded_for: str = "") -> str:
        """Resolve the client IP, trusting forwarding headers only from loopback."""
        peer_ip = peer_ip or "unknown"
        if not self.trust_loopback_proxy:
            return peer_ip
        try:
            if not ipaddress.ip_address(peer_ip).is_loopback:
                return peer_ip
        except ValueError:
            return peer_ip
        candidate = (x_real_ip or "").strip()
        if not candidate and x_forwarded_for:
            candidate = x_forwarded_for.split(",", 1)[0].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            return peer_ip

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256((token or "").encode("utf-8")).hexdigest()

    def _load(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw.setdefault("version", 1)
                raw.setdefault("sessions", {})
                raw.setdefault("ips", {})
                raw.setdefault("events", [])
                return raw
        except (OSError, ValueError, TypeError):
            pass
        return {"version": 1, "sessions": {}, "ips": {}, "events": []}

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state["updatedAt"] = self._now()
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def _audit(self, ip: str, event: str, **extra) -> None:
        events = self._state.setdefault("events", [])
        events.append({"time": self._now(), "ip": ip, "event": event, **extra})
        # Keep enough history for incident review without unbounded disk growth.
        if len(events) > 5000:
            del events[:-5000]

    def _prune(self) -> None:
        now = self._now()
        sessions = self._state.setdefault("sessions", {})
        for key in list(sessions):
            if float(sessions[key].get("expiresAt", 0)) <= now:
                sessions.pop(key, None)
        ips = self._state.setdefault("ips", {})
        for record in ips.values():
            failures = record.get("failureTimes", [])
            record["failureTimes"] = [float(ts) for ts in failures if float(ts) > now - self.block_seconds]
            if float(record.get("blockedUntil", 0)) <= now:
                record["blockedUntil"] = 0

    def _prune_and_save(self) -> None:
        with self._lock:
            self._prune()
            self._save()

    def blocked_until(self, ip: str) -> float:
        with self._lock:
            self._prune()
            return float(self._state.setdefault("ips", {}).get(ip, {}).get("blockedUntil", 0))

    def is_blocked(self, ip: str) -> bool:
        return self.blocked_until(ip) > self._now()

    def login(self, ip: str, supplied_code: str) -> tuple[bool, Optional[str], dict]:
        """Validate a code and return ``(ok, raw_token, public_status)``."""
        ip = ip or "unknown"
        with self._lock:
            self._prune()
            now = self._now()
            ips = self._state.setdefault("ips", {})
            record = ips.setdefault(ip, {"failureTimes": [], "blockedUntil": 0})
            if float(record.get("blockedUntil", 0)) > now:
                self._audit(ip, "blocked_login_attempt", blockedUntil=record["blockedUntil"])
                self._save()
                return False, None, self.public_status(ip)

            if not secrets.compare_digest(_normalise_code(supplied_code), _normalise_code(self.device_code)):
                failures = record.setdefault("failureTimes", [])
                failures.append(now)
                record["lastFailureAt"] = now
                self._audit(ip, "login_failed", failureCount=len(failures))
                if len(failures) >= self.max_failures:
                    record["blockedUntil"] = now + self.block_seconds
                    self._audit(ip, "ip_blocked", blockedUntil=record["blockedUntil"])
                self._save()
                return False, None, self.public_status(ip)

            token = secrets.token_urlsafe(32)
            expires_at = now + self.session_seconds
            self._state.setdefault("sessions", {})[self._token_hash(token)] = {
                "ip": ip,
                "createdAt": now,
                "lastSeenAt": now,
                "expiresAt": expires_at,
            }
            record["failureTimes"] = []
            record["blockedUntil"] = 0
            record["lastSuccessAt"] = now
            self._audit(ip, "login_success", expiresAt=expires_at)
            self._save()
            return True, token, self.public_status(ip, authenticated=True, expires_at=expires_at)

    def validate(self, ip: str, token: Optional[str], *, touch: bool = False) -> bool:
        if not token:
            return False
        ip = ip or "unknown"
        with self._lock:
            self._prune()
            if self.is_blocked(ip):
                return False
            record = self._state.setdefault("sessions", {}).get(self._token_hash(token))
            if not record or record.get("ip") != ip or float(record.get("expiresAt", 0)) <= self._now():
                return False
            if touch:
                record["lastSeenAt"] = self._now()
                self._save()
            return True

    def logout(self, token: Optional[str]) -> None:
        if not token:
            return
        with self._lock:
            self._state.setdefault("sessions", {}).pop(self._token_hash(token), None)
            self._save()

    def public_status(
        self,
        ip: str,
        *,
        authenticated: bool = False,
        expires_at: float = 0,
    ) -> dict:
        now = self._now()
        record = self._state.setdefault("ips", {}).get(ip or "unknown", {})
        failures = [float(ts) for ts in record.get("failureTimes", []) if float(ts) > now - self.block_seconds]
        blocked_until = float(record.get("blockedUntil", 0))
        return {
            "authenticated": authenticated,
            "expiresAt": expires_at,
            "blocked": blocked_until > now,
            "blockedUntil": blocked_until,
            "remainingAttempts": max(0, self.max_failures - len(failures)),
            "sessionHours": self.session_seconds / 3600,
        }


def cookie_value(cookie_header: Optional[str], name: str = SESSION_COOKIE) -> Optional[str]:
    for part in (cookie_header or "").split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value
    return None

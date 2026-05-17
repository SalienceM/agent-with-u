"""
AuthGuard: WebSocket 握手阶段的认证 / 鉴权层。

支持三种模式（按优先级）：

  1. trust-forward-auth
       后端只接受来自 trusted_proxies 列表的 IP 的连接，
       并从请求头 Remote-User / Remote-Email / Remote-Name / Remote-Groups
       读取上游反向代理（Authelia / authentik / oauth2-proxy 等）盖好的身份。
       适用：生产部署 = nginx/Traefik/Caddy + Authelia + AgentWithU。

  2. token
       连接时携带 Authorization: Bearer <token> 或 ?token=<token> query。
       适用：开发调试 / 临时局域网裸跑。

  3. loopback （默认）
       只接受 trusted_proxies 列表内 IP 的连接（默认仅 127.0.0.1 / ::1），
       无需 token，身份统一记为 "local"。
       适用：Tauri sidecar 本地直连；或单用户部署中由 docker 内网/反代
       做边界——把内网 IP 段加入 trusted_proxies 即整段免鉴权。

每个连接在通过认证后，会在 websocket 对象上挂三个属性：
  websocket.identity     —— 用户标识（Remote-User、token 标识或 "local"）
  websocket.identity_src —— 标识来源："forward-auth" / "token" / "loopback"
  websocket.identity_email —— Authelia 模式下的邮箱（其他模式为 None）

握手失败时返回 HTTP 401 / 403（而不是 WS close），方便反代和客户端区分。
"""

from __future__ import annotations

import http
import ipaddress
import logging
import secrets
from dataclasses import dataclass, field
from typing import Optional


log = logging.getLogger(__name__)


def _split_csv(s: Optional[str]) -> list[str]:
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


@dataclass
class AuthConfig:
    """从 CLI / env 收集的认证配置，由 ws_main 构造，AuthGuard 消费。"""
    bind_host: str = "127.0.0.1"
    auth_token: Optional[str] = None
    trust_forward_auth: bool = False
    trusted_proxies: list[str] = field(default_factory=list)

    def mode(self) -> str:
        if self.trust_forward_auth:
            return "forward-auth"
        if self.auth_token:
            return "token"
        return "loopback"

    def describe(self) -> str:
        m = self.mode()
        if m == "forward-auth":
            return f"forward-auth (trusted_proxies={self.trusted_proxies or ['127.0.0.1', '::1']})"
        if m == "token":
            return "token (Bearer header or ?token=… query)"
        nets = self.trusted_proxies or ["127.0.0.1", "::1"]
        return f"loopback (trusted peers={nets}, identity=local)"


class AuthGuard:
    """传给 websockets.serve(process_request=...) 的认证回调宿主。"""

    # Authelia / oauth2-proxy / authentik 都遵循这套 Remote-* 头约定
    HDR_USER   = "remote-user"
    HDR_EMAIL  = "remote-email"
    HDR_NAME   = "remote-name"
    HDR_GROUPS = "remote-groups"

    def __init__(self, config: AuthConfig):
        self.config = config
        self._trusted_nets = self._parse_trusted(config.trusted_proxies)

    @staticmethod
    def _parse_trusted(items: list[str]) -> list[ipaddress._BaseNetwork]:
        nets: list[ipaddress._BaseNetwork] = []
        # 默认信任本机 loopback —— 反代通常和后端同机
        defaults = ["127.0.0.0/8", "::1/128"]
        for raw in (items or defaults):
            try:
                nets.append(ipaddress.ip_network(raw, strict=False))
            except ValueError:
                log.warning("[auth] ignoring invalid trusted-proxy entry: %s", raw)
        return nets

    def _peer_ip(self, connection) -> Optional[ipaddress._BaseAddress]:
        addr = getattr(connection, "remote_address", None)
        if not addr:
            return None
        try:
            return ipaddress.ip_address(addr[0])
        except (ValueError, IndexError):
            return None

    def _peer_in_trusted(self, ip: Optional[ipaddress._BaseAddress]) -> bool:
        if ip is None:
            return False
        return any(ip in net for net in self._trusted_nets)

    @staticmethod
    def _get_header(request, name: str) -> Optional[str]:
        # websockets ≥ 13 的 Headers 是大小写不敏感的 multi-dict
        try:
            return request.headers.get(name)
        except Exception:
            return None

    @staticmethod
    def _get_query_param(request, name: str) -> Optional[str]:
        from urllib.parse import urlparse, parse_qs
        path = getattr(request, "path", "") or ""
        try:
            q = parse_qs(urlparse(path).query)
            v = q.get(name)
            return v[0] if v else None
        except Exception:
            return None

    @staticmethod
    def _extract_bearer(request) -> Optional[str]:
        auth = AuthGuard._get_header(request, "authorization")
        if not auth:
            return None
        parts = auth.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1].strip()
        return None

    # ── websockets process_request 回调 ───────────────────────────────────

    def process_request(self, connection, request):
        """
        返回 None 通过，返回 Response 拒绝。
        通过时把身份信息挂到 connection 上（后续 handle_client 读取）。
        """
        mode = self.config.mode()
        peer = self._peer_ip(connection)

        # 任何模式都先做一道 peer-IP 白名单（trust-forward-auth 强制；
        # loopback 模式本就只允许本机；token 模式不限制 peer，由 token 校验）。
        if mode == "forward-auth":
            if not self._peer_in_trusted(peer):
                log.warning("[auth] reject %s: not in trusted_proxies", peer)
                return connection.respond(
                    http.HTTPStatus.FORBIDDEN,
                    "forbidden: peer is not a trusted proxy\n",
                )
            user = self._get_header(request, self.HDR_USER)
            if not user:
                log.warning("[auth] reject %s: missing Remote-User header (forward-auth required)", peer)
                return connection.respond(
                    http.HTTPStatus.UNAUTHORIZED,
                    "unauthorized: missing Remote-User\n",
                )
            connection.identity = user
            connection.identity_email = self._get_header(request, self.HDR_EMAIL)
            connection.identity_groups = _split_csv(self._get_header(request, self.HDR_GROUPS))
            connection.identity_src = "forward-auth"
            log.info("[auth] accept %s as user=%s via forward-auth", peer, user)
            return None

        if mode == "token":
            supplied = self._extract_bearer(request) or self._get_query_param(request, "token")
            if not supplied or not secrets.compare_digest(supplied, self.config.auth_token or ""):
                log.warning("[auth] reject %s: bad/missing bearer token", peer)
                return connection.respond(
                    http.HTTPStatus.UNAUTHORIZED,
                    "unauthorized: bad token\n",
                )
            connection.identity = f"token:{(self.config.auth_token or '')[:8]}"
            connection.identity_email = None
            connection.identity_groups = []
            connection.identity_src = "token"
            log.info("[auth] accept %s via token", peer)
            return None

        # loopback 模式：peer 必须落在 trusted_proxies（默认仅 127.0.0.1 / ::1）
        if not self._peer_in_trusted(peer):
            log.warning("[auth] reject %s: peer not in trusted_proxies (loopback mode)", peer)
            return connection.respond(
                http.HTTPStatus.FORBIDDEN,
                "forbidden: peer is not a trusted address\n",
            )
        connection.identity = "local"
        connection.identity_email = None
        connection.identity_groups = []
        connection.identity_src = "loopback"
        log.info("[auth] accept %s as user=local via loopback", peer)
        return None

"""
AgentWithU — WebSocket server 入口。

两种部署形态：
  1. Tauri sidecar（桌面）—— 默认 loopback 模式，与本机 Tauri 客户端互连。
  2. 自托管远端服务（v2.1+）—— 配合 nginx/Traefik/Caddy + Authelia 反代，
     启用 --trust-forward-auth，后端只信反代盖章过的 Remote-User 头。

CLI / 环境变量同义：
  --bind / AGENT_WITH_U_BIND                 默认 127.0.0.1
  --port / AGENT_WITH_U_PORT                 默认 44321
  --auth-token / AGENT_WITH_U_AUTH_TOKEN     启用 token 模式
  --trust-forward-auth / AGENT_WITH_U_TRUST_FORWARD_AUTH=1
                                             启用 Authelia 反代信任模式
  --trusted-proxies / AGENT_WITH_U_TRUSTED_PROXIES
                                             逗号分隔 CIDR 列表，默认 127.0.0.0/8,::1/128

独立运行（开发调试）：
    python -m src.ws_main
反代模式（生产）：
    python -m src.ws_main --bind 127.0.0.1 --trust-forward-auth
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import websockets

from .backend.auth import AuthConfig, AuthGuard
from .backend.bridge_ws import BridgeWS
from .backend.clipboard import ClipboardHandler

try:
    from ._version import __version__ as APP_VERSION
except Exception:
    APP_VERSION = "0.0.0-dev"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 44321


def setup_logging() -> Path:
    """
    把日志同时输出到文件和 stderr。
    日志文件：%APPDATA%/AgentWithU/logs/backend.log（Windows）
              ~/.agent-with-u/logs/backend.log（其他平台）
    只保留最近 1 MB，超出后轮转 3 份。
    """
    from .backend import paths as _paths

    log_file = _paths.log_file()
    log_file.parent.mkdir(parents=True, exist_ok=True)

    from logging.handlers import RotatingFileHandler

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    # 第三方库日志降噪
    for noisy in ("websockets", "httpx", "httpcore", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    fh = RotatingFileHandler(log_file, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)

    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    root.addHandler(sh)

    # 把裸 print(..., file=sys.stderr) 也重定向到 logging
    class _StderrToLog:
        def write(self, msg: str):
            msg = msg.rstrip()
            if msg:
                logging.info(msg)
        def flush(self): pass

    sys.stderr = _StderrToLog()  # type: ignore[assignment]

    return log_file


def find_bundled_claude() -> Optional[str]:
    """
    自动寻找可用的 claude CLI 路径，优先级：
    1. PyInstaller 打包环境：sys._MEIPASS 下的 claude/claude.exe
    2. claude_agent_sdk 内置路径（SDK 自带 CLI）
    3. None（交给 SDK 自己去 PATH 里找）
    """
    exe = "claude.exe" if sys.platform == "win32" else "claude"

    # ── 1. PyInstaller frozen 环境 ──
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidate = Path(meipass) / exe
        if candidate.exists():
            print(f"[ws_main] Using bundled claude: {candidate}", file=sys.stderr)
            return str(candidate)

    # ── 2. claude_agent_sdk 包内置路径 ──
    try:
        import claude_agent_sdk
        sdk_dir = Path(claude_agent_sdk.__file__).parent
        # 常见子目录：bin/, cli/, _bin/
        for sub in ("bin", "cli", "_bin", "."):
            candidate = sdk_dir / sub / exe
            if candidate.exists():
                print(f"[ws_main] Using SDK-bundled claude: {candidate}", file=sys.stderr)
                return str(candidate)
        # SDK 可能通过 __path__ 暴露多个目录
        for sdk_path in getattr(claude_agent_sdk, "__path__", []):
            for sub in ("bin", "cli", "_bin", "."):
                candidate = Path(sdk_path) / sub / exe
                if candidate.exists():
                    print(f"[ws_main] Using SDK-bundled claude: {candidate}", file=sys.stderr)
                    return str(candidate)
    except Exception:
        pass

    # ── 3. 让 SDK 自己从 PATH 找 ──
    return None


def load_claude_settings():
    """从 ~/.claude/settings.json 自动加载环境变量（与 main.py 相同逻辑）。"""
    settings_path = Path.home() / ".claude" / "settings.json"
    if not settings_path.exists():
        return
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        for key, value in data.get("env", {}).items():
            if key not in os.environ:
                os.environ[key] = str(value)
        if "ANTHROPIC_API_KEY" not in os.environ and "ANTHROPIC_AUTH_TOKEN" in os.environ:
            os.environ["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_AUTH_TOKEN"]
    except Exception as e:
        print(f"[ws_main] Failed to load settings.json: {e}", file=sys.stderr)


def patch_npm_path():
    """Windows 下补全 npm 全局路径（与 main.py 相同逻辑）。"""
    if sys.platform == "win32":
        npm_bin = os.path.join(os.environ.get("APPDATA", ""), "npm")
        if npm_bin and npm_bin not in os.environ.get("PATH", ""):
            os.environ["PATH"] = npm_bin + os.pathsep + os.environ.get("PATH", "")


def _get_pid_file(port: int) -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home())) / "AgentWithU"
    else:
        base = Path.home() / ".agent-with-u"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"backend_{port}.pid"


def _kill_pid(pid: int, reason: str) -> bool:
    """发送强制终止信号，返回是否成功。"""
    try:
        if sys.platform == "win32":
            import subprocess
            ret = subprocess.call(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if ret == 0:
                logging.warning(f"[ws_main] Killed PID {pid} ({reason})")
                return True
        else:
            import signal as _signal
            os.kill(pid, _signal.SIGTERM)
            logging.warning(f"[ws_main] Sent SIGTERM to PID {pid} ({reason})")
            return True
    except (ProcessLookupError, PermissionError):
        pass  # 进程已经不存在
    except Exception as e:
        logging.warning(f"[ws_main] Failed to kill PID {pid}: {e}")
    return False


def _is_pid_alive(pid: int) -> bool:
    """检查进程是否还活着。"""
    try:
        if sys.platform == "win32":
            import subprocess
            ret = subprocess.call(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return ret == 0
        else:
            os.kill(pid, 0)  # 发送 signal 0 仅检查存在性
            return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return True  # 不确定时保守处理


def _ensure_single_instance(port: int) -> None:
    """
    单实例锁（PID 文件）：
    1. 读旧 PID 文件 → 如果旧进程仍在运行则杀掉，等待端口释放
    2. 写入当前 PID
    3. 注册 atexit 自动清理
    """
    import atexit
    import time

    pid_file = _get_pid_file(port)

    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text(encoding="utf-8").strip())
            if old_pid != os.getpid() and _is_pid_alive(old_pid):
                logging.info(f"[ws_main] Found running instance PID={old_pid}, terminating it…")
                _kill_pid(old_pid, f"old instance on port {port}")
                # 等待端口真正释放（最多 3s）
                for _ in range(6):
                    time.sleep(0.5)
                    if not _is_pid_alive(old_pid):
                        break
                logging.info(f"[ws_main] Old instance gone, proceeding.")
        except ValueError:
            pass  # PID 文件损坏，直接覆盖
        except Exception as e:
            logging.warning(f"[ws_main] Could not process stale PID file: {e}")

    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    atexit.register(lambda: pid_file.unlink(missing_ok=True))
    logging.info(f"[ws_main] Single-instance lock acquired (PID={os.getpid()}, port={port})")


def _envbool(name: str) -> bool:
    return (os.environ.get(name, "") or "").strip().lower() in ("1", "true", "yes", "on")


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """CLI 参数；任何参数缺省时回落到 AGENT_WITH_U_* 环境变量，再回落到内置默认。"""
    p = argparse.ArgumentParser(prog="agent-with-u-backend", add_help=True)
    p.add_argument("--bind", default=os.environ.get("AGENT_WITH_U_BIND", DEFAULT_HOST),
                   help=f"bind address (default {DEFAULT_HOST}; use 0.0.0.0 for remote, only with --auth-token or --trust-forward-auth)")
    p.add_argument("--port", type=int,
                   default=int(os.environ.get("AGENT_WITH_U_PORT", str(DEFAULT_PORT))),
                   help=f"WebSocket port (default {DEFAULT_PORT})")
    p.add_argument("--auth-token", default=os.environ.get("AGENT_WITH_U_AUTH_TOKEN") or None,
                   help="enable token mode; clients must send Authorization: Bearer <token> or ?token=…")
    p.add_argument("--trust-forward-auth", action="store_true",
                   default=_envbool("AGENT_WITH_U_TRUST_FORWARD_AUTH"),
                   help="trust upstream reverse proxy headers (Remote-User/-Email/-Groups)")
    p.add_argument("--trusted-proxies",
                   default=os.environ.get("AGENT_WITH_U_TRUSTED_PROXIES", ""),
                   help="comma-separated CIDRs allowed to set Remote-* headers (default: 127.0.0.0/8,::1/128)")
    # ── 中继（C–C/S）：本执行节点主动拨出到公网中继 S，供远程 UI 经 S 访问 ──
    p.add_argument("--relay-url", default=os.environ.get("AGENT_WITH_U_RELAY_URL") or None,
                   help="connect out to a relay server (e.g. wss://relay.example.com) "
                        "so remote UI clients can reach this executor node")
    p.add_argument("--relay-token", default=os.environ.get("AGENT_WITH_U_RELAY_TOKEN") or None,
                   help="shared token for the relay server")
    p.add_argument("--device-id", default=os.environ.get("AGENT_WITH_U_DEVICE_ID") or None,
                   help="stable id for this executor node (default: auto-generated & persisted)")
    p.add_argument("--device-name", default=os.environ.get("AGENT_WITH_U_DEVICE_NAME") or None,
                   help="human-readable name for this executor node shown in the UI device list")
    return p.parse_args(argv)


def resolve_device_identity(args: argparse.Namespace) -> tuple[str, str]:
    """确定本执行节点的设备 ID 与名称。

    device-id 缺省时自动生成并持久化到数据目录，保证重启后 ID 稳定——
    远程 UI 才能始终认得同一个节点。
    """
    import socket
    from .backend import paths

    device_id = (args.device_id or "").strip()
    if not device_id:
        id_file = paths.data_root() / "device-id"
        try:
            if id_file.exists():
                device_id = id_file.read_text(encoding="utf-8").strip()
            if not device_id:
                import uuid
                device_id = uuid.uuid4().hex[:16]
                id_file.parent.mkdir(parents=True, exist_ok=True)
                id_file.write_text(device_id, encoding="utf-8")
        except Exception:
            import uuid
            device_id = device_id or uuid.uuid4().hex[:16]

    device_name = (args.device_name or "").strip()
    if not device_name:
        try:
            device_name = socket.gethostname() or device_id
        except Exception:
            device_name = device_id
    return device_id, device_name


def build_auth_config(args: argparse.Namespace) -> AuthConfig:
    proxies: list[str] = []
    if args.trusted_proxies:
        proxies = [s.strip() for s in args.trusted_proxies.split(",") if s.strip()]
    return AuthConfig(
        bind_host=args.bind,
        auth_token=args.auth_token,
        trust_forward_auth=bool(args.trust_forward_auth),
        trusted_proxies=proxies,
    )


def _validate_auth_for_bind(cfg: AuthConfig) -> None:
    """非 loopback 绑定 + 无任何访问控制 = 拒绝启动，避免裸跑暴露到局域网。

    loopback 模式下若显式设置了 trusted_proxies，则 peer-IP 白名单本身就是
    访问控制（典型：docker 内网部署，只允许 awu-web 容器连入），允许绑定。
    """
    is_loopback_bind = cfg.bind_host in ("127.0.0.1", "::1", "localhost")
    if is_loopback_bind:
        return
    if cfg.mode() == "loopback" and not cfg.trusted_proxies:
        logging.error(
            "[ws_main] refusing to bind on %s without access control. "
            "Pass --auth-token / --trust-forward-auth, set --trusted-proxies "
            "to an explicit CIDR list, or bind on 127.0.0.1.",
            cfg.bind_host,
        )
        sys.exit(2)


async def main():
    args = parse_args()
    auth_cfg = build_auth_config(args)

    # 初始化日志系统
    log_file = setup_logging()
    logging.info(f"[ws_main] AgentWithU backend v{APP_VERSION} starting")
    logging.info(f"[ws_main] Log file: {log_file}")
    logging.info(f"[ws_main] Auth mode: {auth_cfg.describe()}")

    _validate_auth_for_bind(auth_cfg)

    patch_npm_path()
    load_claude_settings()

    # 单实例保证：杀旧实例 → 写 PID → 绑定端口
    _ensure_single_instance(args.port)

    ClipboardHandler.cleanup_old_temp_files()

    cli_path = find_bundled_claude()
    auth_guard = AuthGuard(auth_cfg)
    bridge = BridgeWS(cli_path=cli_path, auth_guard=auth_guard)

    logging.info(f"[ws_main] Starting WebSocket server on ws://{args.bind}:{args.port}")
    try:
        server = await websockets.serve(
            bridge.handle_client, args.bind, args.port,
            process_request=bridge.process_request,
            max_size=50 * 1024 * 1024,   # 50MB，支持大图片 base64
            ping_interval=30,             # 每 30 秒发送 ping
            ping_timeout=300,             # 允许 5 分钟无 pong（系统休眠/后台标签页节流）
        )
        # ★ Backend Skill HTTP API（供 SKILL.md 通过 curl 回调、图片/素材服务）
        # 绑定地址与 WS 一致：反代与后端不同容器/主机时也能连到。
        http_server = await bridge.start_http_api(args.bind)
    except OSError as e:
        logging.error(f"[ws_main] Cannot bind {args.bind}:{args.port} even after clearing old instance: {e}")
        sys.exit(1)

    # ★ 中继链路（C–C/S）：若配置了 --relay-url，本执行节点额外拨出一条
    #   长连接到公网中继 S，让远程 UI 经 S 访问。本地直连不受影响、照常可用。
    if args.relay_url:
        if not args.relay_token:
            logging.error("[ws_main] --relay-url given but no --relay-token; relay disabled")
        else:
            from .backend.relay import RelayLink
            device_id, device_name = resolve_device_identity(args)
            relay = RelayLink(
                bridge, args.relay_url, device_id, device_name, args.relay_token,
            )
            logging.info(
                f"[ws_main] Relay enabled: device={device_id} ({device_name}) "
                f"-> {args.relay_url}"
            )
            asyncio.ensure_future(relay.run())

    logging.info("[ws_main] Ready.")
    async with server:
        await asyncio.Future()  # 永久运行直到进程被终止


if __name__ == "__main__":
    asyncio.run(main())

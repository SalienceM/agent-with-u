"""执行节点上的 SSH 连接引用。只存公钥/路径，不存密码或私钥内容。"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from . import paths


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def endpoint(data: dict) -> dict:
    host = str(data.get("host", "")).strip()
    user = str(data.get("user", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", host):
        raise ValueError("请填写有效的主机名或 IPv4 地址，不带命令参数")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,63}", user):
        raise ValueError("SSH 账户格式无效")
    port = int(data.get("port", 22))
    if not 1 <= port <= 65535:
        raise ValueError("SSH 端口必须是 1–65535")
    return {"host": host, "port": port, "user": user}


def authentication(data: dict) -> dict:
    mode = data.get("authMode", "agent")
    if mode not in {"agent", "key"}:
        raise ValueError("请选择 SSH Agent 或已有私钥")
    key = str(data.get("keyPath", "")).strip() if mode == "key" else ""
    if mode == "key":
        # OpenSSH 对路径中的 % 作 token 展开；不接受配置表达式或多行内容。
        if any(c in key for c in '\r\n\x00%"') or not Path(key).is_absolute():
            raise ValueError("私钥路径必须是执行节点上的绝对路径，不能包含换行、双引号或 %")
        if not Path(key).is_file():
            raise ValueError("执行节点上找不到该私钥文件；请填写路径，不要粘贴私钥内容")
    return {"authMode": mode, "keyPath": key}


def public_key(line: str) -> dict:
    parts = line.split()
    if len(parts) != 3 or parts[1] not in {"ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"}:
        raise ValueError("不支持的 SSH 主机公钥")
    raw = base64.b64decode(parts[2], validate=True)
    size = int.from_bytes(raw[:4], "big")
    if len(raw) > 8192 or size > 64 or raw[4:4 + size].decode("ascii") != parts[1] or len(raw) < size + 12:
        raise ValueError("SSH 主机公钥格式无效")
    return {"algorithm": parts[1], "publicKey": parts[2],
            "fingerprint": "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")}


async def run_bounded(argv: list[str], timeout: float = 9) -> tuple[int, str, str]:
    options = {"creationflags": 0x08000000} if os.name == "nt" else {}
    proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.DEVNULL,
                                               stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                               **options)

    async def read(stream: asyncio.StreamReader) -> str:
        chunks = bytearray()
        while chunk := await stream.read(4096):
            chunks.extend(chunk)
            if len(chunks) > 32768:
                raise ValueError("SSH 探测输出超出限制")
        return chunks.decode("utf-8", errors="replace")

    tasks = [asyncio.create_task(read(proc.stdout)), asyncio.create_task(read(proc.stderr))]
    try:
        out, err = await asyncio.wait_for(asyncio.gather(*tasks), timeout)
        await asyncio.wait_for(proc.wait(), 1)
        return proc.returncode, out, err
    except asyncio.TimeoutError as error:
        raise ValueError("SSH 连接超时，请检查地址、端口和网络；本次未确认连接成功") from error
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def executable(name: str) -> str:
    result = shutil.which(name)
    if not result:
        raise ValueError(f"执行节点缺少 OpenSSH {name}，请先在该节点安装或启用 OpenSSH 客户端")
    return result


async def probe(data: dict) -> dict:
    address = endpoint(data)
    _, stdout, _ = await run_bounded([executable("ssh-keyscan"), "-T", "5", "-p", str(address["port"]),
                                     "-t", "ed25519,ecdsa,rsa", address["host"]])
    found = []
    for line in stdout.splitlines():
        try:
            found.append(public_key(line))
        except (ValueError, UnicodeError):
            continue
    for algorithm in ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"):
        match = next((item for item in found if item["algorithm"] == algorithm), None)
        if match:
            return {**address, **match}
    raise ValueError("未取得服务器公钥，请检查地址、端口及网络；没有保存或信任任何指纹")


def known_hosts(profile: dict) -> str:
    key = public_key(f"awu-pinned {profile['algorithm']} {profile['publicKey']}")
    if key["fingerprint"] != profile["fingerprint"]:
        raise ValueError("已保存的服务器指纹校验失败")
    return f"awu-pinned {key['algorithm']} {key['publicKey']}\n"


def ssh_options(profile: dict, known_path: str) -> list[str]:
    # 独立 known_hosts + 禁用用户配置，杜绝静默信任/密码回退/配置重定向。
    null = "NUL" if os.name == "nt" else "/dev/null"
    args = ["-F", null, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "HostKeyAlias=awu-pinned", "-o", f'UserKnownHostsFile="{known_path}"',
            "-o", f"GlobalKnownHostsFile={null}", "-o", "UpdateHostKeys=no",
            "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
            "-o", "PreferredAuthentications=publickey", "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
            "-p", str(profile["port"])]
    if profile["authMode"] == "key":
        args += ["-o", "IdentitiesOnly=yes", "-i", profile["keyPath"]]
    else:
        args += ["-o", "IdentityFile=none"]
    return args


async def test_connection(profile: dict) -> dict:
    authentication(profile)
    with tempfile.TemporaryDirectory(prefix="awu-ssh-check-") as temp:
        path = Path(temp) / "known_hosts"
        path.write_text(known_hosts(profile), encoding="utf-8")
        code, out, err = await run_bounded([executable("ssh"), *ssh_options(profile, str(path)),
                                           f"{profile['user']}@{profile['host']}", "printf AWU_SSH_OK"], 10)
    if code == 0 and out == "AWU_SSH_OK":
        return {"status": "ok", "message": "服务器指纹匹配，密钥登录成功。Docker / sudo 权限在部署时另行检查。"}
    if "HOST IDENTIFICATION HAS CHANGED" in err or "Host key verification failed" in err:
        message = "服务器指纹不匹配，已停止连接。请先通过服务器管理员核对，不能自动接受新指纹。"
    else:
        message = "密钥登录未通过。请检查公钥是否已加入服务器 authorized_keys、SSH Agent 是否解锁及网络连接。"
    return {"status": "error", "message": message}


class ConnectionStore:
    def __init__(self, owner: str):
        self.root = paths.sub("ssh-connections", hashlib.sha256(owner.encode()).hexdigest())

    def get(self, profile_id: str) -> dict:
        if not re.fullmatch(r"[a-f0-9-]{36}", profile_id):
            raise ValueError("SSH 连接标识无效")
        profile = json.loads((self.root / f"{profile_id}.json").read_text(encoding="utf-8"))
        if profile.get("id") != profile_id or profile.get("revision") != digest({k: v for k, v in profile.items() if k != "revision"}):
            raise ValueError("SSH 连接记录已变化或损坏，请重新配置")
        endpoint(profile)
        known_hosts(profile)
        return profile

    def list(self) -> list[dict]:
        if not self.root.exists():
            return []
        return [self.get(item.stem) for item in sorted(self.root.glob("*.json"))[:64]]

    def save(self, profile: dict, request_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
            raise ValueError("保存请求标识无效")
        profile = dict(profile, id=str(uuid.uuid5(uuid.NAMESPACE_URL, request_id)))
        profile["revision"] = digest(profile)
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / f"{profile['id']}.json"
        if target.exists():
            if self.get(profile["id"]) != profile:
                raise ValueError("该保存请求已用于其他连接，请刷新后核对")
            return profile
        if len(self.list()) >= 64:
            raise ValueError("已保存连接达到 64 个上限")
        # 先完整写入临时文件，再以不可覆盖 hard link 发布不可变记录。
        fd, temporary = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(profile, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                if self.get(profile["id"]) != profile:
                    raise ValueError("保存请求发生冲突，请刷新后核对")
        finally:
            os.unlink(temporary)
        return profile

"""Node-local release checking, staging and safe installer orchestration."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import platform as platform_module
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlparse, urlsplit, urlunsplit

import httpx

from . import paths
from .kit_update_journal import InstallJournal, NormalUpdateLease, durable_json, fingerprint, read_record


MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024
STATE_PHASES = {
    "idle", "checking", "current", "stale", "available", "downloading", "staged",
    "installing", "installed", "cancelled", "error",
}


def _now() -> float:
    return time.time()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    if os.name != "nt":
        try:
            path.chmod(0o600)
        except OSError:
            pass


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else dict(fallback)
    except Exception:
        return dict(fallback)


def _platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _arch() -> str:
    value = platform_module.machine().lower().replace("-", "_")
    if value in {"amd64", "x64", "x86_64"}:
        return "x86_64"
    if value in {"arm64", "aarch64"}:
        return "aarch64"
    return value or "unknown"


def _runtime() -> str:
    """Return the installation boundary that owns this executor.

    A Docker node must update its images/containers from the host-side updater;
    replacing files inside the running container would disappear on recreate.
    Compose sets the explicit marker, while ``/.dockerenv`` keeps custom Docker
    deployments safe even when they have not copied the marker yet.
    """
    explicit = str(os.environ.get("AGENT_WITH_U_RUNTIME") or "").strip().lower()
    if explicit in {"docker", "container"}:
        return "docker"
    if explicit in {"desktop", "headless", "native"}:
        return explicit
    if Path("/.dockerenv").exists():
        return "docker"
    if os.environ.get("AGENT_WITH_U_DESKTOP_EXE"):
        return "desktop"
    return "headless"


def _docker_updater_dir() -> Path:
    configured = str(os.environ.get("AGENT_WITH_U_DOCKER_UPDATER_DIR") or "").strip()
    return Path(configured).expanduser() if configured else paths.data_root() / "docker-updater"


def _docker_updater_available(max_age_seconds: float = 30.0) -> bool:
    if _runtime() != "docker":
        return False
    try:
        heartbeat = _docker_updater_dir() / "heartbeat"
        recorded = float(heartbeat.read_text(encoding="utf-8").strip())
        return recorded > 0 and abs(_now() - recorded) <= max_age_seconds
    except (OSError, TypeError, ValueError):
        return False


def _current_release() -> dict[str, Any]:
    try:
        from .. import _version as version_module

        package_version = str(getattr(version_module, "__package_version__", "") or "")
        legacy_version = str(getattr(version_module, "__version__", "") or "0.0.0-dev")
        return {
            "version": str(getattr(version_module, "__display_version__", "") or legacy_version),
            "packageVersion": package_version or legacy_version,
            "buildId": str(getattr(version_module, "__build_id__", "") or ""),
            "sequence": int(getattr(version_module, "__build_sequence__", 0) or 0),
            "commit": str(getattr(version_module, "__commit__", "") or ""),
        }
    except Exception:
        return {"version": "0.0.0-dev", "packageVersion": "0.0.0-dev", "buildId": "", "commit": ""}


def _version_tuple(value: object) -> tuple[int, ...]:
    numbers = [int(item) for item in re.findall(r"\d+", str(value or ""))]
    return tuple(numbers[:8]) if numbers else (0,)


def _release_sequence(release: dict[str, Any]) -> int:
    explicit = release.get("sequence")
    try:
        if explicit is not None and str(explicit).strip():
            return int(explicit)
    except (TypeError, ValueError):
        pass
    build_id = str(release.get("buildId") or "")
    # Generated ids start with YYYYMMDDHHMMSS and may end in a Git hash.
    # Never concatenate digits from that hash into the ordering sequence.
    timestamp = re.search(r"(?<!\d)(\d{14})(?!\d)", build_id)
    if timestamp:
        return int(timestamp.group(1))
    first_number = re.search(r"\d+", build_id)
    return int(first_number.group(0)[:20]) if first_number else 0


def _compare_releases(release: dict[str, Any], current: dict[str, Any]) -> int:
    """Return 1 for newer, 0 for equal and -1 for an older remote manifest."""
    remote_sequence = _release_sequence(release)
    current_sequence = _release_sequence(current)
    if remote_sequence and current_sequence:
        return (remote_sequence > current_sequence) - (remote_sequence < current_sequence)
    remote_version = _version_tuple(release.get("version"))
    current_version = _version_tuple(current.get("version"))
    return (remote_version > current_version) - (remote_version < current_version)


def _is_newer(release: dict[str, Any], current: dict[str, Any]) -> bool:
    return _compare_releases(release, current) > 0


def _cache_busted_url(source: str) -> str:
    parts = urlsplit(source)
    if parts.scheme not in {"http", "https"}:
        return source
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key != "_awu_cache_bust"]
    query.append(("_awu_cache_bust", f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _safe_name(value: object, fallback: str = "artifact.bin") -> str:
    name = Path(str(value or fallback).replace("\\", "/")).name
    name = re.sub(r"[^A-Za-z0-9._+()-]", "_", name).strip(". ")
    return name[:180] or fallback


def _canonical_manifest_payload(document: dict[str, Any]) -> bytes:
    unsigned = dict(document)
    unsigned.pop("signature", None)
    return json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class UpdateError(RuntimeError):
    pass


class UpdateManager:
    """One update state machine per executor process."""

    def __init__(self, root: Optional[Path] = None):
        self.root = (root or paths.sub("updates")).expanduser()
        self.root.mkdir(parents=True, exist_ok=True)
        self.config_path = self.root / "config.json"
        self.state_path = self.root / "state.json"
        self.result_path = self.root / "install-result.json"
        self.journal = InstallJournal(self.root)
        self._normal_request = ""
        self._normal_lease: Optional[NormalUpdateLease] = None
        self._stage_lock = asyncio.Lock()
        self._stage_submissions: dict[str, asyncio.Task] = {}
        self._checking = False
        self._task: Optional[asyncio.Task] = None
        self._selection: Optional[dict[str, Any]] = None
        self._state = _read_json(self.state_path, {"phase": "idle"})
        self._reconcile_install_result()

    def _config(self) -> dict[str, Any]:
        value = _read_json(self.config_path, {})
        return {
            "manifestUrl": str(value.get("manifestUrl") or ""),
            "channel": str(value.get("channel") or "stable"),
            "requireSignature": bool(value.get("requireSignature", False)),
            "signatureKey": str(value.get("signatureKey") or ""),
            "requestHeaders": value.get("requestHeaders") if isinstance(value.get("requestHeaders"), dict) else {},
        }

    def public_config(self) -> dict[str, Any]:
        cfg = self._config()
        return {
            "manifestUrl": cfg["manifestUrl"],
            "channel": cfg["channel"],
            "requireSignature": cfg["requireSignature"],
            "hasSignatureKey": bool(cfg["signatureKey"] or os.environ.get("AGENT_WITH_U_UPDATE_KEY")),
            "hasRequestHeaders": bool(cfg["requestHeaders"]),
        }

    def configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        if self._checking or self._task and not self._task.done():
            raise UpdateError('正在准备更新，请先暂停下载。')
        try:
            return self._configure(patch)
        finally:
            self._drop_normal_lease()

    def _configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        if self._state.get('phase') == 'installing':
            raise UpdateError('安装已经交接，请查看原安装结果。')
        self._recover_normal_request()
        self.journal.require_slot(self._normal_request)
        current = self._config()
        if "manifestUrl" in patch:
            current["manifestUrl"] = str(patch.get("manifestUrl") or "").strip()
            if current["manifestUrl"]:
                self._validate_source(current["manifestUrl"], manifest=True)
        if "channel" in patch:
            channel = re.sub(r"[^A-Za-z0-9._-]", "", str(patch.get("channel") or "stable"))[:40]
            current["channel"] = channel or "stable"
        if "requireSignature" in patch:
            current["requireSignature"] = bool(patch.get("requireSignature"))
        if "signatureKey" in patch and str(patch.get("signatureKey") or ""):
            current["signatureKey"] = str(patch["signatureKey"])
        if patch.get("clearSignatureKey"):
            current["signatureKey"] = ""
        if "requestHeaders" in patch:
            headers = patch.get("requestHeaders")
            if not isinstance(headers, dict):
                raise UpdateError("requestHeaders must be an object")
            current["requestHeaders"] = {
                str(key)[:120]: str(value)[:4000] for key, value in headers.items()
                if str(key).strip() and "\n" not in str(key) and "\r" not in str(key)
            }
        _atomic_json(self.config_path, current)
        self._drop_normal_lease()
        return self.public_config()

    def _base_status(self) -> dict[str, Any]:
        task_running = bool(self._task and not self._task.done())
        state = dict(self._state)
        phase = str(state.get("phase") or "idle")
        if phase not in STATE_PHASES:
            phase = "idle"
        return {
            **state,
            "phase": phase,
            "busy": task_running or self._checking or phase == "installing",
            "current": _current_release(),
            "platform": _platform(),
            "arch": _arch(),
            "desktop": bool(os.environ.get("AGENT_WITH_U_DESKTOP_EXE")),
            "runtime": _runtime(),
            "dockerUpdaterAvailable": _docker_updater_available(),
            "config": self.public_config(),
            "updateProtocol": 2,
        }

    def status(self) -> dict[str, Any]:
        self._reconcile_install_result()
        return self._base_status()

    def _save_state(self, patch: dict[str, Any]) -> dict[str, Any]:
        self._state = {**self._state, **patch, "updatedAt": _now()}
        _atomic_json(self.state_path, self._state)
        return self._base_status()

    def _reconcile_install_result(self) -> None:
        active = self.journal.active()
        if active.get("kind") == "kit":
            # 旧时间戳回执永远不能验收 Kit 安装或释放其节点预留。
            return
        apply_id = str(self._state.get('applyRequestId') or '')
        isolated_result = bool(re.fullmatch(r'[a-f0-9]{32}', apply_id) and self._state.get('isolatedApplyResult'))
        result_path = self.root / ('install-result-' + apply_id + '.json') if isolated_result else self.result_path
        result = _read_json(result_path, {})
        if not result:
            return
        if isolated_result and self._state.get('resultSeenRequestId') == apply_id:
            return
        if not isolated_result and float(result.get("finishedAt") or 0) <= float(self._state.get("resultSeenAt") or 0):
            return
        # 老桌面/sidecar 未回显 requestId；独立结果文件仍只属于本次安装。
        if apply_id and result.get('requestId') != apply_id and not (isolated_result and not result.get('requestId')):
            return
        ok = bool(result.get("ok"))
        self._state = {
            **self._state,
            "phase": "installed" if ok else "error",
            "message": "更新安装完成" if ok else "更新安装失败",
            "error": "" if ok else str(result.get("error") or "installer failed"),
            "applyFailed": not ok,
            "resultSeenRequestId": apply_id,
            "resultSeenAt": float(result.get("finishedAt") or _now()),
            "updatedAt": _now(),
        }
        _atomic_json(self.state_path, self._state)
        if active.get("kind") == "normal":
            self.journal.release(active["requestId"], active["identity"], "succeeded" if ok else "failed")
            self._normal_request = ""
            if self._normal_lease:
                self._normal_lease.close()
                self._normal_lease = None

    def _reserve_normal(self) -> str:
        self._recover_normal_request()
        if self._normal_lease is None:
            self._normal_lease = NormalUpdateLease(self.journal.folder)
        try:
            self.journal.require_slot(self._normal_request)
            request_id = self._normal_request or uuid.uuid4().hex
            self.journal.reserve(request_id, {}, kind="normal")
            self._normal_request = request_id
            return request_id
        except BaseException:
            self._drop_normal_lease()
            raise

    def _recover_normal_request(self) -> None:
        """接回未交接的普通准备记录；旧 planPath 本身不代表安装已经启动。"""
        active = self.journal.active()
        if not active:
            self._normal_request = ''
            self._state = read_record(self.state_path) or self._state
            return
        if active.get('requestId') == self._normal_request and self._normal_lease is not None:
            return
        if active.get('kind') != 'normal':
            self.journal.require_slot(self._normal_request)
        lease = self._normal_lease or NormalUpdateLease(self.journal.folder)
        try:
            record = self.journal.get(active['requestId'], {})
            state = read_record(self.state_path)
            if (record.get('phase') != 'preparing' or record.get('confirmationId')
                    or not state or state.get('phase') == 'installing'
                    or state.get('applyRequestId') and not state.get('applyFailed')):
                raise UpdateError('原更新已交给安装器或结果尚未确认，请刷新状态核对原安装；不会重复安装。')
            self.journal.require_slot(active['requestId'])
            self._normal_request = active['requestId']
            self._normal_lease = lease
            self._state = state
            if state.get('phase') in {'checking', 'downloading'} and not (self._task and not self._task.done()):
                self._save_state({'phase': 'error', 'message': '上次准备已中断，可继续或替换更新', 'error': ''})
        except BaseException:
            if self._normal_lease is not lease:
                lease.close()
            raise

    def reserve_kit(self, request_id: str, identity: dict[str, str]) -> dict[str, Any]:
        active = self.journal.active()
        if active.get("requestId") != request_id and (
                self._task and not self._task.done() or self._state.get("phase") in {
                    "checking", "downloading", "staged", "installing"}):
            raise UpdateError("节点已有普通更新或暂存制品，请先完成或取消原更新")
        return self.journal.reserve(request_id, identity)

    def _release_normal(self, phase: str = "cancelled") -> None:
        if self._normal_request:
            self.journal.release(self._normal_request, {}, phase)
            self._normal_request = ""
        self._drop_normal_lease()

    def _drop_normal_lease(self) -> None:
        if self._normal_lease is not None:
            self._normal_lease.close()
            self._normal_lease = None

    def release_kit(self, request_id: str, identity: dict[str, str], phase: str = "cancelled") -> None:
        """准备协程已退出后，仅清理本请求的暂存投影，最后才释放节点占用。"""
        record = self.journal.get(request_id, identity)
        if record.get("confirmationId"):
            raise UpdateError("已确认安装只能核对结果")
        if self._state.get("kitRequestId") == request_id:
            self._save_state({"phase": phase, "kitRequestId": "", "planPath": "",
                              "artifactPath": "", "message": "本次安装准备已结束"})
            self._selection = None
        self.journal.release(request_id, identity, phase)

    @staticmethod
    def _validate_source(source: str, manifest: bool = False) -> None:
        # urllib 把 ``C:\\...`` 的盘符误认成 URL scheme，先处理原生绝对路径。
        if Path(str(source or "")).expanduser().is_absolute():
            return
        parsed = urlparse(str(source or ""))
        if parsed.scheme in {"https", "http"} and parsed.netloc:
            return
        if parsed.scheme == "file" and unquote(parsed.path):
            return
        kind = "manifest" if manifest else "artifact"
        raise UpdateError(f"unsupported {kind} URL; use HTTPS, HTTP or an absolute file path")

    async def _read_source(self, source: str, *, limit: int = 4 * 1024 * 1024,
                           use_headers: bool = True) -> bytes:
        self._validate_source(source, manifest=True)
        parsed = urlparse(source)
        if parsed.scheme in {"https", "http"}:
            cfg = self._config()
            headers = {
                str(key): str(value) for key, value in cfg["requestHeaders"].items()
                if use_headers and str(key).lower() not in {"cache-control", "pragma"}
            }
            headers.update({
                "Cache-Control": "no-cache, no-store, max-age=0",
                "Pragma": "no-cache",
            })
            async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=60)) as client:
                response = await client.get(_cache_busted_url(source), headers=headers)
                response.raise_for_status()
                if len(response.content) > limit:
                    raise UpdateError("update manifest is too large")
                return response.content
        path = Path(unquote(parsed.path)) if parsed.scheme == "file" else Path(source).expanduser()
        if os.name == "nt" and parsed.scheme == "file" and parsed.netloc:
            path = Path(f"//{parsed.netloc}{unquote(parsed.path)}")
        if path.stat().st_size > limit:
            raise UpdateError("update manifest is too large")
        return await asyncio.to_thread(path.read_bytes)

    def _verify_manifest(self, document: dict[str, Any]) -> None:
        cfg = self._config()
        key = os.environ.get("AGENT_WITH_U_UPDATE_KEY") or cfg["signatureKey"]
        signature = document.get("signature") if isinstance(document.get("signature"), dict) else {}
        supplied = str(signature.get("value") or "").lower()
        algorithm = str(signature.get("algorithm") or "").lower()
        if cfg["requireSignature"] and not key:
            raise UpdateError("this node requires a signature but has no verification key")
        if not key:
            if cfg["requireSignature"] or supplied:
                raise UpdateError("manifest is signed but this node has no verification key")
            return
        if algorithm != "hmac-sha256" or not supplied:
            raise UpdateError("manifest signature is missing or unsupported")
        expected = hmac.new(key.encode("utf-8"), _canonical_manifest_payload(document), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied):
            raise UpdateError("manifest signature verification failed")

    @staticmethod
    def _release(document: dict[str, Any]) -> dict[str, Any]:
        release = document.get("release") if isinstance(document.get("release"), dict) else {}
        release = dict(release)
        for key in ("version", "buildId", "sequence", "publishedAt", "notes"):
            if key not in release and key in document:
                release[key] = document[key]
        if not str(release.get("version") or "").strip():
            raise UpdateError("manifest release.version is required")
        return release

    def _artifact_url(self, manifest_url: str, artifact: dict[str, Any]) -> str:
        raw = str(artifact.get("url") or "").strip()
        if not raw:
            raise UpdateError("artifact URL is missing")
        parsed = urlparse(raw)
        if parsed.scheme:
            resolved = raw
        else:
            manifest_parsed = urlparse(manifest_url)
            if manifest_parsed.scheme in {"http", "https", "file"}:
                resolved = urljoin(manifest_url, raw)
            else:
                resolved = str((Path(manifest_url).expanduser().parent / raw).resolve())
        self._validate_source(resolved)
        return resolved

    def _select_artifact(self, document: dict[str, Any], manifest_url: str,
                         artifact_id: str = "") -> dict[str, Any]:
        artifacts = document.get("artifacts")
        if not isinstance(artifacts, list):
            raise UpdateError("manifest artifacts must be an array")
        current_platform, current_arch = _platform(), _arch()
        desktop = bool(os.environ.get("AGENT_WITH_U_DESKTOP_EXE"))
        candidates: list[dict[str, Any]] = []
        for raw in artifacts:
            if not isinstance(raw, dict):
                continue
            artifact = dict(raw)
            if artifact_id and str(artifact.get("id") or "") != artifact_id:
                continue
            platform_value = str(artifact.get("platform") or artifact.get("os") or "any").lower()
            arch_value = str(artifact.get("arch") or "any").lower().replace("-", "_")
            if platform_value not in {"any", "*", current_platform}:
                continue
            if arch_value in {"amd64", "x64"}:
                arch_value = "x86_64"
            if arch_value in {"arm64"}:
                arch_value = "aarch64"
            if arch_value not in {"any", "*", current_arch}:
                continue
            artifact["url"] = self._artifact_url(manifest_url, artifact)
            artifact["id"] = str(artifact.get("id") or _safe_name(artifact.get("fileName")))
            candidates.append(artifact)
        if not candidates:
            raise UpdateError(f"no artifact for {current_platform}/{current_arch}")
        runtime = _runtime()
        if runtime == "docker":
            docker_candidates = [
                item for item in candidates
                if str(item.get("target") or "").lower() in {"docker", "container"}
                or str(item.get("kind") or "").lower() == "docker-bundle"
            ]
            if not docker_candidates:
                raise UpdateError(
                    f"manifest has no Docker bundle for {current_platform}/{current_arch}; "
                    "publish target=docker, kind=docker-bundle"
                )
            candidates = docker_candidates
        preferred = "docker" if runtime == "docker" else ("desktop" if desktop else "executor")
        candidates.sort(key=lambda item: (
            0 if str(item.get("target") or "desktop") == preferred else 1,
            0 if str(item.get("platform") or item.get("os") or "") == current_platform else 1,
            str(item.get("id") or ""),
        ))
        return candidates[0]

    @staticmethod
    def _public_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(artifact.get("id") or ""),
            "platform": str(artifact.get("platform") or artifact.get("os") or "any"),
            "arch": str(artifact.get("arch") or "any"),
            "target": str(artifact.get("target") or "desktop"),
            "kind": str(artifact.get("kind") or "custom"),
            "fileName": _safe_name(artifact.get("fileName") or urlparse(str(artifact.get("url") or "")).path),
            "url": str(artifact.get("url") or ""),
            "size": int(artifact.get("size") or 0),
            "hasInstaller": isinstance(artifact.get("install"), dict) or bool(artifact.get("kind")),
        }

    async def check(self, manifest_url: str = "", artifact_id: str = "") -> dict[str, Any]:
        if self._checking or self._task and not self._task.done():
            raise UpdateError('正在准备更新，请查看原任务状态。')
        if self._state.get('phase') == 'installing':
            raise UpdateError('安装已经交接，请查看原安装结果。')
        self._recover_normal_request()
        if self._checking:
            raise UpdateError('正在检查更新，请查看原任务状态。')
        transient = not self._normal_request
        self._reserve_normal()
        self._checking = True
        try:
            result = await self._check(manifest_url, artifact_id)
        finally:
            self._checking = False
            if transient:
                self._release_normal()
            else:
                self._drop_normal_lease()
        result['busy'] = bool(self._task and not self._task.done())
        return result

    async def _check(self, manifest_url: str = "", artifact_id: str = "") -> dict[str, Any]:
        self.journal.require_slot(self._normal_request)
        if self._task and not self._task.done():
            raise UpdateError("an update download is already running")
        source = str(manifest_url or self._config()["manifestUrl"]).strip()
        if not source:
            raise UpdateError("configure a manifest URL first")
        self._save_state({"phase": "checking", "message": "正在检查更新", "error": ""})
        try:
            raw = await self._read_source(source)
            document = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(document, dict) or int(document.get("schemaVersion") or 0) != 1:
                raise UpdateError("unsupported update manifest schema")
            self._verify_manifest(document)
            configured_channel = self._config()["channel"]
            manifest_channel = str(document.get("channel") or "stable")
            if configured_channel and manifest_channel != configured_channel:
                raise UpdateError(f"manifest channel is {manifest_channel}, expected {configured_channel}")
            release = self._release(document)
            artifact = self._select_artifact(document, source, artifact_id)
            self._selection = {
                "manifestUrl": source, "release": release, "artifact": artifact,
                "signed": bool(document.get("signature")),
                "policyFingerprint": self._kit_source_fingerprint(),
            }
            selection_fingerprint = fingerprint(self._selection)
            relation = _compare_releases(release, _current_release())
            available = relation > 0
            if relation > 0:
                phase = "available"
                message = "发现可用更新"
                manifest_relation = "newer"
            elif relation < 0:
                phase = "stale"
                message = "远端更新清单早于当前节点；可能是 CDN 缓存未刷新或发布清单未切换"
                manifest_relation = "older"
            else:
                phase = "current"
                message = "当前已是最新版本"
                manifest_relation = "same"
            return self._save_state({
                "phase": phase,
                "available": available,
                "message": message,
                "manifestRelation": manifest_relation,
                "error": "",
                "manifestUrl": source,
                "release": release,
                "artifact": self._public_artifact(artifact),
                "manifestSigned": bool(document.get("signature")),
                "selectionFingerprint": selection_fingerprint,
                "downloadedBytes": 0,
                "totalBytes": int(artifact.get("size") or 0),
            })
        except Exception as error:
            self._selection = None
            self._save_state({"phase": "error", "available": False, "message": "检查更新失败", "error": str(error)})
            raise

    async def inspect_published(self, published: dict[str, Any]) -> dict[str, Any]:
        """只读核对本次成功发布的不可变对象；不会读取/修改日常通道配置。"""
        if published.get("schemaVersion") != 1 or not all(published.get(key) for key in (
                "runId", "stepId", "jobId", "planId", "planFingerprint", "manifestSha256")):
            raise UpdateError("缺少本次发布凭据")
        source = str(published.get("manifestUrl") or "")
        raw = await self._read_source(source, use_headers=False)
        document = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise UpdateError("unsupported update manifest schema")
        self._verify_manifest(document)
        digest = hashlib.sha256(_canonical_manifest_payload(document)).hexdigest()
        if not hmac.compare_digest(digest, str(published["manifestSha256"])):
            raise UpdateError("不可变发布清单摘要不匹配")
        release = self._release(document)
        if (release != published.get("release") or document.get("artifacts") != published.get("artifacts")
                or document.get("channel") != published.get("channel")):
            raise UpdateError("发布身份或制品与冻结记录不匹配")
        return self._inspect_kit_manifest(document, source)

    def _inspect_kit_manifest(self, document: dict[str, Any], source: str) -> dict[str, Any]:
        """两种 Kit 来源共用安装边界，但不共用/伪造发布凭据。"""
        release = self._release(document)
        if (type(release.get("kitUpdateProtocol")) is not int or release["kitUpdateProtocol"] != 1
                or not release.get("buildId") or not release.get("sequence")):
            raise UpdateError("目标版本不支持 Kit 更新验收协议；请使用原更新入口")
        if _platform() != "windows" or _runtime() != "desktop":
            raise UpdateError("Kit 本机更新仅支持已安装 Windows 桌面")
        if not _is_newer(release, _current_release()):
            raise UpdateError("目标发布不是比当前节点更新的版本")
        candidates = []
        for item in document.get("artifacts", []):
            if (isinstance(item, dict) and item.get("platform") == "windows"
                    and item.get("arch") == _arch() and item.get("target") == "desktop"
                    and item.get("kind") in {"msi", "nsis"}):
                if item.get("install"):
                    # 严格链路仅允许产品自带 MSI/NSIS 安装语义，不能注入命令或重启路径。
                    raise UpdateError("Kit 更新不接受制品中的自定义安装命令")
                if (not item.get("id") or not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256") or ""))
                        or type(item.get("size")) is not int or not 0 < item["size"] <= MAX_ARTIFACT_BYTES):
                    raise UpdateError("发布制品身份、大小或摘要无效")
                artifact = dict(item)
                artifact["url"] = self._artifact_url(source, artifact)
                candidates.append(artifact)
        if not candidates or len({item["id"] for item in candidates}) != len(candidates):
            raise UpdateError("没有兼容且身份唯一的 Windows 安装制品")
        return {"manifestUrl": source, "release": release, "artifacts": candidates,
                "signed": bool(document.get("signature")), "channel": str(document.get("channel") or "stable")}

    def _kit_source_fingerprint(self) -> str:
        # 只保存摘要，不将签名密钥或请求头写入 Kit/公开计划。
        return fingerprint({**self._config(), "environmentKey": os.environ.get("AGENT_WITH_U_UPDATE_KEY", "")})

    async def check_configured_for_kit(self, request_id: str) -> dict[str, Any]:
        """在本请求预留内只读检查常规更新源；返回本次快照而非发布 job 回执。"""
        self.journal.require_slot(request_id)
        config = self._config()
        config_fingerprint = self._kit_source_fingerprint()
        source = config["manifestUrl"].strip()
        if not source:
            raise UpdateError("请先在节点更新中心配置更新清单地址和通道")
        raw = await self._read_source(source)
        document = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise UpdateError("unsupported update manifest schema")
        self._verify_manifest(document)
        channel = str(document.get("channel") or "stable")
        if channel != config["channel"]:
            raise UpdateError(f"manifest channel is {channel}, expected {config['channel']}")
        if config_fingerprint != self._kit_source_fingerprint():
            raise UpdateError("检查期间更新源或验证策略已变化，请重新运行")
        release = self._release(document)
        current = _current_release()
        # 序号/版本相等不等于构建相同，不能把未知身份显示成无需更新。
        if (not release.get("buildId") or not release.get("packageVersion") or type(release.get("sequence")) is not int
                or release["sequence"] <= 0 or not current.get("buildId") or not current.get("sequence")):
            raise UpdateError("当前或目标构建身份不完整，无法可靠检查更新")
        relation = _compare_releases(release, current)
        if relation < 0:
            raise UpdateError("远端更新清单早于当前节点；请核对更新源或 CDN 缓存，不执行降级")
        if relation == 0 and any(not release.get(key) or release[key] != current.get(key)
                                 for key in ("version", "packageVersion", "buildId", "sequence")):
            raise UpdateError("清单序号相同但完整构建身份不同，不能视为无需更新")
        snapshot = {"schemaVersion": 1, "sourceKind": "configured", "manifestUrl": source,
                    "configFingerprint": config_fingerprint, "channel": channel,
                    "manifestSha256": hashlib.sha256(_canonical_manifest_payload(document)).hexdigest(),
                    "document": document, "release": release, "checkedAt": int(_now()),
                    "phase": "current" if relation == 0 else "available"}
        if relation > 0:
            self._inspect_kit_manifest(document, source)
        return snapshot

    def inspect_configured_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """选择/确认不重读 latest；复核已冻结快照及当前验证策略，绝不换装新版本。"""
        if (snapshot.get("sourceKind") != "configured" or snapshot.get("schemaVersion") != 1
                or snapshot.get("phase") != "available"
                or snapshot.get("configFingerprint") != self._kit_source_fingerprint()):
            raise UpdateError("已检查的更新源或验证策略已变化；请取消后重新检查")
        document = snapshot.get("document")
        if (not isinstance(document, dict) or document.get("schemaVersion") != 1
                or hashlib.sha256(_canonical_manifest_payload(document)).hexdigest() != snapshot.get("manifestSha256")
                or self._release(document) != snapshot.get("release")
                or str(document.get("channel") or "stable") != snapshot.get("channel")
                or snapshot.get("channel") != self._config()["channel"]
                or snapshot.get("manifestUrl") != self._config()["manifestUrl"].strip()):
            raise UpdateError("已检查的更新清单快照不匹配")
        self._verify_manifest(document)
        return self._inspect_kit_manifest(document, snapshot["manifestUrl"])

    async def stage_configured_snapshot(self, snapshot: dict[str, Any], artifact_id: str = "",
                                        *, request_id: str) -> dict[str, Any]:
        self.journal.require_slot(request_id)
        inspected = self.inspect_configured_snapshot(snapshot)
        return await self._stage_kit_inspected(inspected, artifact_id, request_id=request_id, configured=True)

    async def stage_published(self, published: dict[str, Any], artifact_id: str = "",
                              *, request_id: str = "") -> dict[str, Any]:
        self.journal.require_slot(request_id or self._normal_request)
        if self._task and not self._task.done():
            raise UpdateError("an update download is already running")
        inspected = await self.inspect_published(published)
        return await self._stage_kit_inspected(inspected, artifact_id, request_id=request_id)

    async def _stage_kit_inspected(self, inspected: dict[str, Any], artifact_id: str,
                                  *, request_id: str, configured: bool = False) -> dict[str, Any]:
        self.journal.require_slot(request_id or self._normal_request)
        if self._task and not self._task.done():
            raise UpdateError("an update download is already running")
        candidates = inspected.pop("artifacts")
        if not artifact_id and len(candidates) != 1:
            return {"phase": "needs_selection", "artifacts": candidates, "release": inspected["release"]}
        selected = [item for item in candidates if not artifact_id or item["id"] == artifact_id]
        if len(selected) != 1:
            raise UpdateError("必须明确选择本次发布的兼容安装器")
        if request_id:
            self.journal.require_slot(request_id)
        else:
            self._reserve_normal()
        selection = {**inspected, "artifact": selected[0], "strictPublished": not configured}
        self._selection = selection
        self._save_state({"phase": "downloading", "error": "", "message": "下载本次发布的精确版本",
                          "kitRequestId": request_id,
                          "release": selection["release"], "artifact": self._public_artifact(selected[0]),
                          "manifestUrl": selection["manifestUrl"]})
        self._task = asyncio.create_task(self._download(selection))
        self._task.add_done_callback(self._download_finished)
        await self._task
        if self._state.get("phase") != "staged":
            raise UpdateError(str(self._state.get("error") or "本次发布制品暂存失败"))
        return self.status()

    async def start_stage(self, manifest_url: str = "", artifact_id: str = "",
                          force: bool = False, request_id: str = "",
                          selection_fingerprint: str = "") -> dict[str, Any]:
        request_id = request_id or uuid.uuid4().hex
        if not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise UpdateError('更新请求 ID 无效')
        arguments = fingerprint({'source': manifest_url, 'artifact': artifact_id,
                                 'force': force, 'selection': selection_fingerprint})
        async def submit() -> dict[str, Any]:
            async with self._stage_lock:
                try:
                    return await self._submit_stage(manifest_url, artifact_id, force, request_id,
                                                    selection_fingerprint, arguments)
                finally:
                    if not self._checking and not (self._task and not self._task.done()):
                        self._drop_normal_lease()
        task = self._stage_submissions.get(request_id)
        if task is None:
            task = asyncio.create_task(submit())
            self._stage_submissions[request_id] = task
            def finished(done: asyncio.Task) -> None:
                if self._stage_submissions.get(request_id) is done:
                    self._stage_submissions.pop(request_id, None)
                self._consume_task_error(done)
            task.add_done_callback(finished)
        # 提交后的准备属于节点，UI 超时/断线不能取消它或再创建一份下载。
        result = await asyncio.shield(task)
        if result.get('stageArguments') != arguments:
            raise UpdateError('同一更新请求不能更换版本或参数')
        return result

    async def _submit_stage(self, manifest_url: str, artifact_id: str, force: bool,
                            request_id: str, selection_fingerprint: str, arguments: str) -> dict[str, Any]:
        if self._checking:
            raise UpdateError('正在检查更新，请稍后继续。')
        self._recover_normal_request()
        receipt_path = self.journal.folder / ('stage-' + request_id + '.json')
        receipt = read_record(receipt_path)
        if receipt and (receipt.get('arguments') != arguments or self._state.get('stageRequestId') != request_id):
            raise UpdateError('该更新请求已结束或被替换，请刷新状态后发起新更新。')
        if self._state.get('stageRequestId') == request_id:
            if self._state.get('stageArguments') != arguments:
                raise UpdateError('同一更新请求不能更换版本或参数')
            return self.status()
        if self._state.get('phase') == 'installing':
            raise UpdateError('安装已经交接，请查看原安装结果。')
        if self._task and not self._task.done():
            await self.cancel()
        if self._normal_request:
            self._release_normal()
        self._reserve_normal()
        durable_json(receipt_path, {'arguments': arguments})
        self._save_state({'phase': 'checking', 'message': '正在准备更新', 'error': '',
                          'stageRequestId': request_id, 'stageArguments': arguments,
                          'applyRequestId': '', 'applyFailed': False, 'kitRequestId': '',
                          'isolatedApplyResult': False,
                          'planPath': '', 'stagedPath': '', 'retryAttempt': 0, 'resumedBytes': 0})
        try:
            if not (selection_fingerprint and self._selection
                    and self._selection.get('policyFingerprint') == self._kit_source_fingerprint()
                    and self._selection.get('manifestUrl') == (manifest_url or self._config()['manifestUrl']).strip()
                    and (not artifact_id or self._selection['artifact'].get('id') == artifact_id)
                    and fingerprint(self._selection) == selection_fingerprint):
                await self.check(manifest_url, artifact_id)
            if selection_fingerprint and (not self._selection or fingerprint(self._selection) != selection_fingerprint):
                raise UpdateError('更新版本已变化，请重新检查并确认目标版本。')
            if not force and not bool(self._state.get('available')):
                return self.status()
            self._reserve_normal()
            selection = dict(self._selection or {})
            self._task = asyncio.create_task(self._download(selection))
            self._task.add_done_callback(self._download_finished)
            return self._save_state({'phase': 'downloading', 'message': '准备下载更新', 'error': ''})
        except Exception as error:
            self._save_state({'phase': 'error', 'message': '更新准备失败', 'error': str(error)})
            raise

    @staticmethod
    def _consume_task_error(task: asyncio.Task) -> None:
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass

    def _download_finished(self, task: asyncio.Task) -> None:
        self._consume_task_error(task)
        if self._task is task and not self._checking and not self._stage_lock.locked():
            self._drop_normal_lease()

    async def _download(self, selection: dict[str, Any]) -> None:
        artifact = selection["artifact"]
        release = selection["release"]
        url = str(artifact["url"])
        name = _safe_name(artifact.get("fileName") or urlparse(url).path)
        expected_hash = str(artifact.get("sha256") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            self._save_state({"phase": "error", "message": "更新清单无效", "error": "artifact SHA-256 is required"})
            return
        expected_size = int(artifact.get("size") or 0)
        if expected_size < 0 or expected_size > MAX_ARTIFACT_BYTES:
            self._save_state({"phase": "error", "message": "更新制品过大", "error": "artifact size is outside the allowed range"})
            return
        release_dir = self.root / _safe_name(release.get("buildId") or release.get("version"), "release") / expected_hash[:16]
        release_dir.mkdir(parents=True, exist_ok=True)
        target = release_dir / name
        temporary = target.with_suffix(target.suffix + ".part")
        try:
            digest = hashlib.sha256()
            downloaded = 0
            parsed = urlparse(url)
            if parsed.scheme in {"http", "https"}:
                from .update_download import download_http
                cfg = self._config()
                downloaded, actual_hash = await download_http(
                    url, temporary, expected_hash, expected_size,
                    {} if selection.get('strictPublished') else cfg['requestHeaders'],
                    MAX_ARTIFACT_BYTES, self._save_state)
            else:
                with temporary.open('wb') as output:
                    source = Path(unquote(parsed.path)) if parsed.scheme == "file" else Path(url).expanduser()
                    if os.name == "nt" and parsed.scheme == "file" and parsed.netloc:
                        source = Path(f"//{parsed.netloc}{unquote(parsed.path)}")
                    total = source.stat().st_size
                    if total > MAX_ARTIFACT_BYTES:
                        raise UpdateError("artifact exceeds the 8 GiB safety limit")
                    with source.open("rb") as input_stream:
                        while True:
                            block = await asyncio.to_thread(input_stream.read, 1024 * 1024)
                            if not block:
                                break
                            downloaded += len(block)
                            output.write(block)
                            digest.update(block)
                            self._save_state({"phase": "downloading", "downloadedBytes": downloaded, "totalBytes": expected_size or total})
                actual_hash = digest.hexdigest().lower()
            if expected_size and downloaded != expected_size:
                raise UpdateError(f"artifact size mismatch: expected {expected_size}, got {downloaded}")
            if actual_hash != expected_hash:
                raise UpdateError("artifact SHA-256 mismatch")
            os.replace(temporary, target)
            plan = self._build_plan(selection, target, expected_hash)
            plan_path = release_dir / "install-plan.json"
            _atomic_json(plan_path, plan)
            self._save_state({
                "phase": "staged", "message": "更新已下载并校验，等待安装", "error": "",
                "downloadedBytes": downloaded, "totalBytes": downloaded,
                "stagedPath": str(target), "planPath": str(plan_path),
            })
        except asyncio.CancelledError:
            self._save_state({"phase": "cancelled", "message": "下载已暂停，断点已保留", "error": ""})
            raise
        except Exception as error:
            from .update_download import DownloadInterrupted
            if not isinstance(error, DownloadInterrupted):
                temporary.unlink(missing_ok=True)
            self._save_state({"phase": "error", "message": "更新下载未完成", "error": str(error)})

    @staticmethod
    def _replace_tokens(value: str, tokens: dict[str, str]) -> str:
        result = str(value)
        for key, replacement in tokens.items():
            result = result.replace("{" + key + "}", replacement)
        return result

    def _build_plan(self, selection: dict[str, Any], artifact_path: Path,
                    artifact_hash: str) -> dict[str, Any]:
        artifact = selection["artifact"]
        release = selection["release"]
        raw_install = artifact.get("install") if isinstance(artifact.get("install"), dict) else {}
        kind = str(artifact.get("kind") or "").lower()
        target_kind = str(artifact.get("target") or "").lower()
        docker_bundle = _runtime() == "docker" and (
            kind == "docker-bundle" or target_kind in {"docker", "container"}
        )
        if docker_bundle and kind != "docker-bundle":
            raise UpdateError("Docker update artifacts must use kind=docker-bundle")
        tokens = {
            "artifact": str(artifact_path),
            "artifactDir": str(artifact_path.parent),
            "dataDir": str(paths.data_root()),
            "home": str(Path.home()),
        }
        program = str(raw_install.get("program") or "").strip()
        args = raw_install.get("args") if isinstance(raw_install.get("args"), list) else []
        suffix = artifact_path.suffix.lower()
        if docker_bundle:
            # The privileged sidecar owns this operation.  Never accept an
            # installer command from the manifest for Docker image updates.
            program = ""
            args = []
            success_codes = [0]
        elif not program and _platform() == "windows" and (kind == "msi" or suffix == ".msi"):
            program = "msiexec.exe"
            args = ["/i", "{artifact}", "/qn", "/norestart"]
            success_codes = [0, 3010]
        elif not program and _platform() == "windows" and kind in {"nsis", "silent-exe"}:
            program = "{artifact}"
            args = ["/S"]
            success_codes = [0]
        elif not program and _platform() != "windows" and kind in {"shell", "sh"}:
            program = "/bin/sh"
            args = ["{artifact}"]
            success_codes = [0]
        else:
            success_codes = raw_install.get("successExitCodes") or [0]
        if not program and not docker_bundle:
            raise UpdateError("unknown artifact format; manifest install.program is required")
        resolved_program = self._replace_tokens(program, tokens)
        resolved_args = [self._replace_tokens(str(value), tokens) for value in args]
        cwd = self._replace_tokens(str(raw_install.get("cwd") or artifact_path.parent), tokens)

        restart_raw = raw_install.get("restart") if isinstance(raw_install.get("restart"), dict) else {}
        restart_program = str(restart_raw.get("program") or os.environ.get("AGENT_WITH_U_DESKTOP_EXE") or "")
        restart_args = restart_raw.get("args") if isinstance(restart_raw.get("args"), list) else []
        wait_pids = [os.getpid()]
        try:
            parent_pid = int(os.environ.get("AGENT_WITH_U_DESKTOP_PID") or 0)
            if parent_pid > 0:
                wait_pids.append(parent_pid)
        except ValueError:
            pass
        return {
            "marker": "agentwithu-update-plan-v1",
            "schemaVersion": 1,
            "version": str(release.get("version") or ""),
            "buildId": str(release.get("buildId") or ""),
            "artifactKind": kind,
            "artifactTarget": target_kind,
            "installerType": "docker-updater" if docker_bundle else "argv",
            "artifactPath": str(artifact_path),
            "artifactSha256": artifact_hash,
            "waitPids": sorted(set(wait_pids)),
            "waitTimeoutSeconds": int(raw_install.get("waitTimeoutSeconds") or 120),
            "restartDelaySeconds": float(raw_install.get("restartDelaySeconds") or 1),
            "install": {
                "program": resolved_program,
                "args": resolved_args,
                "cwd": cwd,
                "timeoutSeconds": int(raw_install.get("timeoutSeconds") or 1800),
                "successExitCodes": [int(value) for value in success_codes],
            },
            "restart": {
                "program": self._replace_tokens(restart_program, tokens) if restart_program else "",
                "args": [self._replace_tokens(str(value), tokens) for value in restart_args],
                "cwd": self._replace_tokens(str(restart_raw.get("cwd") or ""), tokens),
            },
            "resultPath": str(self.result_path),
        }

    async def cancel(self) -> dict[str, Any]:
        if self._checking:
            raise UpdateError('正在检查更新，请检查完成后再暂停。')
        self._recover_normal_request()
        self.journal.require_slot(self._normal_request)
        if self._state.get("phase") == "installing":
            raise UpdateError("安装已交接，不能保证撤回")
        task = self._task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        elif self._state.get("phase") in {"checking", "downloading", "staged"}:
            # A process restart can leave a persisted in-progress phase without
            # an asyncio task. Treat Cancel as recovery instead of trapping the
            # UI forever in a busy-looking state.
            self._release_normal()
            return self._save_state({
                "phase": "cancelled", "message": "已清除中断的更新任务", "error": "",
            })
        self._release_normal()
        return self.status()

    def mark_install_failed(self, message: str, request_id: str = "") -> dict[str, Any]:
        if request_id != str(self._state.get('applyRequestId') or ''):
            raise UpdateError('安装失败回执与当前请求不匹配')
        self.journal.require_slot(self._normal_request)
        return self._save_state({"phase": "error", "applyFailed": True, "message": "无法启动更新助手", "error": str(message)[:2000]})

    def prepare_apply(self, request_id: str = "", stage_request_id: str = "") -> dict[str, Any]:
        try:
            return self._prepare_apply(request_id, stage_request_id)
        finally:
            if not self._checking and not (self._task and not self._task.done()):
                self._drop_normal_lease()

    def _prepare_apply(self, request_id: str, stage_request_id: str) -> dict[str, Any]:
        if request_id and not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise UpdateError('安装请求 ID 无效')
        if not (self._task and not self._task.done()) and not self._checking:
            self._state = read_record(self.state_path) or self._state
        if request_id and self._state.get('applyRequestId') == request_id:
            if stage_request_id != (self._state.get('stageRequestId') or ''):
                raise UpdateError('安装请求与已校验下载不匹配')
            if self._state.get('applyFailed'):
                raise UpdateError(str(self._state.get('error') or '原安装启动失败'))
            return {'status': 'installed' if self._state.get('phase') == 'installed' else 'restarting',
                    'alreadyRequested': True}
        apply_receipt = self.journal.folder / ('apply-' + request_id + '.json') if request_id else None
        if apply_receipt and apply_receipt.exists():
            raise UpdateError('该安装请求已使用，请刷新状态核对原结果。')
        self._recover_normal_request()
        self.journal.require_slot(self._normal_request)
        if stage_request_id and stage_request_id != self._state.get('stageRequestId'):
            raise UpdateError('安装请求与已校验下载不匹配')
        if self._task and not self._task.done():
            raise UpdateError("wait for the update download to finish")
        plan_path = Path(str(self._state.get("planPath") or "")).expanduser()
        if self._state.get("phase") != "staged" or not plan_path.is_file():
            raise UpdateError("no verified staged update is ready")
        self._reserve_normal()
        try:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        except Exception as error:
            raise UpdateError(f"cannot read staged update plan: {error}") from error
        if plan.get("installerType") == "docker-updater":
            self._check_docker_apply(plan)
        if request_id:
            plan['requestId'] = request_id
            plan['resultPath'] = str(self.root / ('install-result-' + request_id + '.json'))
            if Path(plan['resultPath']).exists():
                raise UpdateError('该安装请求已有结果，不能重新使用。')
            durable_json(apply_receipt, {'stageRequestId': stage_request_id})
            _atomic_json(plan_path, plan)
            self._save_state({'applyRequestId': request_id, 'applyFailed': False, 'isolatedApplyResult': True})
        if plan.get("installerType") == "docker-updater":
            return self._prepare_docker_apply(plan_path)

        self._save_state({"phase": "installing", "message": "正在退出并安装更新", "error": ""})
        durable_json(self.state_path, self._state)
        self._drop_normal_lease()
        if os.environ.get("AGENT_WITH_U_DESKTOP_EXE"):
            return {"status": "restarting", "requiresDesktop": True, "planPath": str(plan_path)}
        try:
            self._launch_headless_helper(plan_path)
        except Exception as error:
            self.mark_install_failed(str(error), request_id)
            raise
        return {"status": "restarting", "requiresDesktop": False, "planPath": str(plan_path)}

    def _check_docker_apply(self, plan: dict[str, Any]) -> None:
        if plan.get("marker") != "agentwithu-update-plan-v1":
            raise UpdateError("untrusted staged update plan")
        if _runtime() != "docker":
            raise UpdateError("Docker bundle can only be installed by a Docker executor")
        updater_dir = _docker_updater_dir()
        if not _docker_updater_available():
            raise UpdateError(
                "Docker updater sidecar is offline; rebuild this deployment once with "
                "the current docker-compose.example.yml before using online update"
            )
        request_path = updater_dir / "request.json"
        processing_path = updater_dir / "processing.json"
        if request_path.exists() or processing_path.exists():
            raise UpdateError("another Docker update request is already pending")

    def _prepare_docker_apply(self, plan_path: Path) -> dict[str, Any]:
        request_path = _docker_updater_dir() / "request.json"
        request = {
            "marker": "agentwithu-docker-update-request-v1",
            "schemaVersion": 1,
            "requestId": uuid.uuid4().hex,
            "planPath": str(plan_path.resolve()),
            "createdAt": _now(),
        }
        self._save_state({
            "phase": "installing",
            "message": "Docker 镜像已校验，正在由升级伴随容器重建节点",
            "error": "",
        })
        durable_json(self.state_path, self._state)
        _atomic_json(request_path, request)
        return {
            "status": "restarting",
            "requiresDesktop": False,
            "docker": True,
            "planPath": str(plan_path),
        }

    def _launch_headless_helper(self, plan_path: Path) -> None:
        creationflags = 0
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL, "close_fds": True,
        }
        if getattr(sys, "frozen", False):
            suffix = ".exe" if os.name == "nt" else ""
            helper = self.root / f"update-helper{suffix}"
            shutil.copy2(sys.executable, helper)
            if os.name != "nt":
                helper.chmod(0o700)
            command = [str(helper), "--agentwithu-update-helper", str(plan_path)]
        else:
            project_root = Path(__file__).resolve().parents[2]
            command = [sys.executable, "-m", "src.backend.update_helper", str(plan_path)]
            kwargs["cwd"] = str(project_root)
        if os.name == "nt":
            creationflags = (
                getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            )
            breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
            kwargs["creationflags"] = creationflags | breakaway
            try:
                subprocess.Popen(command, **kwargs)
                return
            except OSError as first_error:
                # Some Windows job objects explicitly disallow breakaway. The
                # desktop helper has the same fallback; keep headless nodes
                # usable under service wrappers that do not enforce kill-on-close.
                kwargs["creationflags"] = creationflags
                try:
                    subprocess.Popen(command, **kwargs)
                    return
                except OSError as retry_error:
                    raise UpdateError(
                        "cannot launch update helper "
                        f"(breakaway: {first_error}; fallback: {retry_error})"
                    ) from retry_error
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(command, **kwargs)

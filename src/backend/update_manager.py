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
            "busy": task_running or phase in {"checking", "downloading", "installing"},
            "current": _current_release(),
            "platform": _platform(),
            "arch": _arch(),
            "desktop": bool(os.environ.get("AGENT_WITH_U_DESKTOP_EXE")),
            "runtime": _runtime(),
            "dockerUpdaterAvailable": _docker_updater_available(),
            "config": self.public_config(),
        }

    def status(self) -> dict[str, Any]:
        self._reconcile_install_result()
        return self._base_status()

    def _save_state(self, patch: dict[str, Any]) -> dict[str, Any]:
        self._state = {**self._state, **patch, "updatedAt": _now()}
        _atomic_json(self.state_path, self._state)
        return self._base_status()

    def _reconcile_install_result(self) -> None:
        result = _read_json(self.result_path, {})
        if not result or float(result.get("finishedAt") or 0) <= float(self._state.get("resultSeenAt") or 0):
            return
        ok = bool(result.get("ok"))
        self._state = {
            **self._state,
            "phase": "installed" if ok else "error",
            "message": "更新安装完成" if ok else "更新安装失败",
            "error": "" if ok else str(result.get("error") or "installer failed"),
            "resultSeenAt": float(result.get("finishedAt") or _now()),
            "updatedAt": _now(),
        }
        _atomic_json(self.state_path, self._state)

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

    async def _read_source(self, source: str, *, limit: int = 4 * 1024 * 1024) -> bytes:
        self._validate_source(source, manifest=True)
        parsed = urlparse(source)
        if parsed.scheme in {"https", "http"}:
            cfg = self._config()
            headers = {
                str(key): str(value) for key, value in cfg["requestHeaders"].items()
                if str(key).lower() not in {"cache-control", "pragma"}
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
            }
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
                "downloadedBytes": 0,
                "totalBytes": int(artifact.get("size") or 0),
            })
        except Exception as error:
            self._selection = None
            self._save_state({"phase": "error", "available": False, "message": "检查更新失败", "error": str(error)})
            raise

    async def start_stage(self, manifest_url: str = "", artifact_id: str = "",
                          force: bool = False) -> dict[str, Any]:
        if self._task and not self._task.done():
            raise UpdateError("an update download is already running")
        await self.check(manifest_url, artifact_id)
        if not force and not bool(self._state.get("available")):
            return self.status()
        selection = dict(self._selection or {})
        self._task = asyncio.create_task(self._download(selection))
        self._task.add_done_callback(self._consume_task_error)
        return self._save_state({"phase": "downloading", "message": "准备下载更新", "error": ""})

    @staticmethod
    def _consume_task_error(task: asyncio.Task) -> None:
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass

    async def _download(self, selection: dict[str, Any]) -> None:
        artifact = selection["artifact"]
        release = selection["release"]
        url = str(artifact["url"])
        name = _safe_name(artifact.get("fileName") or urlparse(url).path)
        release_dir = self.root / _safe_name(release.get("buildId") or release.get("version"), "release")
        release_dir.mkdir(parents=True, exist_ok=True)
        target = release_dir / name
        temporary = target.with_suffix(target.suffix + ".part")
        expected_hash = str(artifact.get("sha256") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            self._save_state({"phase": "error", "message": "更新清单无效", "error": "artifact SHA-256 is required"})
            return
        expected_size = int(artifact.get("size") or 0)
        if expected_size < 0 or expected_size > MAX_ARTIFACT_BYTES:
            self._save_state({"phase": "error", "message": "更新制品过大", "error": "artifact size is outside the allowed range"})
            return
        try:
            digest = hashlib.sha256()
            downloaded = 0
            parsed = urlparse(url)
            last_save = 0.0
            with temporary.open("wb") as output:
                if parsed.scheme in {"http", "https"}:
                    cfg = self._config()
                    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=120)) as client:
                        async with client.stream("GET", url, headers=cfg["requestHeaders"]) as response:
                            response.raise_for_status()
                            header_size = int(response.headers.get("content-length") or 0)
                            if header_size > MAX_ARTIFACT_BYTES:
                                raise UpdateError("artifact exceeds the 8 GiB safety limit")
                            total = expected_size or header_size
                            async for block in response.aiter_bytes(1024 * 1024):
                                if not block:
                                    continue
                                downloaded += len(block)
                                if downloaded > MAX_ARTIFACT_BYTES:
                                    raise UpdateError("artifact exceeds the 8 GiB safety limit")
                                output.write(block)
                                digest.update(block)
                                now = time.monotonic()
                                if now - last_save >= 0.5:
                                    self._save_state({"phase": "downloading", "downloadedBytes": downloaded, "totalBytes": total})
                                    last_save = now
                else:
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
            if expected_size and downloaded != expected_size:
                raise UpdateError(f"artifact size mismatch: expected {expected_size}, got {downloaded}")
            if digest.hexdigest().lower() != expected_hash:
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
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            self._save_state({"phase": "cancelled", "message": "更新下载已取消", "error": ""})
            raise
        except Exception as error:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            self._save_state({"phase": "error", "message": "更新下载失败", "error": str(error)})

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
        task = self._task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        elif self._state.get("phase") in {"checking", "downloading"}:
            # A process restart can leave a persisted in-progress phase without
            # an asyncio task. Treat Cancel as recovery instead of trapping the
            # UI forever in a busy-looking state.
            return self._save_state({
                "phase": "cancelled", "message": "已清除中断的更新任务", "error": "",
            })
        return self.status()

    def mark_install_failed(self, message: str) -> dict[str, Any]:
        return self._save_state({"phase": "error", "message": "无法启动更新助手", "error": str(message)[:2000]})

    def prepare_apply(self) -> dict[str, Any]:
        if self._task and not self._task.done():
            raise UpdateError("wait for the update download to finish")
        plan_path = Path(str(self._state.get("planPath") or "")).expanduser()
        if self._state.get("phase") != "staged" or not plan_path.is_file():
            raise UpdateError("no verified staged update is ready")
        try:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        except Exception as error:
            raise UpdateError(f"cannot read staged update plan: {error}") from error
        if plan.get("installerType") == "docker-updater":
            if plan.get("marker") != "agentwithu-update-plan-v1":
                raise UpdateError("untrusted staged update plan")
            return self._prepare_docker_apply(plan_path)

        self._save_state({"phase": "installing", "message": "正在退出并安装更新", "error": ""})
        if os.environ.get("AGENT_WITH_U_DESKTOP_EXE"):
            return {"status": "restarting", "requiresDesktop": True, "planPath": str(plan_path)}
        try:
            self._launch_headless_helper(plan_path)
        except Exception as error:
            self.mark_install_failed(str(error))
            raise
        return {"status": "restarting", "requiresDesktop": False, "planPath": str(plan_path)}

    def _prepare_docker_apply(self, plan_path: Path) -> dict[str, Any]:
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
        request = {
            "marker": "agentwithu-docker-update-request-v1",
            "schemaVersion": 1,
            "requestId": uuid.uuid4().hex,
            "planPath": str(plan_path.resolve()),
            "createdAt": _now(),
        }
        _atomic_json(request_path, request)
        self._save_state({
            "phase": "installing",
            "message": "Docker 镜像已校验，正在由升级伴随容器重建节点",
            "error": "",
        })
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

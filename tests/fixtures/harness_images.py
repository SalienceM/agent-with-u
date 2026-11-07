"""隔离的 Harness 图片/目录夹具；只含合成像素、假凭据和 loopback 服务。"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
from email import policy
from email.parser import BytesParser
import io
import json
import os
from pathlib import Path
import queue
import random
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator
from unittest.mock import patch
import uuid

from PIL import Image


FIXTURE_KEY = "awu-image-fixture-not-a-real-credential"
MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def image_bytes(fmt: str = "PNG", *, size: tuple[int, int] = (32, 24),
                color: tuple[int, int, int] = (210, 40, 30), noise: bool = False) -> bytes:
    """确定性静态图片；大尺寸/噪声样本按需生成，不保留用户图片。"""
    with Image.new("RGB", size, color) as image:
        if noise:
            image.frombytes(random.Random(71).randbytes(size[0] * size[1] * 3))
        with io.BytesIO() as output:
            image.save(output, format=fmt, **({"lossless": True} if fmt == "WEBP" else {}))
            return output.getvalue()


def image_block(fmt: str = "PNG", **kwargs: Any) -> dict[str, str]:
    return {"type": "image", "data": base64.b64encode(image_bytes(fmt, **kwargs)).decode("ascii"),
            "mimeType": MIME[fmt]}


def image_samples() -> dict[str, bytes]:
    png = image_bytes()
    with Image.new("RGB", (16, 16), "red") as first, Image.new("RGB", (16, 16), "blue") as second:
        with io.BytesIO() as output:
            first.save(output, format="WEBP", save_all=True, append_images=[second], duration=100, loop=0)
            animated = output.getvalue()
    return {"png": png, "jpeg": image_bytes("JPEG"), "webp": image_bytes("WEBP"),
            "truncated": png[:len(png) // 2], "fake_mime": b"<svg/>", "animated": animated,
            "oversized_bytes": image_bytes(size=(1200, 1200), noise=True),
            "oversized_edge": image_bytes(size=(8193, 1))}


def model_catalog(*, model: str = "deepseek-flash", modalities: list[str] | None = None) -> dict[str, Any]:
    return {"object": "list", "data": [{"id": model, "object": "model", "owned_by": "fixture",
        "input_modalities": ["text", "image"] if modalities is None else modalities,
        "api_capabilities": {"anthropic_messages": {}}}]}


class LocalImageModel:
    """只接受假 key；模拟原生 Files 成功/错误/配额和 Messages，不访问远端。"""
    def __init__(self, *, catalog: dict[str, Any] | None = None, catalog_status: int = 200,
                 files_quota: bool = False, files_mode: str = "missing", message_status: int = 200,
                 hold_messages: bool = False, quota_detail: str = "quota_exceeded",
                 error_message: str = "fixture model rejected") -> None:
        self.catalog = model_catalog() if catalog is None else catalog
        self.catalog_status = catalog_status
        self.posts: list[dict[str, Any]] = []
        self.paths: list[tuple[str, str]] = []
        self.errors: list[str] = []
        self.files_quota = files_quota or files_mode == "quota"
        self.files_mode = files_mode
        self.message_status = message_status
        self.error_message = error_message
        self.hold_messages = hold_messages
        self.quota_detail = quota_detail
        self.quota_foreign = True
        self.message_received = threading.Event()
        self.release_messages = threading.Event()
        self.uploads: dict[str, bytes] = {}
        self.upload_names: dict[str, str] = {}
        self.deleted: list[str] = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass  # 不打印正文、图片或请求头。

            def authorized(self) -> bool:
                if self.client_address[0] != "127.0.0.1" or self.headers.get("x-api-key") != FIXTURE_KEY:
                    fixture.errors.append("non-fixture-auth")
                    self.respond(403, {"error": {"message": "fixture authentication required"}})
                    return False
                fixture.paths.append((self.command, self.path))
                return True

            def respond(self, status: int, body: dict[str, Any]) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if not self.authorized():
                    return
                if fixture.files_quota and self.path.startswith("/v1/files?"):
                    # 均不是当前临时 DSH_HOME 上传的文件；普通文件用于核对前缀过滤。
                    rows = [{"id": id_, "type": "file", "filename": name, "mime_type": "image/png",
                             "size_bytes": 100, "created_at": "2026-01-01T00:00:00Z"}
                            for id_, name in (("fixture-other-session", "dsh-other-session.png"),
                                              ("fixture-user-file", "user-original.png"))]
                    if not fixture.quota_foreign:
                        rows = []
                    rows.extend({"id": id_, "type": "file", "filename": fixture.upload_names[id_],
                                 "mime_type": "image/png", "size_bytes": len(data),
                                 "created_at": "2026-01-02T00:00:00Z"}
                                for id_, data in fixture.uploads.items())
                    self.respond(200, {"data": rows, "has_more": False})
                    return
                if self.path != "/models":
                    fixture.errors.append("unexpected-get")
                    self.respond(404, {})
                    return
                self.respond(fixture.catalog_status, fixture.catalog)

            def do_DELETE(self) -> None:
                if not self.authorized():
                    return
                if not fixture.files_quota or not self.path.startswith("/v1/files/"):
                    fixture.errors.append("unexpected-delete")
                    self.respond(404, {})
                    return
                file_id = self.path.removeprefix("/v1/files/")
                fixture.deleted.append(file_id)  # 只记录模拟删除，不处理任何实际文件。
                self.respond(200, {"id": file_id, "type": "file_deleted"})

            def do_POST(self) -> None:
                if not self.authorized():
                    return
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16 * 1024 * 1024:
                    fixture.errors.append("invalid-body-size")
                    self.respond(413, {})
                    return
                body = self.rfile.read(size)
                if self.path.endswith("/files"):
                    if fixture.files_quota:
                        self.respond(400, {"error": {"type": fixture.quota_detail, "message": fixture.quota_detail}})
                    elif fixture.files_mode == "success":
                        message = BytesParser(policy=policy.default).parsebytes(
                            f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode() + body)
                        parts = [part for part in message.iter_parts()
                                 if part.get_param("name", header="content-disposition") == "file"]
                        if len(parts) != 1:
                            fixture.errors.append("invalid-upload")
                            self.respond(400, {})
                            return
                        file_id = f"fixture-upload-{len(fixture.uploads) + 1}"
                        data = parts[0].get_payload(decode=True)
                        fixture.uploads[file_id] = data
                        fixture.upload_names[file_id] = parts[0].get_filename()
                        self.respond(200, {"id": file_id, "type": "file", "filename": fixture.upload_names[file_id],
                                          "mime_type": parts[0].get_content_type(), "size_bytes": len(data),
                                          "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                    elif fixture.files_mode == "error":
                        self.respond(400, {"error": {"type": "invalid_request_error", "message": "fixture upload rejected"}})
                    else:
                        self.respond(404, {"error": {"type": "not_found_error", "message": "fixture has no Files API"}})
                    return
                if self.path != "/v1/messages":
                    fixture.errors.append("unexpected-post")
                    self.respond(404, {})
                    return
                fixture.posts.append(json.loads(body))
                fixture.message_received.set()
                if fixture.hold_messages:
                    fixture.release_messages.wait(timeout=15)
                    return  # 取消场景不再写入已经关闭的 socket。
                if fixture.message_status != 200:
                    self.respond(fixture.message_status, {"error": {"type": "invalid_request_error", "message": fixture.error_message}})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for event in [
                    {"type": "message_start", "message": {"id": "fixture-reply", "model": fixture.posts[-1]["model"],
                        "usage": {"input_tokens": 3, "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "fixture reply"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
                    {"type": "message_stop"},
                ]:
                    self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
                    self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="awu-image-fixture", daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self) -> LocalImageModel:
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.release_messages.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise AssertionError("Image fixture server did not stop")


class ImageWorkspace:
    """所有写入和原生进程必须归属单个临时树；异常也必须确认 owned cleanup。"""
    def __init__(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="awu-harness-images-")
        self.root = Path(self._temporary.name).resolve()
        self.project = self.root / "project"
        self.home = self.root / "dsh-home"
        self.data = self.root / "awu-data"
        self.owners: list[Any] = []
        for directory in (self.project, self.home, self.data):
            directory.mkdir()
            if not directory.resolve().is_relative_to(self.root) or directory.is_symlink():
                raise AssertionError("Image fixture directory is not isolated")
        self.environment = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.data),
            "DSH_HOME": str(self.home), "DSH_TELEMETRY_DISABLED": "1"})

    def __enter__(self) -> ImageWorkspace:
        self.environment.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.environment.stop()
        if any(not owner.confirmed for owner in self.owners):
            # 未确认的进程仍可能持有测试目录，不通过删目录掩盖泄漏。
            # TemporaryDirectory 的 finalizer 否则仍会隐式删除，此分支必须保留现场。
            self._temporary._finalizer.detach()
            raise AssertionError(f"Native image fixture has unconfirmed owned processes; retained: {self.root}")
        self._temporary.cleanup()

    @contextmanager
    def client(self, model: LocalImageModel, *, route: str = "deepseek-flash", session: str = "image-fixture",
               probe: str = "observe", egress: str = "", bridge: Path | None = None,
               provider_options: dict[str, Any] | None = None, environment_url: str | None = None) -> Iterator[Any]:
        from pydantic import BaseModel
        from src.backend.deepseek_harness_sdk import SyncOwner, bridge_path, create_client, create_harness_config
        from src.backend.deepseek_harness_state import atomic_json, make_profile_patch

        class Empty(BaseModel):
            pass

        generation = uuid.uuid4().hex
        identity = {"sessionId": session, "generation": generation, "configFingerprint": "isolated-image-contract"}
        runtime_patch = self.root / f"{generation}.patch.json"
        rows = make_profile_patch(native_id=session, generation=generation, fingerprint=identity["configFingerprint"],
            bridge=bridge or bridge_path(), cwd=str(self.project), mode="read-only", skip_permissions=True,
            image_identity={"ownerId": "fixture-owner", "executorId": "fixture-executor",
                "awuSessionId": "fixture-awu-session", "backendId": "fixture-backend",
                "provider": "deepseek-official", "model": route})
        if provider_options is not None:
            rows.append({"id": "llm-deepseek", "config": provider_options})
        rows.append({"insert": [{"id": "awu-image-contract-fixture", "name":
            Path(__file__).with_name("harness_image_probe.mjs").resolve().as_uri(), "inject": ["llm", "agents"],
            "config": {"origin": model.url, "output": str(self.root / "probe.jsonl"), "mode": probe,
                       "egress": egress, "identity": {**identity, "provider": "deepseek-official", "model": route}}}]})
        atomic_json(runtime_patch, rows)
        owner = SyncOwner(generation=generation, receipt=self.root / f"{generation}.exit.json")
        self.owners.append(owner)
        client = create_client(config=create_harness_config(cwd=str(self.project), dsh_home=str(self.home),
            patches=(str(runtime_patch),), env={"DEEPSEEK_API_KEY": FIXTURE_KEY, "DEEPSEEK_BASE_URL": environment_url or model.url,
                "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "127.0.0.1"},
            initialize_timeout_seconds=20, request_timeout_seconds=10), owner=owner)
        try:
            client.start()
            client.initialize(cwd=str(self.project), provider="deepseek-official", model=route)
            client.request("awu/capabilities", {}, response_model=Empty)
            client.request("awu/configure", {**identity, "constraints": "Local image fixture only.",
                "allowedTools": []}, response_model=Empty)
            yield client
        finally:
            client.close()
            if not owner.confirmed:
                facts = {"processExited": owner.process is not None and owner.process.poll() is not None,
                    "jobHeld": bool(owner.tree and owner.tree.job), "treeComplete": bool(owner.tree and owner.tree.complete),
                    "heldHandles": len(owner.tree.handles) if owner.tree else 0,
                    "readerAlive": bool(client._reader_thread and client._reader_thread.is_alive()),
                    "stderrAlive": bool(client._stderr_thread and client._stderr_thread.is_alive())}
                raise AssertionError(f"Image fixture native cleanup unconfirmed: {facts}")


class RawNativeImageWorkspace(ImageWorkspace):
    """显式保留升级前的无防护风险复现；不得默认回落到当前受保护桥。"""
    @contextmanager
    def client(self, model: LocalImageModel, **kwargs: Any) -> Iterator[Any]:
        bridge = Path(__file__).resolve().parents[2] / "build/deepseek-harness/native-risk-contract/lib/index.mjs"
        expected = "918ec0a484ed877981663e74e565d72522390c89c48dacfc35f48b83155358f1"
        if not bridge.is_file() or hashlib.sha256(bridge.read_bytes()).hexdigest() != expected:
            raise AssertionError("Preserve the audited pre-image bridge as native-risk-contract before rebuilding")
        with super().client(model, bridge=bridge, **kwargs) as client:
            yield client


def run_prompt(client: Any, blocks: list[dict[str, Any]], *, session: str = "image-fixture",
               admission: str | None = None) -> list[Any]:
    """只在 receipt 对应的本轮事件之后接收终态，bounded 等待并消费通知。"""
    from pydantic import BaseModel

    class Empty(BaseModel):
        pass

    if admission is None:
        receipt = client.session_prompt(session, blocks)
    else:
        class Receipt(BaseModel):
            messageId: str
        receipt = client.request("session/prompt", {"sessionId": session, "contentBlocks": blocks,
            "awuImageAdmission": {"admissionId": admission}}, response_model=Receipt).messageId
    notes: list[Any] = []
    received = False
    ended = False
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            note = client.next_owned_notification(timeout=.1)
        except queue.Empty:
            continue
        event = note.payload.get("event", {})
        if note.payload.get("sessionId") != session:
            continue
        if event.get("type") == "agent/inbox/spliced":
            received |= any(item.get("id") == receipt for item in event.get("data", {}).get("inserted", []))
        if not received:
            continue
        notes.append(note)
        if event.get("type") == "turn/end":
            ended = True
        if ended and note.method == "session.status" and note.payload.get("status") == "idle":
            client.request("session/wait", {"sessionId": session}, response_model=Empty, timeout_seconds=5)
            return notes
    raise AssertionError("Native image fixture did not produce a bounded terminal result")

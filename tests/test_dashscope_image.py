from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from src.backend.dashscope_image import DashScopeImageBackend
from src.types import BackendType, ImageAttachment, ModelBackendConfig


class _Response:
    def __init__(
        self,
        status_code: int,
        *,
        json_data: dict | None = None,
        content: bytes = b"",
        content_type: str = "image/png",
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data or {}
        self.content = content
        self.headers = {"content-type": content_type}
        self.text = str(self._json_data)

    def json(self) -> dict:
        return self._json_data


class _Client:
    def __init__(
        self,
        response: dict,
        images: dict[str, bytes],
        task_responses: list[dict] | None = None,
        post_responses: list[_Response] | None = None,
    ) -> None:
        self.response = response
        self.images = images
        self.task_responses = list(task_responses or [])
        self.post_responses = list(post_responses or [])
        self.last_task_response: dict | None = None
        self.posts: list[tuple[str, dict]] = []
        self.gets: list[str] = []

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def post(self, url: str, **kwargs) -> _Response:
        self.posts.append((url, kwargs))
        if self.post_responses:
            return self.post_responses.pop(0)
        return _Response(200, json_data=self.response)

    async def get(self, url: str, **_kwargs) -> _Response:
        self.gets.append(url)
        if "/tasks/" in url:
            if self.task_responses:
                self.last_task_response = self.task_responses.pop(0)
            if self.last_task_response is not None:
                return _Response(200, json_data=self.last_task_response)
            return _Response(404)
        if url not in self.images:
            return _Response(404)
        return _Response(200, content=self.images[url])


def _image(index: int) -> ImageAttachment:
    raw = f"reference-{index}".encode()
    return ImageAttachment(
        id=f"ref-{index}",
        base64=base64.b64encode(raw).decode("ascii"),
        mime_type="image/png",
        size=len(raw),
    )


class DashScopeImageBackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._image_root = tempfile.TemporaryDirectory()
        self.addCleanup(self._image_root.cleanup)
        image_root = Path(self._image_root.name)
        path_patcher = patch(
            "src.backend.dashscope_image.paths.sub",
            side_effect=lambda *parts: image_root.joinpath(*parts),
        )
        path_patcher.start()
        self.addCleanup(path_patcher.stop)

    async def test_qwen3_i2i_uses_workspace_sync_api_and_returns_every_image(self) -> None:
        first = "https://result.example/first.png"
        second = "https://result.example/second.png"
        response = {
            "output": {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": [{"image": first}, {"image": second}],
                    },
                }],
            },
            "usage": {"output_image_count": 2},
        }
        client = _Client(response, {first: b"first-image", second: b"second-image"})
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-image",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3 Pro",
            model="qwen-image-3.0-pro",
            api_key="sk-test",
            env={
                "DASHSCOPE_WORKSPACE_ID": "ws-demo-01",
                "DASHSCOPE_REGION": "cn-beijing",
                "PROMPT_EXTEND": "true",
                "PROMPT_EXTEND_MODE": "agent",
                "ENABLE_THINKING": "true",
                "NEGATIVE_PROMPT": "blurry",
                "WATERMARK": "false",
                "N": "2",
                "SEED": "42",
                "DASHSCOPE_CALL_MODE": "sync",
            },
        ))
        deltas = []

        with patch("src.backend.dashscope_image.httpx.AsyncClient", return_value=client):
            await backend.send_message(
                messages=[],
                content="把两张参考图融合为杂志封面",
                images=[_image(1), _image(2)],
                session_id="session-1",
                message_id="message-1",
                on_delta=deltas.append,
            )

        self.assertEqual(len(client.posts), 1)
        url, request = client.posts[0]
        self.assertEqual(
            url,
            "https://ws-demo-01.cn-beijing.maas.aliyuncs.com/api/v1/"
            "services/aigc/multimodal-generation/generation",
        )
        self.assertNotIn("X-DashScope-Async", request["headers"])
        payload = request["json"]
        self.assertEqual(payload["model"], "qwen-image-3.0-pro")
        parameters = payload["parameters"]
        self.assertNotIn("size", parameters)
        self.assertEqual(parameters["n"], 2)
        # Agent 提示词增强不支持 I2I，后端应自动降级，不把 400 留给用户。
        self.assertEqual(parameters["prompt_extend_mode"], "direct")
        self.assertTrue(parameters["enable_thinking"])
        self.assertEqual(parameters["negative_prompt"], "blurry")
        self.assertEqual(parameters["seed"], 42)

        content = payload["input"]["messages"][0]["content"]
        self.assertEqual([list(item) for item in content], [["image"], ["image"], ["text"]])
        self.assertEqual(content[-1]["text"], "把两张参考图融合为杂志封面")
        self.assertTrue(content[0]["image"].startswith("data:image/png;base64,"))

        rendered = "".join(delta.text or "" for delta in deltas if delta.type == "text_delta")
        self.assertEqual(
            rendered.count("![生成图像](http://127.0.0.1:44322/api/skill-images/"), 2,
        )
        self.assertNotIn(";base64,", rendered)
        saved = list((Path(self._image_root.name) / "skill-images").glob("*.png"))
        self.assertEqual(sorted(path.read_bytes() for path in saved), [b"first-image", b"second-image"])
        done = next(delta for delta in deltas if delta.type == "done")
        self.assertEqual(done.usage, {"inputTokens": 0, "outputTokens": 2})

    async def test_qwen3_t2i_accepts_full_endpoint_and_explicit_ratio(self) -> None:
        image_url = "https://result.example/image.png"
        client = _Client({
            "output": {"choices": [{"message": {"content": [{"image": image_url}]}}]},
            "usage": {"output_image_count": 1},
        }, {image_url: b"image"})
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-image",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3",
            model="qwen-image-3.0",
            api_key="sk-test",
            base_url=(
                "https://demo.ap-southeast-1.maas.aliyuncs.com/api/v1/"
                "services/aigc/multimodal-generation/generation"
            ),
            env={
                "PROMPT_EXTEND_MODE": "agent",
                "ENABLE_THINKING": "false",
                "DASHSCOPE_CALL_MODE": "sync",
            },
        ))

        with patch("src.backend.dashscope_image.httpx.AsyncClient", return_value=client):
            await backend.send_message(
                messages=[],
                content="一只在月球上的猫 --size 16:9",
                images=None,
                session_id="session-2",
                message_id="message-2",
                on_delta=lambda _delta: None,
            )

        url, request = client.posts[0]
        self.assertEqual(
            url,
            "https://demo.ap-southeast-1.maas.aliyuncs.com/api/v1/"
            "services/aigc/multimodal-generation/generation",
        )
        payload = request["json"]
        self.assertEqual(payload["parameters"]["size"], "1280*720")
        self.assertEqual(payload["parameters"]["prompt_extend_mode"], "agent")
        self.assertFalse(payload["parameters"]["enable_thinking"])
        self.assertEqual(
            payload["input"]["messages"][0]["content"],
            [{"text": "一只在月球上的猫"}],
        )

    async def test_qwen3_auto_routes_heavy_pro_task_to_async_and_polls_until_success(self) -> None:
        image_url = "https://result.example/async.png"
        # 8MB 正是 marked v9 会栈溢出的量级；backend 输出必须仍然只是短 URL。
        large_image = b"\x89PNG\r\n\x1a\n" + (b"A" * (8 * 1024 * 1024))
        client = _Client(
            {"output": {"task_status": "PENDING", "task_id": "task-heavy-1"}},
            {image_url: large_image},
            task_responses=[
                {"output": {"task_status": "PENDING", "task_id": "task-heavy-1"}},
                {"output": {"task_status": "RUNNING", "task_id": "task-heavy-1"}},
                {
                    "output": {
                        "task_status": "SUCCEEDED",
                        "task_id": "task-heavy-1",
                        "choices": [{"message": {"content": [{"image": image_url}]}}],
                    },
                    "usage": {"output_image_count": 1},
                },
            ],
        )
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-pro-auto",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3 Pro",
            model="qwen-image-3.0-pro",
            api_key="sk-test",
            env={
                "DASHSCOPE_WORKSPACE_ID": "ws-demo-01",
                "DASHSCOPE_REGION": "cn-beijing",
                "DASHSCOPE_CALL_MODE": "auto",
                "DASHSCOPE_MAX_WAIT_SECONDS": "3600",
            },
        ))
        deltas = []

        with (
            patch("src.backend.dashscope_image.httpx.AsyncClient", return_value=client),
            patch("src.backend.dashscope_image.asyncio.sleep", new=AsyncMock()),
        ):
            await backend.send_message(
                messages=[],
                content="生成一张细节丰富的电影海报",
                images=None,
                session_id="session-heavy",
                message_id="message-heavy",
                on_delta=deltas.append,
            )

        url, request = client.posts[0]
        self.assertEqual(
            url,
            "https://ws-demo-01.cn-beijing.maas.aliyuncs.com/api/v1/"
            "services/aigc/image-generation/generation",
        )
        self.assertEqual(request["headers"]["X-DashScope-Async"], "enable")
        self.assertEqual(len([url for url in client.gets if "/tasks/" in url]), 3)
        rendered = "".join(delta.text or "" for delta in deltas if delta.type == "text_delta")
        self.assertIn("自动判定重任务：Pro 模型", rendered)
        self.assertIn("task-heavy-1", rendered)
        self.assertIn("![生成图像](http://127.0.0.1:44322/api/skill-images/", rendered)
        self.assertNotIn(";base64,", rendered)
        self.assertLess(len(rendered), 2_000)
        saved = list((Path(self._image_root.name) / "skill-images").glob("*.png"))
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0].stat().st_size, len(large_image))
        self.assertEqual(deltas[-1].type, "done")

    def test_qwen3_auto_keeps_a_light_standard_request_synchronous(self) -> None:
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-light",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3",
            model="qwen-image-3.0",
            env={"DASHSCOPE_CALL_MODE": "auto"},
        ))

        is_async, reason = backend._select_call_mode(
            "qwen-image-3.0",
            route_is_async=False,
            call_mode="auto",
            prompt="一只猫",
            size="1024*1024",
            reference_count=0,
            output_count=1,
            prompt_extend=True,
            prompt_extend_mode="direct",
            enable_thinking=False,
        )

        self.assertFalse(is_async)
        self.assertEqual(reason, "自动判定轻任务")

    async def test_auto_safely_switches_when_service_explicitly_rejects_sync(self) -> None:
        image_url = "https://result.example/fallback.png"
        client = _Client(
            {},
            {image_url: b"fallback-image"},
            task_responses=[{
                "output": {
                    "task_status": "SUCCEEDED",
                    "choices": [{"message": {"content": [{"image": image_url}]}}],
                },
                "usage": {"output_image_count": 1},
            }],
            post_responses=[
                _Response(400, json_data={
                    "message": "current user api does not support synchronous calls",
                }),
                _Response(200, json_data={
                    "output": {"task_status": "PENDING", "task_id": "task-fallback"},
                }),
            ],
        )
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-auto-fallback",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3",
            model="qwen-image-3.0",
            api_key="sk-test",
            env={
                "DASHSCOPE_CALL_MODE": "auto",
                "ENABLE_THINKING": "false",
                "PROMPT_EXTEND_MODE": "direct",
            },
        ))
        deltas = []

        with (
            patch("src.backend.dashscope_image.httpx.AsyncClient", return_value=client),
            patch("src.backend.dashscope_image.asyncio.sleep", new=AsyncMock()),
        ):
            await backend.send_message(
                messages=[],
                content="一只猫",
                images=None,
                session_id="session-fallback",
                message_id="message-fallback",
                on_delta=deltas.append,
            )

        self.assertEqual(len(client.posts), 2)
        self.assertIn("multimodal-generation", client.posts[0][0])
        self.assertIn("image-generation", client.posts[1][0])
        self.assertNotIn("X-DashScope-Async", client.posts[0][1]["headers"])
        self.assertEqual(client.posts[1][1]["headers"]["X-DashScope-Async"], "enable")
        rendered = "".join(delta.text or "" for delta in deltas if delta.type == "text_delta")
        self.assertIn("当前账号不支持同步调用，自动切换为异步", rendered)
        self.assertEqual(deltas[-1].type, "done")

    async def test_sync_read_timeout_is_not_resubmitted(self) -> None:
        class TimeoutClient(_Client):
            async def post(self, url: str, **kwargs) -> _Response:
                self.posts.append((url, kwargs))
                raise httpx.ReadTimeout(
                    "read timed out",
                    request=httpx.Request("POST", url),
                )

        client = TimeoutClient({}, {})
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-timeout",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3",
            model="qwen-image-3.0",
            api_key="sk-test",
            env={
                "DASHSCOPE_CALL_MODE": "auto",
                "ENABLE_THINKING": "false",
                "PROMPT_EXTEND_MODE": "direct",
            },
        ))
        deltas = []

        with patch("src.backend.dashscope_image.httpx.AsyncClient", return_value=client):
            await backend.send_message(
                messages=[],
                content="一只猫",
                images=None,
                session_id="session-timeout",
                message_id="message-timeout",
                on_delta=deltas.append,
            )

        self.assertEqual(len(client.posts), 1)
        error = next(delta.error for delta in deltas if delta.type == "error")
        self.assertIn("请求可能已被服务端受理", error)
        self.assertIn("没有自动重发", error)

    async def test_qwen3_rejects_more_than_three_reference_images_before_request(self) -> None:
        backend = DashScopeImageBackend(ModelBackendConfig(
            id="qwen-image",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen Image 3",
            model="qwen-image-3.0",
            api_key="sk-test",
        ))
        deltas = []

        await backend.send_message(
            messages=[],
            content="融合参考图",
            images=[_image(1), _image(2), _image(3), _image(4)],
            session_id="session-3",
            message_id="message-3",
            on_delta=deltas.append,
        )

        error = next(delta.error for delta in deltas if delta.type == "error")
        self.assertIn("最多支持 3 张参考图", error)

    def test_qwen3_size_range_and_wan_defaults_are_kept_separate(self) -> None:
        qwen = DashScopeImageBackend(ModelBackendConfig(
            id="qwen",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Qwen",
            model="qwen-image-3.0",
        ))
        wan = DashScopeImageBackend(ModelBackendConfig(
            id="wan",
            type=BackendType.DASHSCOPE_IMAGE,
            label="Wan",
            model="wan2.7",
        ))

        self.assertEqual(qwen._resolve_size("", "qwen-image-3.0"), "")
        self.assertEqual(wan._resolve_size("", "wan2.7"), "1024*1024")
        self.assertEqual(wan._route("wan2.7-any-account-model"), (
            "/services/aigc/multimodal-generation/generation", "messages", False,
        ))
        self.assertEqual(wan._route("wanx2.1-t2i-turbo"), (
            "/services/aigc/text2image/image-synthesis", "prompt", True,
        ))
        wan_async, wan_reason = wan._select_call_mode(
            "wanx2.1-t2i-turbo",
            route_is_async=True,
            call_mode="sync",
            prompt="一只猫",
            size="1024*1024",
            reference_count=0,
            output_count=1,
            prompt_extend=True,
            prompt_extend_mode="direct",
            enable_thinking=False,
        )
        self.assertTrue(wan_async)
        self.assertEqual(wan_reason, "模型固定异步")
        with self.assertRaisesRegex(ValueError, "总像素"):
            qwen._resolve_size("256*256", "qwen-image-3.0-pro")
        with self.assertRaisesRegex(ValueError, "宽高比"):
            qwen._resolve_size("4096*256", "qwen-image-3.0")


if __name__ == "__main__":
    unittest.main()

"""
DashScopeImageBackend — 阿里云 DashScope 文生图（万象/Wan 系列 + Qwen + Z-image）

模型族与 API 差异：

  wanx2.1-*   旧 V2 API（异步任务模式）
    endpoint : /services/aigc/text2image/image-synthesis
    input    : {"prompt": "..."}
    response : output.task_id → 轮询 /tasks/{task_id} 获取结果

  wan2.6/2.7  新多模态 API（同步模式）
    endpoint : /services/aigc/multimodal-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image (直接返回)

  qwen-image-3.0 / qwen-image-3.0-pro  千问图像生成与编辑 3.0（自动同步/异步）
    sync     : /services/aigc/multimodal-generation/generation
    async    : /services/aigc/image-generation/generation
    input    : {"messages": [{"role":"user","content":[{image?},{text}]}]}
    response : 同步直接返回图片；异步返回 task_id 后轮询 /tasks/{task_id}

  z-image-turbo ZOUKE 图像生成（同步模式）
    endpoint : /services/aigc/multimodal-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image (直接返回)

所有 endpoint 均相对于 base_url（默认 https://dashscope.aliyuncs.com/api/v1）。
"""

import sys
import asyncio
import base64
from typing import Optional, Callable

import httpx

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, _exc_msg


class DashScopeImageBackend(ModelBackend):
    """
    配置字段说明：
      api_key   — DashScope API Key（必填）
      model     — 模型名，支持 Wan 与 qwen-image-3.0(-pro)
      base_url  — 可覆盖 API 根地址，默认 https://dashscope.aliyuncs.com/api/v1
      env:
        SIZE            — 图片尺寸，如 1024*1024；Qwen 3.0 留空时由模型推荐
        NEGATIVE_PROMPT — 反向提示词
        PROMPT_EXTEND   — "true"/"false"（默认 true）
        PROMPT_EXTEND_MODE — "direct"/"agent"（默认 direct；I2I 强制 direct）
        ENABLE_THINKING — "true"/"false"（默认 true，仅 Qwen 3.0）
        N               — 输出数量 1-6（默认 1）
        SEED            — 随机种子 0-2147483647（可选）
        WATERMARK       — "true"/"false"（默认 false）
        DASHSCOPE_WORKSPACE_ID — 业务空间 ID（可选）
        DASHSCOPE_REGION — cn-beijing / ap-southeast-1 / eu-central-1 /
                           ap-northeast-1（默认 cn-beijing）
        DASHSCOPE_CALL_MODE — auto / sync / async（默认 auto，仅 Qwen 3.0）
        DASHSCOPE_MAX_WAIT_SECONDS — 异步任务最长等待秒数（默认 3600，最大 7200）
    """

    _DEFAULT_BASE  = "https://dashscope.aliyuncs.com/api/v1"
    _DEFAULT_MODEL = "wanx2.1-t2i-turbo"
    _QWEN3_PREFIX = "qwen-image-3.0"
    _QWEN3_MAX_REFERENCE_IMAGES = 3
    _QWEN3_MAX_IMAGE_BYTES = 10 * 1024 * 1024
    _QWEN3_SYNC_ENDPOINT = "/services/aigc/multimodal-generation/generation"
    _QWEN3_ASYNC_ENDPOINT = "/services/aigc/image-generation/generation"
    _QWEN3_IMAGE_MIME_TYPES = {
        "image/jpeg", "image/png", "image/bmp", "image/tiff",
        "image/webp", "image/gif",
    }
    _DASHSCOPE_REGIONS = {
        "cn-beijing",
        "ap-southeast-1",
        "eu-central-1",
        "ap-northeast-1",
    }

    # 异步任务通过 deadline 控制，避免固定轮询次数把慢任务误判为失败。
    _DEFAULT_MAX_WAIT_SECONDS = 3600
    _MAX_WAIT_SECONDS = 7200
    _POLL_INTERVAL = 3.0
    _POLL_REQUEST_TIMEOUT = 30.0
    _PROGRESS_INTERVAL = 30.0
    _SYNC_REQUEST_TIMEOUT = 360.0

    # ── 比例 → 具体尺寸映射 ──────────────────────────────────────────
    _RATIO_MAP = {
        "1:1": "1024*1024",
        "16:9": "1280*720",
        "9:16": "720*1280",
        "4:3": "1024*768",
        "3:4": "768*1024",
        "3:2": "1152*768",
        "2:3": "768*1152",
        "21:9": "1344*576",
        "9:21": "576*1344",
    }

    @staticmethod
    def _parse_size_from_content(content: str) -> tuple[str, str]:
        """
        从 content 中解析尺寸指令，返回 (clean_prompt, size_or_empty)。

        支持格式（在 content 任意位置）：
          --size 16:9
          --size 1280*720
          --size 1280x720
        """
        import re
        m = re.search(r'--size\s+(\S+)', content)
        if m:
            size_str = m.group(1).strip()
            clean = content[:m.start()].rstrip() + " " + content[m.end():].lstrip()
            return clean.strip(), size_str
        return content, ""

    @classmethod
    def _is_qwen_image_3(cls, model: str) -> bool:
        return model.strip().lower().startswith(cls._QWEN3_PREFIX)

    def _resolve_base_url(self) -> str:
        """解析 API 根地址，并兼容用户误粘贴完整 generation Endpoint。"""
        explicit = (self.config.base_url or "").strip().rstrip("/")
        if explicit:
            marker = "/api/v1"
            marker_at = explicit.find(marker)
            if marker_at >= 0:
                return explicit[:marker_at + len(marker)]
            return explicit

        workspace_id = (self.get_env("DASHSCOPE_WORKSPACE_ID", "") or "").strip()
        if workspace_id:
            import re
            if not re.fullmatch(r"[A-Za-z0-9-]+", workspace_id):
                raise ValueError("DashScope Workspace ID 格式无效")
            region = (self.get_env("DASHSCOPE_REGION", "cn-beijing") or "cn-beijing").strip()
            if region not in self._DASHSCOPE_REGIONS:
                raise ValueError(f"不支持的 DashScope 地域：{region}")
            return f"https://{workspace_id}.{region}.maas.aliyuncs.com/api/v1"
        return self._DEFAULT_BASE

    def _resolve_size(self, size_str: str, model: str = "") -> str:
        """将比例或具体尺寸解析为 W*H；Qwen 3.0 空值表示自动推荐。"""
        configured = (self.get_env("SIZE", "") or "").strip()
        requested = (size_str or configured).strip()
        if not requested or requested.lower() == "auto":
            return "" if self._is_qwen_image_3(model) else "1024*1024"
        # 比例模式
        resolved = self._RATIO_MAP.get(requested)
        if resolved:
            requested = resolved
        # 具体尺寸 WxH / W*H / W×H
        import re
        m = re.fullmatch(r'(\d+)\s*[x×*]\s*(\d+)', requested, re.IGNORECASE)
        if not m:
            if self._is_qwen_image_3(model):
                raise ValueError(f"无法识别图片尺寸：{requested}")
            return "1024*1024"
        width, height = int(m.group(1)), int(m.group(2))
        if self._is_qwen_image_3(model):
            area = width * height
            if area < 512 * 512 or area > 2048 * 2048:
                raise ValueError("Qwen Image 3.0 输出总像素须在 512*512 至 2048*2048 之间")
            if max(width, height) / max(1, min(width, height)) > 8:
                raise ValueError("Qwen Image 3.0 输出宽高比须在 1:8 至 8:1 之间")
        return f"{width}*{height}"

    def _bounded_int_env(
        self,
        name: str,
        default: int,
        minimum: int,
        maximum: int,
        *,
        optional: bool = False,
    ) -> Optional[int]:
        raw = (self.get_env(name, "") or "").strip()
        if not raw:
            return None if optional else default
        try:
            value = int(raw)
        except ValueError as exc:
            raise ValueError(f"{name} 必须是整数") from exc
        if value < minimum or value > maximum:
            raise ValueError(f"{name} 必须在 {minimum}–{maximum} 之间")
        return value

    # key: 模型名前缀（lower），value: (endpoint_suffix, input_format, is_async)
    #   input_format: "prompt"   → input.prompt = "..."
    #                 "messages" → input.messages = [{role,content:[{text}]}]
    #   is_async: True → 使用异步任务模式（轮询 task_id）
    #              False → 同步模式（直接返回结果）
    _MODEL_ROUTES = [
        # 前缀匹配优先级：越长越精确，放前面
        # Qwen 的基础路由是同步；auto/async 模式会在提交前替换为 image-generation。
        # Wan 2.6/2.7 与 Z-image-turbo 继续使用 multimodal-generation 同步 API。
        ("z-image-turbo", "/services/aigc/multimodal-generation/generation", "messages", False),
        ("qwen-image",    "/services/aigc/multimodal-generation/generation", "messages", False),
        ("wan2.7",        "/services/aigc/multimodal-generation/generation", "messages", False),
        ("wan2.6",        "/services/aigc/multimodal-generation/generation", "messages", False),
        ("wanx",          "/services/aigc/text2image/image-synthesis",       "prompt",     True),
        # 未知 wan 模型默认走 multimodal-generation 同步路径
        ("wan",           "/services/aigc/multimodal-generation/generation", "messages", False),
    ]

    def _route(self, model: str) -> tuple[str, str, bool]:
        """返回 (endpoint_suffix, input_format, is_async)。"""
        ml = model.lower()
        for prefix, endpoint, fmt, is_async in self._MODEL_ROUTES:
            if ml.startswith(prefix):
                return endpoint, fmt, is_async
        # 完全未知 → 旧 text2image 端点，prompt 格式，异步模式
        return "/services/aigc/text2image/image-synthesis", "prompt", True

    def _call_mode(self) -> str:
        mode = (self.get_env("DASHSCOPE_CALL_MODE", "auto") or "auto").strip().lower()
        if mode not in {"auto", "sync", "async"}:
            raise ValueError("DASHSCOPE_CALL_MODE 只能是 auto、sync 或 async")
        return mode

    @staticmethod
    def _size_area(size: str) -> int:
        if not size or "*" not in size:
            return 0
        try:
            width, height = size.split("*", 1)
            return int(width) * int(height)
        except (TypeError, ValueError):
            return 0

    def _select_call_mode(
        self,
        model: str,
        *,
        route_is_async: bool,
        call_mode: str,
        prompt: str,
        size: str,
        reference_count: int,
        output_count: int,
        prompt_extend: bool,
        prompt_extend_mode: str,
        enable_thinking: bool,
    ) -> tuple[bool, str]:
        """在提交前选定调用方式，避免同步读超时后产生不安全的重复提交。"""
        if not self._is_qwen_image_3(model):
            return route_is_async, "模型固定异步" if route_is_async else "模型固定同步"
        if call_mode == "sync":
            return False, "手动指定同步"
        if call_mode == "async":
            return True, "手动指定异步"

        reasons: list[str] = []
        if model.strip().lower().endswith("-pro"):
            reasons.append("Pro 模型")
        if reference_count:
            reasons.append(f"{reference_count} 张参考图")
        if output_count > 1:
            reasons.append(f"输出 {output_count} 张")
        if self._size_area(size) > 1024 * 1024:
            reasons.append("高分辨率")
        if prompt_extend and enable_thinking:
            reasons.append("Thinking")
        if prompt_extend and prompt_extend_mode == "agent":
            reasons.append("Agent 改写")
        if len(prompt) >= 800:
            reasons.append("长提示词")

        if reasons:
            return True, "自动判定重任务：" + "、".join(reasons)
        return False, "自动判定轻任务"

    @staticmethod
    def _sync_not_supported(response: httpx.Response) -> bool:
        if response.status_code not in {400, 405}:
            return False
        body = (response.text or "").lower()
        return (
            "does not support synchronous" in body
            or "not support synchronous" in body
            or "不支持同步" in body
        )

    @staticmethod
    def _extract_image_urls(output: dict) -> list[str]:
        """从新旧响应结构中提取全部图片 URL，并保持服务端顺序。"""
        urls: list[str] = []
        seen: set[str] = set()

        def append(url: object) -> None:
            value = str(url or "").strip()
            if value and value not in seen:
                seen.add(value)
                urls.append(value)

        # 新 API：output.choices[].message.content[].image
        for choice in output.get("choices", []):
            for item in choice.get("message", {}).get("content", []):
                append(item.get("image") or item.get("url"))
        # 旧 API：output.results[].url
        for result in output.get("results", []):
            append(result.get("url"))
        return urls

    @classmethod
    def _extract_image_url(cls, output: dict) -> Optional[str]:
        """向后兼容：返回响应中的第一张图片。"""
        urls = cls._extract_image_urls(output)
        return urls[0] if urls else None

    def _reference_image_data_uri(self, image: ImageAttachment, *, strict: bool) -> str:
        """把附件转成 data URI；Qwen 3.0 场景同时执行格式与 10MB 校验。"""
        mime = str(image.mime_type or "image/png").split(";", 1)[0].strip().lower()
        if mime == "image/jpg":
            mime = "image/jpeg"
        if strict and mime not in self._QWEN3_IMAGE_MIME_TYPES:
            raise ValueError(
                f"Qwen Image 3.0 不支持参考图格式 {mime}；"
                "请使用 JPG、PNG、BMP、TIFF、WEBP 或 GIF"
            )

        img_b64 = str(image.base64 or "").strip()
        byte_size = int(image.size or 0)
        if not img_b64 and image.file_path:
            from pathlib import Path
            image_path = Path(image.file_path)
            byte_size = image_path.stat().st_size
            img_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
        if not img_b64:
            raise ValueError("参考图内容为空，请重新粘贴或上传图片")
        if byte_size <= 0:
            # Base64 长度换算原始字节数；减去尾部 padding。
            byte_size = max(0, (len(img_b64) * 3 // 4) - img_b64[-2:].count("="))
        if strict and byte_size > self._QWEN3_MAX_IMAGE_BYTES:
            raise ValueError("Qwen Image 3.0 单张参考图不能超过 10MB")
        return f"data:{mime};base64,{img_b64}"

    @staticmethod
    async def _download_images(
        client: httpx.AsyncClient,
        image_urls: list[str],
    ) -> list[tuple[str, Optional[str], Optional[str]]]:
        """并行下载短期结果 URL，返回 (url, data_uri, error)。"""
        async def one(url: str) -> tuple[str, Optional[str], Optional[str]]:
            try:
                response = await client.get(url, timeout=60.0)
                if response.status_code != 200:
                    return url, None, f"HTTP {response.status_code}"
                mime = response.headers.get("content-type", "image/png").split(";", 1)[0]
                encoded = base64.b64encode(response.content).decode("ascii")
                return url, f"data:{mime};base64,{encoded}", None
            except Exception as exc:
                return url, None, _exc_msg(exc)

        return list(await asyncio.gather(*(one(url) for url in image_urls)))

    async def _emit_images(
        self,
        client: httpx.AsyncClient,
        image_urls: list[str],
        emit: Callable,
    ) -> None:
        for source_url, data_uri, error in await self._download_images(client, image_urls):
            if data_uri:
                emit("text_delta", text=f"![生成图像]({data_uri})\n\n")
                continue
            print(
                f"[DashScope] 图片下载失败，回退到原始链接: {source_url[:100]} ({error})",
                file=sys.stderr,
            )
            emit("text_delta", text=f"![生成图像]({source_url})\n\n")
            emit("text_delta", text=f"> 🔗 原始链接（24小时有效）：{source_url}\n")

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable] = None,
        constraints: Optional[str] = None,  # ★ Session-level constraints/rules/prompts
        sandbox_enabled: bool = True,  # ★ 沙盒开关（图像后端不涉及文件操作，忽略）
    ) -> dict:

        def emit(dtype: str, **kw):
            on_delta(StreamDelta(session_id, message_id, dtype, **kw))

        # ── 鉴权 ──────────────────────────────────────────────────────────
        api_key = self.config.api_key or self.get_env("DASHSCOPE_API_KEY") or ""
        if not api_key:
            emit("error", error="DashScope API Key 未配置，请在 Backend 设置中填写 api_key")
            emit("done")
            return {}

        model = (self.config.model or self._DEFAULT_MODEL).strip()
        is_qwen3 = self._is_qwen_image_3(model)

        # ── 提示词 + 参数解析 ──────────────────────────────────────────
        # ★ 注入约束到提示词中
        final_prompt_content = content.strip()
        if not final_prompt_content:
            emit("error", error="提示词为空，请输入图像描述")
            emit("done")
            return {}

        # 如果有约束，将约束前置到提示词前面
        raw_content = final_prompt_content
        if constraints:
            raw_content = f"{constraints}\n\n{content.strip()}"

        prompt, size_arg = self._parse_size_from_content(raw_content)
        if not prompt:
            prompt = raw_content  # fallback

        # ── 参数 ──────────────────────────────────────────────────────────
        try:
            base = self._resolve_base_url().rstrip("/")
            size = self._resolve_size(size_arg, model)
            negative_prompt = (self.get_env("NEGATIVE_PROMPT", "") or "").strip()
            prompt_extend = (self.get_env("PROMPT_EXTEND", "true") or "true").lower() != "false"
            prompt_extend_mode = (self.get_env("PROMPT_EXTEND_MODE", "direct") or "direct").strip().lower()
            if prompt_extend_mode not in {"direct", "agent"}:
                raise ValueError("PROMPT_EXTEND_MODE 只能是 direct 或 agent")
            enable_thinking = (self.get_env("ENABLE_THINKING", "true") or "true").lower() != "false"
            watermark = (self.get_env("WATERMARK", "false") or "false").lower() == "true"
            output_count = self._bounded_int_env("N", 1, 1, 6) or 1
            seed = self._bounded_int_env("SEED", 0, 0, 2147483647, optional=True)
            call_mode = self._call_mode()
            max_wait_seconds = self._bounded_int_env(
                "DASHSCOPE_MAX_WAIT_SECONDS",
                self._DEFAULT_MAX_WAIT_SECONDS,
                60,
                self._MAX_WAIT_SECONDS,
            ) or self._DEFAULT_MAX_WAIT_SECONDS
        except ValueError as exc:
            emit("error", error=str(exc))
            emit("done")
            return {}

        if is_qwen3 and images and len(images) > self._QWEN3_MAX_REFERENCE_IMAGES:
            emit("error", error="Qwen Image 3.0 图像编辑最多支持 3 张参考图")
            emit("done")
            return {}

        # ── 路由：根据模型名选择端点和 input 格式 ─────────────────────────
        endpoint_suffix, input_fmt, route_is_async = self._route(model)

        if input_fmt == "prompt":
            input_body: dict = {"prompt": prompt}
            if negative_prompt:
                input_body["negative_prompt"] = negative_prompt
        else:  # "messages"
            # ★ 构建 content blocks：支持参考图（图生图 / image-to-image）
            content_blocks: list[dict] = []
            if images:
                try:
                    for img in images:
                        content_blocks.append({
                            "image": self._reference_image_data_uri(img, strict=is_qwen3),
                        })
                except (OSError, ValueError) as exc:
                    emit("error", error=f"参考图无效：{exc}")
                    emit("done")
                    return {}
            content_blocks.append({"text": prompt})
            input_body = {
                "messages": [
                    {"role": "user", "content": content_blocks}
                ]
            }

        parameters: dict = {
            "n": output_count,
            "prompt_extend": prompt_extend,
            "watermark": watermark,
        }
        if size:
            parameters["size"] = size
        if negative_prompt and input_fmt != "prompt":
            parameters["negative_prompt"] = negative_prompt
        effective_extend_mode = prompt_extend_mode
        if is_qwen3:
            # Agent 提示词增强不支持 I2I；存在参考图时确定性降级为 direct，避免 400。
            effective_extend_mode = "direct" if images and prompt_extend_mode == "agent" else prompt_extend_mode
            if prompt_extend:
                parameters["prompt_extend_mode"] = effective_extend_mode
                parameters["enable_thinking"] = enable_thinking
            if seed is not None:
                parameters["seed"] = seed

        payload = {"model": model, "input": input_body, "parameters": parameters}

        ref_count = len(images) if images else 0
        is_async, call_reason = self._select_call_mode(
            model,
            route_is_async=route_is_async,
            call_mode=call_mode,
            prompt=prompt,
            size=size,
            reference_count=ref_count,
            output_count=output_count,
            prompt_extend=prompt_extend,
            prompt_extend_mode=effective_extend_mode,
            enable_thinking=enable_thinking,
        )

        def endpoint_for(async_mode: bool) -> str:
            if is_qwen3:
                suffix = self._QWEN3_ASYNC_ENDPOINT if async_mode else self._QWEN3_SYNC_ENDPOINT
            else:
                suffix = endpoint_suffix
            return f"{base}{suffix}"

        def headers_for(async_mode: bool) -> dict[str, str]:
            value = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            if async_mode:
                value["X-DashScope-Async"] = "enable"
            return value

        endpoint = endpoint_for(is_async)
        headers = headers_for(is_async)
        print(f"[DashScope] POST {endpoint}  model={model}  fmt={input_fmt}  async={is_async}"
              f"  mode={call_mode}  reason={call_reason}  size={size or 'auto'}"
              f"  n={output_count}  ref_images={ref_count}",
              file=sys.stderr, flush=True)

        try:
            async with httpx.AsyncClient(timeout=self._SYNC_REQUEST_TIMEOUT) as client:

                # ── Step 1: 提交任务 ───────────────────────────────────────
                emit("text_delta", text="🎨 正在提交图像生成任务…\n")
                emit(
                    "text_delta",
                    text=(
                        f"  模型：`{model}`  尺寸：{size or '自动推荐'}\n"
                        f"  调用：{'异步' if is_async else '同步'}（{call_reason}）\n\n"
                    ),
                )

                try:
                    resp = await client.post(
                        endpoint,
                        headers=headers,
                        json=payload,
                        timeout=60.0 if is_async else self._SYNC_REQUEST_TIMEOUT,
                    )
                except httpx.ConnectError:
                    # ConnectError 明确发生在连接建立阶段，请求尚未提交，可以安全改投异步。
                    if not (is_qwen3 and call_mode == "auto" and not is_async):
                        raise
                    is_async = True
                    endpoint = endpoint_for(True)
                    headers = headers_for(True)
                    emit("text_delta", text="  同步端点连接失败（尚未提交），安全切换为异步…\n")
                    resp = await client.post(endpoint, headers=headers, json=payload, timeout=60.0)

                # 服务明确拒绝同步时不存在已运行的同步任务，auto 模式可安全切换。
                if (
                    not is_async
                    and is_qwen3
                    and call_mode == "auto"
                    and self._sync_not_supported(resp)
                ):
                    is_async = True
                    endpoint = endpoint_for(True)
                    headers = headers_for(True)
                    emit("text_delta", text="  当前账号不支持同步调用，自动切换为异步…\n")
                    resp = await client.post(endpoint, headers=headers, json=payload, timeout=60.0)

                if resp.status_code != 200:
                    body = resp.text[:400]
                    emit("error", error=f"提交任务失败 HTTP {resp.status_code}:\n```\n{body}\n```")
                    emit("done")
                    return {}

                data = resp.json()

                # ── 同步模式：直接从响应中提取图片 ─────────────────────────────
                if not is_async:
                    image_urls = self._extract_image_urls(data.get("output", {}))
                    if not image_urls:
                        emit("error", error=f"生成成功但未找到图片 URL，响应：{data}")
                        emit("done")
                        return {}

                    emit("text_delta", text="✅ 生成完成，正在下载图片…\n\n")
                    await self._emit_images(client, image_urls, emit)

                    # 尝试从 usage 中获取 token 信息
                    usage_info = data.get("usage", {})
                    image_count = (
                        usage_info.get("output_image_count")
                        or usage_info.get("image_count")
                        or len(image_urls)
                    )
                    emit("done", usage={"inputTokens": 0, "outputTokens": image_count})
                    return {}

                # ── 异步模式：轮询任务结果 ───────────────────────────────────
                task_id = data.get("output", {}).get("task_id")
                if not task_id:
                    emit("error", error=f"未获得 task_id，响应：{data}")
                    emit("done")
                    return {}

                emit(
                    "text_delta",
                    text=(
                        f"⏳ 异步任务已提交，等待生成…\n"
                        f"  task_id：`{task_id}`  最长等待：{max_wait_seconds}s\n"
                    ),
                )

                poll_url     = f"{base}/tasks/{task_id}"
                poll_headers = {"Authorization": f"Bearer {api_key}"}

                loop = asyncio.get_running_loop()
                started_at = loop.time()
                deadline = started_at + max_wait_seconds
                last_progress_at = started_at
                last_status = ""
                last_poll_error = ""

                while loop.time() < deadline:
                    if self.is_cancelled(session_id):
                        emit("done")
                        return {}

                    remaining = deadline - loop.time()
                    await asyncio.sleep(min(self._POLL_INTERVAL, max(0.0, remaining)))

                    try:
                        poll = await client.get(
                            poll_url,
                            headers=poll_headers,
                            timeout=self._POLL_REQUEST_TIMEOUT,
                        )
                    except httpx.RequestError as exc:
                        # 查询是幂等操作，短暂断网可以安全重试到 deadline。
                        last_poll_error = _exc_msg(exc)
                        poll = None

                    if poll is None:
                        now = loop.time()
                        if now - last_progress_at >= self._PROGRESS_INTERVAL:
                            elapsed = int(now - started_at)
                            emit("text_delta", text=f"  …已等待 {elapsed}s（查询重试：{last_poll_error}）\n")
                            last_progress_at = now
                        continue

                    if poll.status_code != 200:
                        # 鉴权/参数错误不会自行恢复；限流与服务错误继续等待。
                        if 400 <= poll.status_code < 500 and poll.status_code != 429:
                            emit(
                                "error",
                                error=(
                                    f"查询异步任务失败 HTTP {poll.status_code}: "
                                    f"{poll.text[:300]}（task_id: {task_id}）"
                                ),
                            )
                            emit("done")
                            return {}
                        continue

                    pdata  = poll.json()
                    output = pdata.get("output", {})
                    status = str(output.get("task_status", "") or "").upper()

                    if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                        err = output.get("message") or output.get("code") or "Unknown error"
                        emit("error", error=f"图像生成未完成（{status}）：{err}（task_id: {task_id}）")
                        emit("done")
                        return {}

                    if status == "SUCCEEDED":
                        image_urls = self._extract_image_urls(output)
                        if not image_urls:
                            emit("error", error=f"生成成功但未找到图片 URL，响应：{output}")
                            emit("done")
                            return {}

                        emit("text_delta", text="✅ 生成完成，正在下载图片…\n\n")
                        await self._emit_images(client, image_urls, emit)

                        usage_info  = pdata.get("usage", {})
                        image_count = (
                            usage_info.get("output_image_count")
                            or usage_info.get("image_count")
                            or len(image_urls)
                        )
                        emit("done", usage={"inputTokens": 0, "outputTokens": image_count})
                        return {}

                    now = loop.time()
                    if status and status != last_status:
                        elapsed = int(now - started_at)
                        emit("text_delta", text=f"  状态：{status}（已等待 {elapsed}s）\n")
                        last_status = status
                        last_progress_at = now
                    elif now - last_progress_at >= self._PROGRESS_INTERVAL:
                        elapsed = int(now - started_at)
                        emit("text_delta", text=f"  …已等待 {elapsed}s（{status or 'PENDING'}）\n")
                        last_progress_at = now

                suffix = f"；最近查询错误：{last_poll_error}" if last_poll_error else ""
                emit(
                    "error",
                    error=(
                        f"本地等待已达到 {max_wait_seconds}s，任务未被重复提交；"
                        f"task_id: {task_id}{suffix}。任务结果仅保留 24 小时。"
                    ),
                )
                emit("done")
                return {}

        except httpx.TimeoutException as e:
            if not self.is_cancelled(session_id):
                phase = "异步任务提交" if is_async else "同步生成请求"
                print(f"[DashScope] {phase}超时，未自动重发：{_exc_msg(e)}", file=sys.stderr)
                emit(
                    "error",
                    error=(
                        f"{phase}响应超时（{_exc_msg(e)}）。请求可能已被服务端受理；"
                        "为避免重复生成和计费，系统没有自动重发。"
                    ),
                )
                emit("done")
            return {}
        except Exception as e:
            if not self.is_cancelled(session_id):
                import traceback; traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}

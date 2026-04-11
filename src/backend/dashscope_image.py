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

  qwen-image  通义千问文生图（同步模式）
    endpoint : /services/aigc/multimodal-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image (直接返回)

  z-image-turbo ZOUKE 图像生成（同步模式）
    endpoint : /services/aigc/multimodal-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image (直接返回)

所有 endpoint 均相对于 base_url（默认 https://dashscope.aliyuncs.com/api/v1）。
"""

import sys
import asyncio
import base64
from typing import Optional, Callable, Awaitable

import httpx

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, _exc_msg


class DashScopeImageBackend(ModelBackend):
    """
    配置字段说明：
      api_key   — DashScope API Key（必填）
      model     — 模型名，默认 wanx2.1-t2i-turbo
      base_url  — 可覆盖 API 根地址，默认 https://dashscope.aliyuncs.com/api/v1
      env:
        SIZE            — 图片尺寸，如 1024*1024（默认）
        NEGATIVE_PROMPT — 反向提示词
        PROMPT_EXTEND   — "true"/"false"（默认 true）
        WATERMARK       — "true"/"false"（默认 false）
    """

    _DEFAULT_BASE  = "https://dashscope.aliyuncs.com/api/v1"
    _DEFAULT_MODEL = "wanx2.1-t2i-turbo"

    # 最大轮询次数（仅用于异步模式）
    _MAX_POLLS = 120
    _POLL_INTERVAL = 3.0

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

    def _resolve_size(self, size_str: str) -> str:
        """将比例或具体尺寸字符串解析为 DashScope 格式 W*H。"""
        if not size_str:
            return self.config.get_env("SIZE", "1024*1024")
        # 比例模式
        resolved = self._RATIO_MAP.get(size_str)
        if resolved:
            return resolved
        # 具体尺寸 WxH / W*H / W×H
        import re
        m = re.match(r'(\d+)\s*[x×*]\s*(\d+)', size_str, re.IGNORECASE)
        if m:
            return f"{m.group(1)}*{m.group(2)}"
        # 无法解析，回退到配置默认值
        return self.config.get_env("SIZE", "1024*1024")
    # key: 模型名前缀（lower），value: (endpoint_suffix, input_format, is_async)
    #   input_format: "prompt"   → input.prompt = "..."
    #                 "messages" → input.messages = [{role,content:[{text}]}]
    #   is_async: True → 使用异步任务模式（轮询 task_id）
    #              False → 同步模式（直接返回结果）
    _MODEL_ROUTES = [
        # 前缀匹配优先级：越长越精确，放前面
        # Wan 2.6/2.7、Qwen Image 和 Z-image-turbo 都使用 multimodal-generation 同步 API
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

    @staticmethod
    def _extract_image_url(output: dict) -> Optional[str]:
        """从不同格式的响应中提取图片 URL。"""
        # 新 API：output.choices[].message.content[].image
        for choice in output.get("choices", []):
            for item in choice.get("message", {}).get("content", []):
                if url := item.get("image") or item.get("url"):
                    return url
        # 旧 API：output.results[].url
        for result in output.get("results", []):
            if url := result.get("url"):
                return url
        return None

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
    ) -> dict:

        def emit(dtype: str, **kw):
            on_delta(StreamDelta(session_id, message_id, dtype, **kw))

        # ── 鉴权 ──────────────────────────────────────────────────────────
        api_key = self.config.api_key or self.config.get_env("DASHSCOPE_API_KEY") or ""
        if not api_key:
            emit("error", error="DashScope API Key 未配置，请在 Backend 设置中填写 api_key")
            emit("done")
            return {}

        base  = (self.config.base_url or self._DEFAULT_BASE).rstrip("/")
        model = (self.config.model or self._DEFAULT_MODEL).strip()

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
        size            = self._resolve_size(size_arg)
        negative_prompt = self.config.get_env("NEGATIVE_PROMPT", "")
        prompt_extend   = self.config.get_env("PROMPT_EXTEND", "true").lower() != "false"
        watermark       = self.config.get_env("WATERMARK",       "false").lower() == "true"

        # ── 路由：根据模型名选择端点和 input 格式 ─────────────────────────
        endpoint_suffix, input_fmt, is_async = self._route(model)
        endpoint = f"{base}{endpoint_suffix}"

        # 同步模式不需要异步头
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type":  "application/json",
        }
        if is_async:
            headers["X-DashScope-Async"] = "enable"

        if input_fmt == "prompt":
            input_body: dict = {"prompt": prompt}
            if negative_prompt:
                input_body["negative_prompt"] = negative_prompt
        else:  # "messages"
            # ★ 构建 content blocks：支持参考图（图生图 / image-to-image）
            content_blocks: list[dict] = []
            if images:
                for img in images:
                    img_b64 = img.base64
                    if not img_b64 and img.file_path:
                        import base64 as _b64
                        try:
                            with open(img.file_path, "rb") as f:
                                img_b64 = _b64.b64encode(f.read()).decode("ascii")
                        except Exception:
                            pass
                    if img_b64:
                        # DashScope 接受 data URI 或纯 URL
                        content_blocks.append({"image": f"data:{img.mime_type};base64,{img_b64}"})
            content_blocks.append({"text": prompt})
            input_body = {
                "messages": [
                    {"role": "user", "content": content_blocks}
                ]
            }

        parameters: dict = {
            "size": size,
            "n": 1,
            "prompt_extend": prompt_extend,
            "watermark": watermark,
        }
        if negative_prompt and input_fmt != "prompt":
            parameters["negative_prompt"] = negative_prompt

        payload = {"model": model, "input": input_body, "parameters": parameters}

        # 异步模式需要 X-DashScope-Async 头
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type":  "application/json",
        }
        if is_async:
            headers["X-DashScope-Async"] = "enable"

        _ref_count = len(images) if images else 0
        print(f"[DashScope] POST {endpoint}  model={model}  fmt={input_fmt}  async={is_async}"
              f"  size={size}  ref_images={_ref_count}",
              file=sys.stderr, flush=True)

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:

                # ── Step 1: 提交任务 ───────────────────────────────────────
                emit("text_delta", text=f"🎨 正在提交图像生成任务…\n")
                emit("text_delta", text=f"  模型：`{model}`  尺寸：{size}\n\n")

                resp = await client.post(endpoint, headers=headers, json=payload)
                if resp.status_code != 200:
                    body = resp.text[:400]
                    emit("error", error=f"提交任务失败 HTTP {resp.status_code}:\n```\n{body}\n```")
                    emit("done")
                    return {}

                data = resp.json()

                # ── 同步模式：直接从响应中提取图片 ─────────────────────────────
                if not is_async:
                    img_url = self._extract_image_url(data.get("output", {}))
                    if not img_url:
                        emit("error", error=f"生成成功但未找到图片 URL，响应：{data}")
                        emit("done")
                        return {}

                    emit("text_delta", text="✅ 生成完成，正在下载图片…\n\n")

                    # 下载图片 → base64 → markdown 嵌入
                    try:
                        img_resp = await client.get(img_url, timeout=60.0)
                        if img_resp.status_code == 200:
                            mime = img_resp.headers.get("content-type", "image/png").split(";")[0]
                            b64  = base64.b64encode(img_resp.content).decode()
                            emit("text_delta", text=f"![生成图像](data:{mime};base64,{b64})\n\n")
                        else:
                            emit("text_delta", text=f"![生成图像]({img_url})\n\n")
                            emit("text_delta", text=f"> 🔗 原始链接（24小时有效）：{img_url}\n")
                    except Exception as _dl_err:
                        print(f"[DashScope] 图片下载失败，回退到原始链接: {_dl_err}", file=sys.stderr)
                        emit("text_delta", text=f"![生成图像]({img_url})\n\n")

                    # 尝试从 usage 中获取 token 信息
                    usage_info = data.get("usage", {})
                    image_count = usage_info.get("image_count", 1)
                    emit("done", usage={"inputTokens": 0, "outputTokens": image_count})
                    return {}

                # ── 异步模式：轮询任务结果 ───────────────────────────────────
                task_id = data.get("output", {}).get("task_id")
                if not task_id:
                    emit("error", error=f"未获得 task_id，响应：{data}")
                    emit("done")
                    return {}

                emit("text_delta", text=f"⏳ 任务已提交，等待生成…\n")

                poll_url     = f"{base}/tasks/{task_id}"
                poll_headers = {"Authorization": f"Bearer {api_key}"}

                for i in range(120):
                    if self.is_cancelled(session_id):
                        emit("done")
                        return {}

                    await asyncio.sleep(3.0)

                    poll = await client.get(poll_url, headers=poll_headers, timeout=15.0)
                    if poll.status_code != 200:
                        continue  # 短暂网络波动，继续重试

                    pdata  = poll.json()
                    output = pdata.get("output", {})
                    status = output.get("task_status", "")

                    if status == "FAILED":
                        err = output.get("message") or output.get("code") or "Unknown error"
                        emit("error", error=f"图像生成失败：{err}")
                        emit("done")
                        return {}

                    if status == "SUCCEEDED":
                        img_url = self._extract_image_url(output)
                        if not img_url:
                            emit("error", error=f"生成成功但未找到图片 URL，响应：{output}")
                            emit("done")
                            return {}

                        emit("text_delta", text="✅ 生成完成，正在下载图片…\n\n")

                        # ── Step 3: 下载 → base64 → markdown 嵌入 ─────────
                        try:
                            img_resp = await client.get(img_url, timeout=60.0)
                            if img_resp.status_code == 200:
                                mime = img_resp.headers.get("content-type", "image/png").split(";")[0]
                                b64  = base64.b64encode(img_resp.content).decode()
                                emit("text_delta", text=f"![生成图像](data:{mime};base64,{b64})\n\n")
                            else:
                                # 下载失败，给原始链接（24h 有效）
                                emit("text_delta", text=f"![生成图像]({img_url})\n\n")
                                emit("text_delta", text=f"> 🔗 原始链接（24小时有效）：{img_url}\n")
                        except Exception as _dl_err:
                            print(f"[DashScope] 图片下载失败，回退到原始链接: {_dl_err}", file=sys.stderr)
                            emit("text_delta", text=f"![生成图像]({img_url})\n\n")

                        usage_info  = pdata.get("usage", {})
                        image_count = usage_info.get("image_count", 1)
                        emit("done", usage={"inputTokens": 0, "outputTokens": image_count})
                        return {}

                    # 每 5 次轮询显示一次进度
                    if i % 5 == 4:
                        elapsed = int((i + 1) * self._POLL_INTERVAL)
                        emit("text_delta", text=f"  …已等待 {elapsed}s（{status}）\n")

                emit("error", error=f"图像生成超时（>360s），task_id: {task_id}")
                emit("done")
                return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                import traceback; traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}

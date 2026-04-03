"""
DashScopeImageBackend — 阿里云 DashScope 文生图（万象/Wan 系列）

模型族与 API 差异（均使用异步任务模式）：

  wanx2.1-*   旧 V2 API
    endpoint : /services/aigc/text2image/image-synthesis
    input    : {"prompt": "..."}
    response : output.results[].url

  wan2.6-*    新多模态 API（image-generation）
    endpoint : /services/aigc/image-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image

  wan2.7-*    新多模态 API（multimodal-generation）
    endpoint : /services/aigc/multimodal-generation/generation
    input    : {"messages": [{"role":"user","content":[{"text":"..."}]}]}
    response : output.choices[].message.content[].image

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
    _POLL_INTERVAL = 3.0    # 秒
    _MAX_POLLS     = 120    # 最多等 6 分钟

    # ── 模型族路由表 ─────────────────────────────────────────────────────────
    # key: 模型名前缀（lower），value: (endpoint_suffix, input_format)
    #   input_format: "prompt"   → input.prompt = "..."
    #                 "messages" → input.messages = [{role,content:[{text}]}]
    _MODEL_ROUTES = [
        # 前缀匹配优先级：越长越精确，放前面
        ("wan2.7",  "/services/aigc/multimodal-generation/generation", "messages"),
        ("wan2.6",  "/services/aigc/image-generation/generation",      "messages"),
        ("wanx",    "/services/aigc/text2image/image-synthesis",       "prompt"),
        # 未知新模型默认走 image-generation 路径（messages 格式）
        ("wan",     "/services/aigc/image-generation/generation",      "messages"),
    ]

    def _route(self, model: str) -> tuple[str, str]:
        """返回 (endpoint_suffix, input_format)。"""
        ml = model.lower()
        for prefix, endpoint, fmt in self._MODEL_ROUTES:
            if ml.startswith(prefix):
                return endpoint, fmt
        # 完全未知 → 旧 text2image 端点，prompt 格式
        return "/services/aigc/text2image/image-synthesis", "prompt"

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

        # ── 提示词 ────────────────────────────────────────────────────────
        prompt = content.strip()
        if not prompt:
            for m in reversed(messages):
                if m.role == "user" and m.content:
                    prompt = m.content.strip()
                    break
        if not prompt:
            emit("error", error="提示词为空，请输入图像描述")
            emit("done")
            return {}

        # ── 参数 ──────────────────────────────────────────────────────────
        size            = self.config.get_env("SIZE", "1024*1024")
        negative_prompt = self.config.get_env("NEGATIVE_PROMPT", "")
        prompt_extend   = self.config.get_env("PROMPT_EXTEND", "true").lower() != "false"
        watermark       = self.config.get_env("WATERMARK",       "false").lower() == "true"

        # ── 路由：根据模型名选择端点和 input 格式 ─────────────────────────
        endpoint_suffix, input_fmt = self._route(model)
        endpoint = f"{base}{endpoint_suffix}"

        if input_fmt == "prompt":
            input_body: dict = {"prompt": prompt}
            if negative_prompt:
                input_body["negative_prompt"] = negative_prompt
        else:  # "messages"
            input_body = {
                "messages": [
                    {"role": "user", "content": [{"text": prompt}]}
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

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type":  "application/json",
            "X-DashScope-Async": "enable",
        }

        print(f"[DashScope] POST {endpoint}  model={model}  fmt={input_fmt}", file=sys.stderr, flush=True)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:

                # ── Step 1: 提交任务 ───────────────────────────────────────
                emit("text_delta", text=f"🎨 正在提交图像生成任务…\n")
                emit("text_delta", text=f"  模型：`{model}`  尺寸：{size}\n\n")

                resp = await client.post(endpoint, headers=headers, json=payload)
                if resp.status_code != 200:
                    body = resp.text[:400]
                    emit("error", error=f"提交任务失败 HTTP {resp.status_code}:\n```\n{body}\n```")
                    emit("done")
                    return {}

                data    = resp.json()
                task_id = data.get("output", {}).get("task_id")
                if not task_id:
                    emit("error", error=f"未获得 task_id，响应：{data}")
                    emit("done")
                    return {}

                emit("text_delta", text=f"⏳ 任务已提交，等待生成…\n")

                # ── Step 2: 轮询任务结果 ───────────────────────────────────
                poll_url     = f"{base}/tasks/{task_id}"
                poll_headers = {"Authorization": f"Bearer {api_key}"}

                for i in range(self._MAX_POLLS):
                    if self.is_cancelled(session_id):
                        emit("done")
                        return {}

                    await asyncio.sleep(self._POLL_INTERVAL)

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
                        img_resp = await client.get(img_url, timeout=60.0)
                        if img_resp.status_code == 200:
                            mime = img_resp.headers.get("content-type", "image/png").split(";")[0]
                            b64  = base64.b64encode(img_resp.content).decode()
                            emit("text_delta", text=f"![生成图像](data:{mime};base64,{b64})\n\n")
                        else:
                            # 下载失败，给原始链接（24h 有效）
                            emit("text_delta", text=f"![生成图像]({img_url})\n\n")
                            emit("text_delta", text=f"> 🔗 原始链接（24小时有效）：{img_url}\n")

                        usage_info  = pdata.get("usage", {})
                        image_count = usage_info.get("image_count", 1)
                        emit("done", usage={"inputTokens": 0, "outputTokens": image_count})
                        return {}

                    # 每 5 次轮询显示一次进度
                    if i % 5 == 4:
                        elapsed = int((i + 1) * self._POLL_INTERVAL)
                        emit("text_delta", text=f"  …已等待 {elapsed}s（{status}）\n")

                emit("error", error=f"图像生成超时（>{int(self._MAX_POLLS * self._POLL_INTERVAL)}s），task_id: {task_id}")
                emit("done")
                return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                import traceback; traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}

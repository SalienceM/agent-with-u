"""
WebSearchBackend — Bing 网页搜索（爬取，免费，国内可用）

使用 cn.bing.com 搜索，解析 HTML 提取搜索结果。
无需 API Key，无费用。
"""

import re
import sys
from typing import Optional, Callable, Awaitable

import httpx

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, _exc_msg


class WebSearchBackend(ModelBackend):
    """
    配置字段说明：
      base_url  — 可覆盖搜索域名，默认 https://cn.bing.com
      env:
        MAX_RESULTS — 最大返回条数，默认 8
    """

    _DEFAULT_BASE = "https://cn.bing.com"
    _HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    @staticmethod
    def _parse_bing_results(html: str, max_results: int = 8) -> list[dict]:
        """从 Bing HTML 中提取搜索结果。"""
        results: list[dict] = []
        # Bing 搜索结果块：<li class="b_algo">
        blocks = re.findall(r'<li class="b_algo">(.*?)</li>', html, re.DOTALL)
        for block in blocks[:max_results]:
            # 标题 + URL
            title_m = re.search(r'<h2><a[^>]*href="([^"]*)"[^>]*>(.*?)</a></h2>', block, re.DOTALL)
            if not title_m:
                continue
            url = title_m.group(1)
            title = re.sub(r'<[^>]+>', '', title_m.group(2)).strip()
            # 摘要
            snippet = ""
            snippet_m = re.search(r'<p class="[^"]*">(.*?)</p>', block, re.DOTALL)
            if not snippet_m:
                snippet_m = re.search(r'<div class="b_caption">\s*<p>(.*?)</p>', block, re.DOTALL)
            if snippet_m:
                snippet = re.sub(r'<[^>]+>', '', snippet_m.group(1)).strip()
            if title:
                results.append({"title": title, "url": url, "snippet": snippet})
        return results

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

        query = content.strip()
        if not query:
            emit("error", error="搜索关键词为空")
            emit("done")
            return {}

        base = (self.config.base_url or self._DEFAULT_BASE).rstrip("/")
        max_results = int(self.config.get_env("MAX_RESULTS", "8"))

        print(f"[WebSearch] Bing search: q={query!r}, base={base}",
              file=sys.stderr, flush=True)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{base}/search",
                    params={"q": query, "count": str(max_results)},
                    headers=self._HEADERS,
                    follow_redirects=True,
                )
                if resp.status_code != 200:
                    emit("error", error=f"Bing 搜索失败: HTTP {resp.status_code}")
                    emit("done")
                    return {}

                results = self._parse_bing_results(resp.text, max_results)

            if not results:
                emit("text_delta", text="未找到相关搜索结果。\n")
            else:
                for i, r in enumerate(results, 1):
                    line = f"{i}. **{r['title']}**\n"
                    if r['snippet']:
                        line += f"   {r['snippet']}\n"
                    line += f"   🔗 {r['url']}\n\n"
                    emit("text_delta", text=line)

            emit("done")
            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}

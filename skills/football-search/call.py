#!/usr/bin/env python3
"""
football-search skill — call.py
搜索天下足球网视频资源。

stdin:  JSON { query, category?, limit? }
stdout: JSON { ok, results: [...], error? }
env:    SKILL_SECRETS = JSON { USERNAME, PASSWORD }
"""

import json
import os
import sys
import time
from typing import Optional

# ── 读取输入 & 凭据 ────────────────────────────────────────────────────────
try:
    payload: dict = json.loads(sys.stdin.read())
except Exception as e:
    print(json.dumps({"ok": False, "error": f"stdin parse error: {e}"}))
    sys.exit(0)

try:
    secrets: dict = json.loads(os.environ.get("SKILL_SECRETS", "{}"))
except Exception:
    secrets = {}

USERNAME: str = secrets.get("USERNAME", "")
PASSWORD: str = secrets.get("PASSWORD", "")
query: str = payload.get("query", "").strip()
category: Optional[str] = payload.get("category")
limit: int = min(int(payload.get("limit", 10)), 50)

if not query:
    print(json.dumps({"ok": False, "error": "query 不能为空"}))
    sys.exit(0)

if not USERNAME or not PASSWORD:
    print(json.dumps({"ok": False, "error": "未配置天下足球网凭据，请在 Skill 管理器中点击 🔑 配置用户名和密码"}))
    sys.exit(0)

# ── 登录 & 搜索 ─────────────────────────────────────────────────────────────
try:
    import httpx
except ImportError:
    print(json.dumps({"ok": False, "error": "缺少 httpx 依赖，请运行: pip install httpx"}))
    sys.exit(0)

LOGIN_URL  = "https://www.txzqw.me/user/login"
SEARCH_URL = "https://www.txzqw.me/index.php/ajax/suggest"

CATEGORY_MAP = {
    "replay":    "录像",
    "highlight": "集锦",
    "live":      "直播",
}

def login(client: httpx.Client) -> bool:
    """登录并保持 session cookie。"""
    try:
        resp = client.post(
            LOGIN_URL,
            data={"username": USERNAME, "password": PASSWORD, "remember": "1"},
            follow_redirects=True,
            timeout=15,
        )
        # 登录成功通常会重定向到首页，检查 cookie 或响应
        return resp.status_code < 400
    except Exception as e:
        raise RuntimeError(f"登录失败: {e}")


def search(client: httpx.Client, kw: str, cat: Optional[str], n: int) -> list[dict]:
    """搜索并返回结果列表。"""
    params = {"mid": 1, "wd": kw}
    if cat and cat in CATEGORY_MAP:
        params["type"] = CATEGORY_MAP[cat]

    try:
        resp = client.get(SEARCH_URL, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"搜索请求失败 HTTP {e.response.status_code}")
    except Exception as e:
        raise RuntimeError(f"搜索请求异常: {e}")

    items: list = data if isinstance(data, list) else data.get("list", data.get("data", []))
    results = []
    for item in items[:n]:
        if isinstance(item, dict):
            results.append({
                "title":    item.get("title") or item.get("name", ""),
                "url":      item.get("url") or item.get("link", ""),
                "date":     item.get("date") or item.get("time", ""),
                "category": item.get("typeName") or item.get("type", ""),
                "cover":    item.get("pic") or item.get("cover", ""),
            })
        elif isinstance(item, str):
            results.append({"title": item, "url": "", "date": "", "category": "", "cover": ""})
    return results


# ── 主流程 ──────────────────────────────────────────────────────────────────
try:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.txzqw.me/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    with httpx.Client(headers=headers) as client:
        login(client)
        time.sleep(0.3)   # 礼貌等待，避免触发反爬
        results = search(client, query, category, limit)

    print(json.dumps({
        "ok": True,
        "query": query,
        "category": category,
        "count": len(results),
        "results": results,
    }, ensure_ascii=False))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}), ensure_ascii=False)

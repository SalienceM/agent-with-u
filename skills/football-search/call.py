#!/usr/bin/env python3
"""
football-search skill — call.py
搜索天下足球网视频资源（PHPWind 论坛，GBK 编码，HTML 响应）。

stdin:  JSON { query, limit? }
stdout: JSON { ok, results: [...], error? }
env:    SKILL_SECRETS = JSON { USERNAME, PASSWORD }

依赖: pip install httpx beautifulsoup4
"""

import json
import os
import re
import sys
from typing import Optional

# ── 读取输入 & 凭据 ──────────────────────────────────────────────────────────
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
limit: int = min(int(payload.get("limit", 10)), 50)

if not query:
    print(json.dumps({"ok": False, "error": "query 不能为空"}))
    sys.exit(0)

if not USERNAME or not PASSWORD:
    print(json.dumps({"ok": False, "error": "未配置凭据，请点击 🔑 配置用户名和密码"}))
    sys.exit(0)

try:
    import httpx
    from bs4 import BeautifulSoup
except ImportError as e:
    print(json.dumps({"ok": False, "error": f"缺少依赖: {e}。请运行: pip install httpx beautifulsoup4"}))
    sys.exit(0)

BASE = "https://www.txzqw.me"

# ── 中文数字（验证问答用）────────────────────────────────────────────────────
_NUM_TO_CN = {0:"零",1:"一",2:"二",3:"三",4:"四",5:"五",6:"六",7:"七",8:"八",9:"九",10:"十"}

def _solve_captcha(question_text: str) -> str:
    """解算形如 '9-4=?' / '2X8=?' 的验证问答，返回中文答案如 '五'/'十六'。"""
    m = re.search(r'(\d+)\s*([+\-×÷*xX])\s*(\d+)', question_text)
    if not m:
        return "五"
    a, op, b = int(m.group(1)), m.group(2).upper(), int(m.group(3))
    result = {"+": a+b, "-": a-b, "×": a*b, "X": a*b, "÷": a//b if b else 0, "*": a*b}.get(op, 0)
    # 构造中文数字（支持 0-99）
    if result in _NUM_TO_CN:
        return _NUM_TO_CN[result]
    if 11 <= result <= 19:
        return "十" + _NUM_TO_CN[result - 10]
    if result == 20:
        return "二十"
    if 21 <= result <= 29:
        return "二十" + _NUM_TO_CN[result - 20]
    return str(result)


# ── 登录 ─────────────────────────────────────────────────────────────────────
def login(client: httpx.Client) -> bool:
    """
    登录流程：
    1. GET /login.php 获取动态验证问答（qkey + 问题文本）
    2. POST /login.php? 提交账号密码及验证答案
    返回是否登录成功。
    """
    # Step 1: 获取登录页面，提取验证问答
    resp = client.get(f"{BASE}/login.php", timeout=15)
    resp.raise_for_status()
    html = resp.content.decode("gbk", errors="replace")

    # 提取 qkey（隐藏字段）
    qkey_m = re.search(r'name="qkey"\s+value="(\d+)"', html)
    qkey = qkey_m.group(1) if qkey_m else "9"

    # 提取问题文本，如 "问题：9-4=？"
    q_m = re.search(r'问题[：:]\s*([^\n，,<]+)', html)
    q_text = q_m.group(1).strip() if q_m else f"{qkey}-4"
    captcha_answer = _solve_captcha(q_text)

    print(f"[debug] qkey={qkey!r} q_text={q_text!r} answer={captcha_answer!r}", file=sys.stderr)
    print(f"[debug] username={USERNAME!r} password={'*'*len(PASSWORD) if PASSWORD else '(empty)'}", file=sys.stderr)

    # Step 2: 提交登录表单
    data = {
        "step":     "2",
        "lgt":      "0",
        "pwuser":   USERNAME,
        "pwpwd":    PASSWORD,
        "question": "0",
        "answer":   "",
        "qanswer":  captcha_answer,
        "qkey":     qkey,
        "hideid":   "0",
        "forward":  "",
        "jumpurl":  f"{BASE}/",
        "cktime":   "31536000",
    }
    print(f"[debug] submitting form data: {data}", file=sys.stderr)
    resp = client.post(f"{BASE}/login.php?", data=data, follow_redirects=True, timeout=15)
    html_after = resp.content.decode("gbk", errors="replace")
    print(f"[debug] login response url={resp.url} status={resp.status_code}", file=sys.stderr)
    print(f"[debug] cookies={dict(client.cookies)}", file=sys.stderr)
    # 提取页面提示信息
    msg_m = re.search(r'<ol>(.*?)</ol>', html_after, re.S)
    if msg_m:
        print(f"[debug] page msg: {BeautifulSoup(msg_m.group(1), 'html.parser').get_text(strip=True)}", file=sys.stderr)

    # 判断登录成功：页面出现"退出"链接，或 cookie 中有 winduser
    logged_in = "退出" in html_after or any("winduser" in k for k in dict(client.cookies))
    if not logged_in:
        # 尝试提取错误信息
        err_m = re.search(r'提示信息[^<]*</td>.*?<ol>(.*?)</ol>', html_after, re.S)
        if err_m:
            raise RuntimeError(f"登录失败: {BeautifulSoup(err_m.group(1), 'html.parser').get_text(strip=True)}")
        raise RuntimeError("登录失败，请检查用户名和密码")
    return True


# ── 搜索 ─────────────────────────────────────────────────────────────────────
def search(client: httpx.Client, kw: str, n: int) -> list[dict]:
    """
    POST 到 search.php，解析返回的 HTML 搜索结果。
    结果以 .tr3 行呈现，含标题链接和时间。
    """
    data = {
        "step":     "2",
        "keyword":  kw,
        "method":   "AND",
        "sch_area": "0",
        "f_fid":    "all",
        "sch_time": "all",
        "orderway": "lastpost",
        "asc":      "DESC",
    }
    resp = client.post(f"{BASE}/search.php?", data=data, timeout=20)
    resp.raise_for_status()
    html = resp.content.decode("gbk", errors="replace")

    # 检查是否被拒（未登录）
    if "用户组权限" in html or "不能使用搜索" in html:
        raise RuntimeError("搜索权限不足，登录可能已过期")

    soup = BeautifulSoup(html, "html.parser")
    results = []

    # PHPWind 搜索结果在 .tr3 行中
    for row in soup.select("tr.tr3, .z .tr3"):
        link = row.find("a", href=True)
        if not link:
            continue
        title = link.get_text(strip=True)
        if not title:
            continue
        href = link["href"]
        if not href.startswith("http"):
            href = BASE + "/" + href.lstrip("/")

        # 时间（通常在最后一个 td）
        tds = row.find_all("td")
        date = tds[-1].get_text(strip=True) if tds else ""

        results.append({"title": title, "url": href, "date": date})
        if len(results) >= n:
            break

    return results


# ── 主流程 ───────────────────────────────────────────────────────────────────
try:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": BASE,
    }
    with httpx.Client(headers=headers, follow_redirects=True) as client:
        login(client)
        results = search(client, query, limit)

    print(json.dumps({
        "ok": True,
        "query": query,
        "count": len(results),
        "results": results,
    }, ensure_ascii=False))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))

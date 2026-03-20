"""
test_agent_auth.py - 官方账户 Agent 接入探针

目标：弄清楚 Claude.ai 官方账户能走通哪种本地 agent 交互方式。

【重要结论 - 403 分析】
  如果你遇到 "API Error: 403 Request not allowed"，原因是：
  ANTHROPIC_AUTH_TOKEN 不是手动复制的 API Key，而是需要通过
  `claude login` OAuth 流程产生。登录后 credentials 存储在本地，
  CLI 自动读取，不需要设置环境变量。

  正确操作：先运行 `claude login` 完成登录，再运行本脚本。

运行方式：
  python test_agent_auth.py [test_number]
  # test_number 1~7，不传则依次全部运行

测试方案：
  6. 使用已登录凭证（不传 token，依赖 claude login 存储的凭证）★ 应先运行这个
  7. 读取本地凭证文件（诊断 claude login 状态）
  1. claude CLI + stream-json + AUTH_TOKEN env
  2. claude CLI + text 模式 + AUTH_TOKEN env
  3. claude_agent_sdk 默认（含 AUTH_TOKEN）
  4. claude_agent_sdk + cli_path
  5. 诊断：claude 版本 / 环境
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

# ─────────────────────────────────────────────────────────────
# ★ 配置区：按需修改
# ─────────────────────────────────────────────────────────────

# 代理地址（★ 关键）：claude 需要代理才能访问 api.anthropic.com
# 示例：http://127.0.0.1:7890（Clash）、http://127.0.0.1:10809（v2rayN）
# 留空 = 不注入代理 env，依赖系统代理（TUN 模式）或直连
PROXY = "http://127.0.0.1:7890"

# AUTH_TOKEN：如果你已通过 claude login 登录，留空即可
# 只有当你想测试 env 变量方式时才填入
AUTH_TOKEN = ""

# 可选：Anthropic API Key（sk-ant-api03-xxx 格式）
API_KEY = ""

# claude CLI 路径（留空则自动查找）
CLI_PATH = ""

# 测试工作目录
WORK_DIR = os.path.expanduser("~/")

# 简单测试提示
TEST_PROMPT = "请回复：测试成功。只需一行。"

# ─────────────────────────────────────────────────────────────

def _resolve_cli() -> str:
    if CLI_PATH:
        return CLI_PATH
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        for name in ("claude.cmd", "claude.exe", "claude"):
            p = os.path.join(appdata, "npm", name)
            if os.path.exists(p):
                return p
    return "claude"


def _make_env(use_auth_token: bool = True, use_api_key: bool = False,
              clean: bool = False, with_proxy: bool = False) -> dict:
    """构建子进程环境变量。
    clean=True：不注入任何 token（依赖已登录凭证）
    with_proxy=True：注入 PROXY 配置里的代理变量
    """
    env = os.environ.copy()
    if clean:
        for k in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
            env.pop(k, None)
    else:
        if use_auth_token and AUTH_TOKEN:
            env["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
            env["ANTHROPIC_API_KEY"] = AUTH_TOKEN
        if use_api_key and API_KEY:
            env["ANTHROPIC_API_KEY"] = API_KEY
    if with_proxy and PROXY:
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            env[k] = PROXY
    return env


def _run_cli(cmd: list[str], env: dict, timeout: int = 60) -> tuple[int, str, str]:
    """运行 CLI。
    Windows: 二进制读取 + utf-8 手动 decode（避免 GBK 崩溃）+ CREATE_NO_WINDOW（不弹黑窗口）
    """
    popen_kwargs: dict = dict(
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=WORK_DIR,
        bufsize=0,
    )
    if sys.platform == "win32":
        # 不指定 encoding → 二进制模式，手动 decode utf-8
        popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        popen_kwargs["encoding"] = "utf-8"
        popen_kwargs["errors"] = "replace"

    try:
        proc = subprocess.Popen(cmd, **popen_kwargs)
        try:
            stdout_b, stderr_b = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout_b, stderr_b = proc.communicate()

        def _dec(b) -> str:
            if isinstance(b, bytes):
                return b.decode("utf-8", errors="replace")
            return b or ""

        return proc.returncode, _dec(stdout_b), _dec(stderr_b)
    except FileNotFoundError:
        return -1, "", f"FileNotFoundError: {cmd[0]} not found"
    except Exception as e:
        return -1, "", str(e)


def _sep(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ─────────────────────────────────────────────────────────────
# 测试 7：读取本地凭证文件
# ─────────────────────────────────────────────────────────────

def test7_read_credentials():
    _sep("TEST 7 - 读取本地 claude login 凭证")

    # Windows: %APPDATA%\Claude\  / Linux/Mac: ~/.claude/
    candidates = []
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        candidates += [
            Path(appdata) / "Claude",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Claude",
        ]
    home = Path.home()
    candidates += [
        home / ".claude",
        home / ".config" / "claude",
    ]

    found_dir = None
    for d in candidates:
        if d.exists():
            found_dir = d
            print(f"找到凭证目录: {d}")
            for f in sorted(d.iterdir()):
                size = f.stat().st_size if f.is_file() else 0
                print(f"  {f.name}  ({size} bytes)")
            break

    if not found_dir:
        print("!! 未找到 claude 凭证目录，请先运行: claude login")
        return False

    # 尝试读取凭证文件
    for fname in ("credentials.json", "auth.json", ".credentials.json",
                  "config.json", "settings.json"):
        cred_file = found_dir / fname
        if cred_file.exists():
            try:
                text = cred_file.read_text(encoding="utf-8", errors="replace")
                try:
                    data = json.loads(text)
                    # 脱敏显示
                    def _mask(v):
                        if isinstance(v, str) and len(v) > 8:
                            return v[:6] + "..." + v[-4:]
                        return v
                    masked = {k: _mask(v) if isinstance(v, str) else v
                              for k, v in data.items()}
                    print(f"\n{fname}（脱敏）: {json.dumps(masked, ensure_ascii=False, indent=2)[:600]}")
                except json.JSONDecodeError:
                    print(f"{fname}: {text[:200]}")
            except Exception as e:
                print(f"{fname} 读取失败: {e}")

    return True


# ─────────────────────────────────────────────────────────────
# 测试 6：使用已登录凭证（不注入 token env）★ 最重要的测试
# ─────────────────────────────────────────────────────────────

def _run_claude_stream(env: dict, label: str) -> bool:
    """运行 claude stream-json，打印结果，返回是否成功。"""
    cli = _resolve_cli()
    cmd = [
        cli,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "-p", TEST_PROMPT,
    ]
    proxy_in_env = env.get("HTTPS_PROXY") or env.get("https_proxy") or "无"
    auth_in_env = env.get("ANTHROPIC_AUTH_TOKEN", "")
    print(f"\n[{label}]")
    print(f"  proxy in env: {proxy_in_env}")
    print(f"  AUTH_TOKEN in env: {'yes('+str(len(auth_in_env))+'chars)' if auth_in_env else 'NO（依赖本地凭证）'}")
    print(f"  等待（最多 60 秒）...")

    rc, stdout, stderr = _run_cli(cmd, env, timeout=60)
    print(f"  returncode: {rc}")

    success = False
    text_output = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            t = obj.get("type", "?")
            print(f"    [JSON] type={t!r}", end="")
            if t == "assistant":
                for block in obj.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        txt = block["text"][:80]
                        text_output.append(txt)
                        print(f" text={txt!r}", end="")
            elif t == "result":
                is_err = obj.get("is_error", True)
                print(f" is_error={is_err}", end="")
                if not is_err:
                    success = True
            print()
        except json.JSONDecodeError:
            print(f"    [RAW] {line[:100]}")

    if stderr.strip():
        print(f"  stderr: {stderr[:300]}")
    if text_output:
        print(f"  AI 回复: {''.join(text_output)[:200]}")
    print(f"  结果: {'✅ 成功' if success else '❌ 失败'}")
    return success


def test6_logged_in_credentials():
    _sep("TEST 6 - claude login 凭证（两轮：无代理 / 有代理）★")
    print("目的：排查 403 是代理问题还是账号权限问题")

    # 轮次 A：不注入代理 env（依赖系统 TUN/全局代理，或直连）
    env_no_proxy = _make_env(clean=True, with_proxy=False)
    ok_a = _run_claude_stream(env_no_proxy, "轮次A: 不注入代理 env")

    if ok_a:
        print("\n✅ 系统代理/直连已可用，无需在 env 里设置代理")
        return True

    # 轮次 B：显式注入代理 env
    if PROXY:
        env_with_proxy = _make_env(clean=True, with_proxy=True)
        ok_b = _run_claude_stream(env_with_proxy, f"轮次B: 注入 PROXY={PROXY}")
        if ok_b:
            print(f"\n✅ 需要在子进程 env 里显式设置代理：{PROXY}")
            print("   → ClaudeCodeOfficialBackend 后端配置 env 字段填入:")
            print(f'   {{"HTTPS_PROXY": "{PROXY}", "HTTP_PROXY": "{PROXY}"}}')
            return True
        print(f"\n❌ 注入代理后仍然失败")
        print("   → 这是账号权限问题，不是代理问题")
        print("   → 检查：Claude.ai 账号是否有 Claude Code 访问权限")
        print("   → 需要 Claude Pro 或 Max 订阅才能使用 claude CLI API")
    else:
        print("\n⚠️  PROXY 未配置，跳过代理轮次")
        print("   → 如果轮次A失败，请在文件顶部设置 PROXY='http://127.0.0.1:7890'")

    return False


# ─────────────────────────────────────────────────────────────
# 测试 5：诊断环境
# ─────────────────────────────────────────────────────────────

def test5_diagnose():
    _sep("TEST 5 - 诊断：claude 版本 / 登录状态")
    cli = _resolve_cli()
    print(f"CLI 路径: {cli}")

    rc, stdout, stderr = _run_cli([cli, "--version"], _make_env(clean=True), timeout=15)
    print(f"claude --version: {stdout.strip() or stderr.strip()[:100]!r}  (rc={rc})")

    if rc == -1:
        print("!! claude CLI 未找到，请先安装：npm install -g @anthropic-ai/claude-code")
        return False

    # 尝试 claude config list（新版 CLI 支持）
    rc2, out2, err2 = _run_cli([cli, "config", "list"], _make_env(clean=True), timeout=15)
    if rc2 == 0:
        print(f"\nclaude config list:\n{out2[:400]}")
    else:
        print(f"\nclaude config list 不支持 (rc={rc2}): {err2[:100]}")

    return True


# ─────────────────────────────────────────────────────────────
# 测试 1：claude CLI + stream-json + AUTH_TOKEN
# ─────────────────────────────────────────────────────────────

def test1_cli_stream_json():
    _sep("TEST 1 - claude CLI + stream-json + AUTH_TOKEN env")
    if not AUTH_TOKEN:
        print("跳过：AUTH_TOKEN 未设置（留空表示依赖 claude login，见 Test 6）")
        return None
    cli = _resolve_cli()
    cmd = [cli, "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions", "-p", TEST_PROMPT]
    env = _make_env(use_auth_token=True)
    print(f"ANTHROPIC_AUTH_TOKEN: {AUTH_TOKEN[:6]}...{AUTH_TOKEN[-4:]} ({len(AUTH_TOKEN)} chars)")

    rc, stdout, stderr = _run_cli(cmd, env, timeout=60)
    print(f"returncode: {rc}")
    success = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            t = obj.get("type", "?")
            print(f"  [JSON] type={t!r}", end="")
            if t == "assistant":
                for block in obj.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        print(f" text={block['text'][:80]!r}", end="")
            elif t == "result":
                is_err = obj.get("is_error", True)
                print(f" is_error={is_err}", end="")
                if not is_err:
                    success = True
            print()
        except json.JSONDecodeError:
            print(f"  [RAW] {line[:120]}")
    if stderr.strip():
        print(f"stderr: {stderr[:300]}")
    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 测试 2：claude CLI + text 模式
# ─────────────────────────────────────────────────────────────

def test2_cli_print():
    _sep("TEST 2 - claude CLI + text 模式")
    if not AUTH_TOKEN:
        print("跳过：AUTH_TOKEN 未设置")
        return None
    cli = _resolve_cli()
    cmd = [cli, "--output-format", "text", "--dangerously-skip-permissions",
           "-p", TEST_PROMPT]
    rc, stdout, stderr = _run_cli(cmd, _make_env(use_auth_token=True), timeout=60)
    print(f"returncode: {rc}")
    print(f"stdout: {stdout[:400]}")
    if stderr.strip():
        print(f"stderr: {stderr[:200]}")
    success = rc == 0 and bool(stdout.strip())
    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 测试 3：claude_agent_sdk 默认
# ─────────────────────────────────────────────────────────────

async def test3_sdk_default():
    _sep("TEST 3 - claude_agent_sdk.query（含 AUTH_TOKEN）")
    try:
        from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
    except ImportError:
        print("!! claude-agent-sdk 未安装: pip install claude-agent-sdk")
        return False

    env_dict: dict = {}
    if AUTH_TOKEN:
        env_dict["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
        env_dict["ANTHROPIC_API_KEY"] = AUTH_TOKEN

    options = ClaudeAgentOptions(
        allowed_tools=["Read"],
        cwd=WORK_DIR,
        env=env_dict or None,
        permission_mode="bypassPermissions",
        include_partial_messages=True,
    )
    print(f"env_dict: {list(env_dict.keys()) if env_dict else '空（依赖 claude login）'}")

    success = False
    try:
        async for message in sdk_query(prompt=TEST_PROMPT, options=options):
            cls = type(message).__name__
            msg_type = getattr(message, "type", cls)
            print(f"  [MSG] {msg_type}")
            if msg_type in ("result", "ResultMessage"):
                is_error = getattr(message, "is_error", True)
                print(f"    is_error={is_error}")
                if not is_error:
                    success = True
            elif msg_type in ("assistant", "AssistantMessage"):
                for block in getattr(message, "content", []):
                    if getattr(block, "type", "") == "text":
                        print(f"    text={getattr(block, 'text', '')[:80]!r}")
    except Exception as e:
        print(f"!! 异常: {e}")

    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 测试 4：claude_agent_sdk + cli_path 显式
# ─────────────────────────────────────────────────────────────

async def test4_sdk_explicit_cli():
    _sep("TEST 4 - claude_agent_sdk + cli_path")
    try:
        from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
    except ImportError:
        print("!! claude-agent-sdk 未安装")
        return False

    cli = _resolve_cli()
    print(f"cli_path={cli!r}")
    env_dict: dict = {}
    if AUTH_TOKEN:
        env_dict["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
        env_dict["ANTHROPIC_API_KEY"] = AUTH_TOKEN

    options_kwargs = dict(
        allowed_tools=["Read"],
        cwd=WORK_DIR,
        env=env_dict or None,
        permission_mode="bypassPermissions",
        include_partial_messages=True,
        cli_path=cli,
    )
    try:
        options = ClaudeAgentOptions(**options_kwargs)
    except TypeError:
        options_kwargs.pop("cli_path")
        options = ClaudeAgentOptions(**options_kwargs)
        print("  (SDK 不支持 cli_path，已忽略)")

    success = False
    try:
        async for message in sdk_query(prompt=TEST_PROMPT, options=options):
            cls = type(message).__name__
            msg_type = getattr(message, "type", cls)
            print(f"  [MSG] {msg_type}")
            if msg_type in ("result", "ResultMessage"):
                is_error = getattr(message, "is_error", True)
                print(f"    is_error={is_error}")
                if not is_error:
                    success = True
    except Exception as e:
        print(f"!! 异常: {e}")

    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────

async def main():
    run_all = len(sys.argv) < 2
    selected = int(sys.argv[1]) if not run_all else 0

    results: dict[int, Optional[bool]] = {}

    if run_all or selected == 7:
        results[7] = test7_read_credentials()

    if run_all or selected == 5:
        results[5] = test5_diagnose()

    if run_all or selected == 6:
        results[6] = test6_logged_in_credentials()

    if run_all or selected == 1:
        results[1] = test1_cli_stream_json()

    if run_all or selected == 2:
        results[2] = test2_cli_print()

    if run_all or selected == 3:
        results[3] = await test3_sdk_default()

    if run_all or selected == 4:
        results[4] = await test4_sdk_explicit_cli()

    if run_all:
        _sep("汇总")
        labels = {
            6: "CLI 已登录凭证（无 token env）★",
            7: "读取本地凭证文件",
            5: "诊断环境",
            1: "CLI stream-json + AUTH_TOKEN",
            2: "CLI text + AUTH_TOKEN",
            3: "SDK 默认",
            4: "SDK + cli_path",
        }
        for k in [6, 7, 5, 1, 2, 3, 4]:
            v = results.get(k)
            mark = "✅" if v else ("⏭️" if v is None else "❌")
            print(f"  {mark} Test {k}: {labels.get(k, '')}")
        print()
        ok = [k for k, v in results.items() if v]
        if 6 in ok:
            print("✅ 结论：claude login 路径可用！")
            print("   ClaudeCodeOfficialBackend 应该不注入 token env，")
            print("   直接调用 claude CLI，依赖 claude login 存储的凭证。")
        elif ok:
            print(f"可用方案: Test {ok}")
        else:
            print("所有方案均失败，请检查：")
            print("  1. 先运行 `claude login` 完成登录")
            print("  2. 然后重新运行 `python test_agent_auth.py 6` 验证")


if __name__ == "__main__":
    asyncio.run(main())

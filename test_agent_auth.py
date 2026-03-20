"""
test_agent_auth.py - 官方账户 Agent 接入探针

目标：弄清楚用 ANTHROPIC_AUTH_TOKEN（Claude.ai Pro/Max OAuth token）
能走通哪种本地 agent 交互方式。

★ 使用前必须填入真实 token：
  修改下方 AUTH_TOKEN = "..." 为你的实际账户 token。

运行方式：
  python test_agent_auth.py [test_number]
  # test_number 1~5，不传则依次全部运行

测试方案：
  1. claude CLI 子进程 + stream-json（最直接）
  2. claude CLI 子进程 + print 模式（最简单，不需要解析）
  3. claude_agent_sdk.query（SDK 默认路径，看报什么错）
  4. claude_agent_sdk + 显式传 API_KEY=AUTH_TOKEN（兼容层）
  5. 直接查 claude 版本 / login 状态（诊断环境）
"""

import asyncio
import json
import os
import subprocess
import sys
from typing import Optional

# ─────────────────────────────────────────────────────────────
# ★ 在这里填入你的 ANTHROPIC_AUTH_TOKEN
# ─────────────────────────────────────────────────────────────
AUTH_TOKEN = "sk-ant-REPLACE_WITH_YOUR_TOKEN"

# 可选：如果有 API Key 则填这里（用于对比测试）
API_KEY = ""

# claude CLI 路径（留空则自动查找）
CLI_PATH = ""

# 测试工作目录
WORK_DIR = os.path.expanduser("~/")

# 简单测试提示
TEST_PROMPT = "请回复：测试成功，当前时间是多少？只需一行即可。"

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


def _make_env(use_auth_token: bool = True, use_api_key: bool = False) -> dict:
    """构建子进程环境变量。"""
    env = os.environ.copy()
    if use_auth_token and AUTH_TOKEN:
        env["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
        # 部分 claude 版本会优先读 API_KEY，所以同时填入
        env["ANTHROPIC_API_KEY"] = AUTH_TOKEN
    if use_api_key and API_KEY:
        env["ANTHROPIC_API_KEY"] = API_KEY
    return env


def _sep(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ─────────────────────────────────────────────────────────────
# 测试 5：诊断环境
# ─────────────────────────────────────────────────────────────

def test5_diagnose():
    _sep("TEST 5 - 诊断：claude 版本 / 登录状态")
    cli = _resolve_cli()
    print(f"CLI 路径: {cli}")

    # claude --version
    try:
        result = subprocess.run(
            [cli, "--version"],
            capture_output=True, text=True, timeout=15
        )
        print(f"claude --version stdout: {result.stdout.strip()}")
        print(f"claude --version stderr: {result.stderr.strip()[:300]}")
        print(f"returncode: {result.returncode}")
    except FileNotFoundError:
        print(f"!! claude CLI 未找到，请先安装（npm install -g @anthropic-ai/claude-code）")
        return False
    except Exception as e:
        print(f"!! 运行失败: {e}")
        return False

    # claude doctor (新版 CLI 支持)
    try:
        result2 = subprocess.run(
            [cli, "doctor"],
            capture_output=True, text=True, timeout=15,
            env=_make_env()
        )
        print(f"\nclaude doctor stdout:\n{result2.stdout.strip()[:500]}")
        print(f"claude doctor stderr:\n{result2.stderr.strip()[:300]}")
    except Exception as e:
        print(f"claude doctor 不支持或报错: {e}")

    return True


# ─────────────────────────────────────────────────────────────
# 测试 1：claude CLI + stream-json（推荐方式）
# ─────────────────────────────────────────────────────────────

def test1_cli_stream_json():
    _sep("TEST 1 - claude CLI + --output-format stream-json")
    cli = _resolve_cli()
    cmd = [
        cli,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "-p", TEST_PROMPT,
    ]
    env = _make_env(use_auth_token=True)

    print(f"cmd: {' '.join(cmd)}")
    print(f"ANTHROPIC_AUTH_TOKEN: {'set('+str(len(env.get('ANTHROPIC_AUTH_TOKEN','')))+'chars)' if env.get('ANTHROPIC_AUTH_TOKEN') else 'NOT SET'}")
    print(f"ANTHROPIC_API_KEY: {'set' if env.get('ANTHROPIC_API_KEY') else 'NOT SET'}")
    print()

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=WORK_DIR,
            encoding="utf-8",
            errors="replace",
        )
        print(f"pid={proc.pid}，等待输出（最多 60 秒）...")
        try:
            stdout, stderr = proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            print("!! 超时 60 秒，已强制终止")

        print(f"returncode: {proc.returncode}")
        print(f"\n--- stdout ({len(stdout)} chars) ---")
        # 逐行解析 stream-json
        success = False
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                print(f"  [JSON] type={obj.get('type')!r}", end="")
                if obj.get("type") == "assistant":
                    for block in obj.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            print(f" text={block['text'][:80]!r}", end="")
                elif obj.get("type") == "result":
                    print(f" session_id={obj.get('session_id')!r} is_error={obj.get('is_error')}", end="")
                    if not obj.get("is_error"):
                        success = True
                print()
            except json.JSONDecodeError:
                print(f"  [RAW] {line[:120]}")

        print(f"\n--- stderr ({len(stderr)} chars) ---")
        print(stderr[:600])
        print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
        return success

    except FileNotFoundError:
        print(f"!! claude CLI 未找到: {cli}")
        return False
    except Exception as e:
        print(f"!! 异常: {e}")
        return False


# ─────────────────────────────────────────────────────────────
# 测试 2：claude CLI + print 模式（最简单）
# ─────────────────────────────────────────────────────────────

def test2_cli_print():
    _sep("TEST 2 - claude CLI + --output-format text（print 模式）")
    cli = _resolve_cli()
    cmd = [
        cli,
        "--output-format", "text",
        "--dangerously-skip-permissions",
        "-p", TEST_PROMPT,
    ]
    env = _make_env(use_auth_token=True)
    print(f"cmd: {' '.join(cmd)}")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=WORK_DIR,
            encoding="utf-8",
            errors="replace",
        )
        try:
            stdout, stderr = proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            print("!! 超时 60 秒，已强制终止")

        print(f"returncode: {proc.returncode}")
        print(f"stdout:\n{stdout[:800]}")
        print(f"stderr:\n{stderr[:400]}")
        success = proc.returncode == 0 and len(stdout.strip()) > 0
        print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
        return success
    except Exception as e:
        print(f"!! 异常: {e}")
        return False


# ─────────────────────────────────────────────────────────────
# 测试 3：claude_agent_sdk 默认（看报什么错）
# ─────────────────────────────────────────────────────────────

async def test3_sdk_default():
    _sep("TEST 3 - claude_agent_sdk.query（默认，不传 API_KEY）")
    try:
        from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
    except ImportError:
        print("!! claude-agent-sdk 未安装: pip install claude-agent-sdk")
        return False

    env_dict = {}
    if AUTH_TOKEN:
        env_dict["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
        env_dict["ANTHROPIC_API_KEY"] = AUTH_TOKEN

    options = ClaudeAgentOptions(
        allowed_tools=["Read"],
        cwd=WORK_DIR,
        env=env_dict,
        permission_mode="bypassPermissions",
        include_partial_messages=True,
    )

    print(f"env_dict keys: {list(env_dict.keys())}")
    print("开始调用 sdk_query...")

    success = False
    try:
        async for message in sdk_query(prompt=TEST_PROMPT, options=options):
            cls = type(message).__name__
            msg_type = getattr(message, "type", cls)
            print(f"  [MSG] type={msg_type!r} class={cls}")
            if msg_type == "result":
                is_error = getattr(message, "is_error", True)
                sid = getattr(message, "session_id", None)
                print(f"    session_id={sid!r} is_error={is_error}")
                if not is_error:
                    success = True
            elif msg_type == "assistant":
                for block in getattr(message, "content", []):
                    btype = getattr(block, "type", "")
                    if btype == "text":
                        print(f"    text={getattr(block, 'text', '')[:80]!r}")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"!! 异常: {e}")

    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 测试 4：claude_agent_sdk + cli_path 显式指定
# ─────────────────────────────────────────────────────────────

async def test4_sdk_explicit_cli():
    _sep("TEST 4 - claude_agent_sdk + cli_path 显式指定")
    try:
        from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
    except ImportError:
        print("!! claude-agent-sdk 未安装: pip install claude-agent-sdk")
        return False

    cli = _resolve_cli()
    print(f"使用 cli_path={cli!r}")

    env_dict = {}
    if AUTH_TOKEN:
        env_dict["ANTHROPIC_AUTH_TOKEN"] = AUTH_TOKEN
        env_dict["ANTHROPIC_API_KEY"] = AUTH_TOKEN

    # 构建 options，显式传入 cli_path
    options_kwargs = dict(
        allowed_tools=["Read"],
        cwd=WORK_DIR,
        env=env_dict,
        permission_mode="bypassPermissions",
        include_partial_messages=True,
    )
    # cli_path 参数在不同版本 SDK 可能名字不同，兼容处理
    for attr in ("cli_path", "claude_path", "binary_path"):
        try:
            options = ClaudeAgentOptions(**{**options_kwargs, attr: cli})
            print(f"ClaudeAgentOptions 接受了参数 {attr!r}")
            break
        except TypeError:
            print(f"  ClaudeAgentOptions 不支持参数 {attr!r}，跳过")
            options = None

    if options is None:
        options = ClaudeAgentOptions(**options_kwargs)
        print("使用不带 cli_path 的 options（SDK 版本不支持）")

    success = False
    try:
        async for message in sdk_query(prompt=TEST_PROMPT, options=options):
            cls = type(message).__name__
            msg_type = getattr(message, "type", cls)
            print(f"  [MSG] type={msg_type!r}")
            if msg_type == "result":
                is_error = getattr(message, "is_error", True)
                print(f"    is_error={is_error}")
                if not is_error:
                    success = True
            elif msg_type == "assistant":
                for block in getattr(message, "content", []):
                    if getattr(block, "type", "") == "text":
                        print(f"    text={getattr(block, 'text', '')[:80]!r}")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"!! 异常: {e}")

    print(f"\n结论: {'✅ 成功' if success else '❌ 失败'}")
    return success


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────

async def main():
    if AUTH_TOKEN == "sk-ant-REPLACE_WITH_YOUR_TOKEN":
        print("!!! 警告：请先在文件顶部填入真实的 ANTHROPIC_AUTH_TOKEN !!!")
        print("    AUTH_TOKEN = \"sk-ant-REPLACE_WITH_YOUR_TOKEN\"  ← 改这行")
        sys.exit(1)

    run_all = len(sys.argv) < 2
    selected = int(sys.argv[1]) if not run_all else 0

    results: dict[int, Optional[bool]] = {}

    if run_all or selected == 5:
        results[5] = test5_diagnose()

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
            1: "CLI stream-json",
            2: "CLI print",
            3: "SDK 默认",
            4: "SDK + cli_path",
            5: "诊断",
        }
        for k, v in sorted(results.items()):
            mark = "✅" if v else ("❌" if v is False else "⚠️")
            print(f"  {mark} Test {k}: {labels.get(k, '')}")
        print()
        ok = [k for k, v in results.items() if v]
        if ok:
            print(f"可用方案: Test {ok}")
            print("建议在 ClaudeCodeOfficialBackend 中使用对应方法。")
        else:
            print("所有方案均失败，请检查：")
            print("  1. AUTH_TOKEN 是否正确（从 claude.ai 复制）")
            print("  2. claude CLI 是否已安装并可访问网络")
            print("  3. claude CLI 版本是否支持 ANTHROPIC_AUTH_TOKEN")


if __name__ == "__main__":
    asyncio.run(main())

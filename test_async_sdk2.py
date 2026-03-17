import asyncio
import os
import sys
import subprocess

async def main():
    from claude_agent_sdk import query, ClaudeAgentOptions

    cli_path = r"C:\Users\Administrator\AppData\Roaming\npm\claude.cmd"

    # 测试 CLI
    print("[1] 测试 claude CLI...")
    r = subprocess.run(
        [cli_path, "-p", "say one word", "--output-format", "json"],
        capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace"
    )
    print(f"    rc={r.returncode}, out={r.stdout[:200]}")

    # 测试 SDK
    print("\n[2] 测试 SDK async for (带 30 秒超时)...")
    options = ClaudeAgentOptions(
        model=os.environ.get("ANTHROPIC_MODEL", "sonnet"),
        include_partial_messages=True,
        allowed_tools=["Read", "Bash"],
        cli_path=cli_path,  # ← 关键！
    )
    prompt = {"role": "user", "content": [{"type": "text", "text": "say one word"}]}

    result = query(prompt=prompt, options=options)

    try:
        first_msg = await asyncio.wait_for(result.__anext__(), timeout=30)
        print(f"    第一条消息: {type(first_msg).__name__}")
        print(f"    内容: {repr(first_msg)[:300]}")

        async for msg in result:
            print(f"    [{type(msg).__name__}] {repr(msg)[:200]}")

    except asyncio.TimeoutError:
        print("    [FAIL] 30秒超时")
    except StopAsyncIteration:
        print("    空的")
    except Exception as e:
        print(f"    [ERROR] {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
"""
独立测试：验证 claude_agent_sdk 在 asyncio 环境下能否正常工作
"""
import asyncio
import json
import os

async def main():
    print("=" * 60)
    print("测试开始")
    print("=" * 60)

    try:
        from claude_agent_sdk import query, ClaudeAgentOptions
        print("[OK] claude_agent_sdk 导入成功")
    except ImportError as e:
        print(f"[FAIL] 导入失败: {e}")
        return

    options = ClaudeAgentOptions(
        model=os.environ.get("ANTHROPIC_MODEL", "sonnet"),
        include_partial_messages=True,
        allowed_tools=["Read", "Bash"],
    )

    prompt = {"role": "user", "content": [{"type": "text", "text": "说一个字"}]}

    print(f"[INFO] 调用 query()...")
    result = query(prompt=prompt, options=options)
    print(f"[INFO] query() 返回类型: {type(result)}")
    print(f"[INFO] 有 __aiter__: {hasattr(result, '__aiter__')}")
    print(f"[INFO] 有 __iter__:  {hasattr(result, '__iter__')}")
    print(f"[INFO] 有 __next__:  {hasattr(result, '__next__')}")
    print(f"[INFO] 有 __anext__: {hasattr(result, '__anext__')}")

    # 尝试方式1: async for
    if hasattr(result, '__aiter__'):
        print("\n--- 使用 async for ---")
        try:
            async for msg in result:
                cls = type(msg).__name__
                print(f"  [{cls}] {repr(msg)[:200]}")
        except Exception as e:
            print(f"  [ERROR] async for 失败: {e}")

    # 尝试方式2: 同步 for (在线程里)
    elif hasattr(result, '__iter__'):
        print("\n--- 使用同步 for (run_in_executor) ---")
        messages = []

        def sync_collect():
            for msg in result:
                cls = type(msg).__name__
                print(f"  [线程内] [{cls}] {repr(msg)[:200]}")
                messages.append(msg)

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, sync_collect)
        print(f"  收到 {len(messages)} 条消息")

    else:
        # 也许 result 本身就是结果，不是迭代器
        print(f"\n--- result 不是迭代器 ---")
        print(f"  type: {type(result)}")
        print(f"  repr: {repr(result)[:500]}")
        # 试试 await
        if asyncio.iscoroutine(result):
            print("  是 coroutine，尝试 await...")
            actual = await result
            print(f"  await 结果类型: {type(actual)}")
            print(f"  repr: {repr(actual)[:500]}")

    print("\n" + "=" * 60)
    print("测试结束")
    print("=" * 60)

if __name__ == "__main__":
    asyncio.run(main())
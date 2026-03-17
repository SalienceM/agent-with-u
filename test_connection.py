"""Quick test: verify Claude Agent SDK connects to your API endpoint."""
import os
import asyncio

# Copy AUTH_TOKEN → API_KEY (same as main.py does)
if not os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("ANTHROPIC_AUTH_TOKEN"):
    os.environ["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_AUTH_TOKEN"]

print(f"BASE_URL: {os.environ.get('ANTHROPIC_BASE_URL', 'NOT SET')}")
print(f"MODEL:    {os.environ.get('ANTHROPIC_MODEL', 'NOT SET')}")
print(f"API_KEY:  {'SET' if os.environ.get('ANTHROPIC_API_KEY') else 'NOT SET'}")
print()

async def test():
    try:
        from claude_agent_sdk import query, ClaudeAgentOptions
        print("SDK imported OK. Sending test message...")

        options = ClaudeAgentOptions(
            model=os.environ.get("ANTHROPIC_MODEL", "sonnet"),
            max_turns=1,
        )

        async for msg in query(prompt="Say hello in one word", options=options):
            msg_type = getattr(msg, "type", "unknown")
            print(f"  [{msg_type}]", end=" ")

            if msg_type == "assistant":
                content = getattr(msg, "message", None)
                if content and hasattr(content, "content"):
                    for block in content.content:
                        if hasattr(block, "text"):
                            print(block.text)
            elif msg_type == "result":
                print(getattr(msg, "result", ""))
            elif msg_type == "system":
                print(getattr(msg, "subtype", ""))
            else:
                print(str(msg)[:200])

        print("\nSUCCESS - SDK is connected!")

    except Exception as e:
        print(f"\nFAILED: {type(e).__name__}: {e}")

asyncio.run(test())

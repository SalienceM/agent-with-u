"""Synthetic providers only: no model/network/user-data access."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock

from src.backend.provider_usage import ClaudeTurnUsage, RequestUsage, anthropic_counts, openai_counts, stream_usage_unsupported
from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.anthropic_api import AnthropicAPIBackend
from src.backend.claude_agent import ClaudeAgentBackend
from src.types import ModelBackendConfig, BackendType


class ProviderUsageTests(unittest.TestCase):
    def test_stream_usage_downgrade_requires_explicit_parameter_rejection(self):
        self.assertTrue(stream_usage_unsupported({"error": {"message": "Unrecognized request argument: stream_options"}}))
        self.assertFalse(stream_usage_unsupported({"error": {"message": "Rate limit; try again"}}))
        self.assertFalse(stream_usage_unsupported({"error": {"param": "model", "code": "unsupported_parameter"}}))

    def test_anthropic_cache_counts_are_exclusive_but_openai_cache_is_subset(self):
        raw = {"input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 80, "cache_creation_input_tokens": 20}
        self.assertEqual(anthropic_counts(raw)["inputTokens"], 110)
        self.assertEqual(anthropic_counts(SimpleNamespace(**raw))["inputTokens"], 110)
        value = openai_counts({"prompt_tokens": 110, "completion_tokens": 4,
                              "prompt_tokens_details": {"cached_tokens": 80},
                              "completion_tokens_details": {"reasoning_tokens": 2}})
        self.assertEqual((value["inputTokens"], value["cachedInputTokens"], value["reasoningOutputTokens"]), (110, 80, 2))
        self.assertIsNone(openai_counts({"prompt_tokens": -1, "completion_tokens": 4}))
        self.assertIsNone(anthropic_counts({"input_tokens": True}))

    def test_snapshots_merge_not_sum_and_unknown_last_request_invalidates_context(self):
        turn = RequestUsage("anthropic")
        turn.start()
        turn.observe({"input_tokens": 10, "output_tokens": 0, "cache_read_input_tokens": 80})
        turn.observe({"output_tokens": 4})
        turn.observe({"output_tokens": 6})
        self.assertEqual(turn.finish()["outputTokens"], 6)
        turn.start()
        value = turn.finish()
        self.assertNotIn("contextTokens", value)
        self.assertIn("usageWarning", value)
        self.assertEqual(value["inputTokens"], 90)

    def test_claude_dict_result_is_turn_total_and_subagents_do_not_replace_root_context(self):
        turn = ClaudeTurnUsage()
        turn.observe({"input_tokens": 10, "cache_read_input_tokens": 80}, model="root-model")
        turn.observe({"input_tokens": 500}, parent="tool", model="child-model")
        # Result already aggregates requests; never add assistant usage to it.
        value = turn.finish({"input_tokens": 30, "output_tokens": 15, "cache_read_input_tokens": 240},
                            {"root-model": {"contextWindow": 200000}}, "native")
        self.assertEqual(value["inputTokens"], 270)
        self.assertEqual(value["contextTokens"], 90)
        self.assertEqual(value["contextWindow"], 200000)
        self.assertEqual(value["contextId"], "native")

    def test_claude_result_only_does_not_claim_aggregate_is_context(self):
        value = ClaudeTurnUsage().finish({"input_tokens": 90000, "output_tokens": 20})
        self.assertNotIn("contextTokens", value)
        self.assertIsNone(ClaudeTurnUsage().finish(None))
        self.assertTrue(ClaudeTurnUsage().finish({"input_tokens": 0, "output_tokens": 0})["reported"])


class FakeResponse:
    status_code = 200

    def __init__(self, frames):
        self.frames = frames

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    async def aiter_lines(self):
        for frame in self.frames:
            yield "data: " + json.dumps(frame)
        yield "data: [DONE]"


class FakeClient:
    def __init__(self, rounds):
        self.rounds = iter(rounds)
        self.requests = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    def stream(self, _method, _url, *, json, headers):
        self.requests.append(dict(json))
        return FakeResponse(next(self.rounds))


async def noop_tool(_name, _args):
    return "synthetic result"


TOOLS = [{"name": "noop", "description": "fixture", "input_schema": {"type": "object"}}]


class ProviderAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_explicit_stream_usage_rejection_retries_once_without_it(self):
        class Rejected(FakeResponse):
            status_code = 400
            async def aread(self):
                return b'{"error":{"param":"stream_options","code":"unsupported_parameter"}}'
        client = FakeClient([])
        responses = iter([Rejected([]), FakeResponse([{"choices": [{"delta": {"content": "ok"}}]}])])
        def stream(_method, _url, *, json, headers):
            client.requests.append(dict(json))
            return next(responses)
        client.stream = stream
        backend = OpenAICompatibleBackend(ModelBackendConfig(id="fake", type=BackendType.OPENAI_COMPATIBLE,
            label="fixture", base_url="https://fixture.invalid/v1", model="fake"))
        deltas = []
        with patch("src.backend.openai_compat.httpx.AsyncClient", return_value=client), \
             patch("src.backend.openai_compat.asyncio.sleep", new=AsyncMock()), patch("src.backend.openai_compat.print"):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append)
        self.assertFalse([item for item in deltas if item.type == "error"])
        self.assertEqual(len(client.requests), 2)
        self.assertIn("stream_options", client.requests[0])
        self.assertNotIn("stream_options", client.requests[1])
        self.assertIsNone(next(item.usage for item in deltas if item.type == "done"))

    async def test_claude_sdk_dictionary_result_reaches_done_usage(self):
        async def query(**_kwargs):
            yield SimpleNamespace(type="assistant", content=[], usage={"input_tokens": 10, "cache_read_input_tokens": 90}, model="fake")
            yield SimpleNamespace(type="result", usage={"input_tokens": 30, "output_tokens": 20, "cache_read_input_tokens": 270},
                                  model_usage={"fake": {"contextWindow": 100000}}, session_id="native")
        sdk = SimpleNamespace(query=query, ClaudeAgentOptions=lambda **kwargs: SimpleNamespace(**kwargs))
        backend = ClaudeAgentBackend(ModelBackendConfig(id="fake", type=BackendType.CLAUDE_AGENT_SDK, label="fixture", model="fake"))
        deltas = []
        with patch.dict("sys.modules", {"claude_agent_sdk": sdk}), patch.object(backend, "get_env", return_value=None), \
             patch("src.backend.claude_agent.resolve_claude_cli", return_value="claude"), \
             patch("urllib.request.getproxies", return_value={}), patch("src.backend.claude_agent.print"):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append)
        self.assertFalse([item for item in deltas if item.type == "error"])
        value = next(item.usage for item in deltas if item.type == "done")
        self.assertEqual((value["inputTokens"], value["contextTokens"], value["contextWindow"]), (300, 100, 100000))

    async def test_openai_usage_only_tail_multiple_tool_rounds(self):
        raw1 = {"prompt_tokens": 90, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 80}}
        raw2 = {"prompt_tokens": 110, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 100}}
        client = FakeClient([
            [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t", "function": {"name": "noop", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]},
             {"choices": [], "usage": raw1}, {"choices": [], "usage": raw1}],
            [{"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]}, {"choices": [], "usage": raw2}],
        ])
        backend = OpenAICompatibleBackend(ModelBackendConfig(id="fake", type=BackendType.OPENAI_COMPATIBLE,
            label="fixture", base_url="https://fixture.invalid/v1", model="fake"))
        deltas = []
        with patch("src.backend.openai_compat.httpx.AsyncClient", return_value=client), patch("src.backend.openai_compat.print"):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append,
                                       extra_tools=TOOLS, on_tool_call=noop_tool)
        self.assertFalse([item for item in deltas if item.type == "error"])
        value = next(item.usage for item in deltas if item.type == "done")
        self.assertEqual((value["inputTokens"], value["outputTokens"], value["cachedInputTokens"]), (200, 30, 180))
        self.assertEqual((value["contextTokens"], value["requestCount"]), (110, 2))
        self.assertTrue(all(request["stream_options"] == {"include_usage": True} for request in client.requests))

    async def test_openai_missing_usage_stays_unknown(self):
        client = FakeClient([[{"choices": [{"delta": {"content": "done"}}]}]])
        backend = OpenAICompatibleBackend(ModelBackendConfig(id="fake", type=BackendType.OPENAI_COMPATIBLE,
            label="fixture", base_url="https://fixture.invalid/v1", model="fake"))
        deltas = []
        with patch("src.backend.openai_compat.httpx.AsyncClient", return_value=client), patch("src.backend.openai_compat.print"):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append)
        self.assertIsNone(next(item.usage for item in deltas if item.type == "done"))

    async def test_anthropic_proxy_sums_tool_rounds_and_merge_delta_usage(self):
        rounds = []
        for index in range(2):
            frames = [{"type": "message_start", "message": {"usage": {
                "input_tokens": 10 + index * 10, "output_tokens": 0,
                "cache_read_input_tokens": 80, "cache_creation_input_tokens": 10}}}]
            if index == 0:
                frames.append({"type": "content_block_start", "content_block": {"type": "tool_use", "id": "t", "name": "noop"}})
            frames.extend([{"type": "message_delta", "usage": {"output_tokens": 3}},
                           {"type": "message_delta", "delta": {"stop_reason": "tool_use" if index == 0 else "end_turn"}, "usage": {"output_tokens": 5}}])
            rounds.append(frames)
        client = FakeClient(rounds)
        backend = AnthropicAPIBackend(ModelBackendConfig(id="fake", type=BackendType.ANTHROPIC_API,
            label="fixture", base_url="https://fixture.invalid", model="fake"))
        deltas = []
        with patch("src.backend.anthropic_api.httpx.AsyncClient", return_value=client), \
             patch("src.backend.anthropic_api.print"), patch.object(backend, "get_env", return_value=None), \
             patch.dict("sys.modules", {"anthropic": SimpleNamespace()}):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append,
                                       extra_tools=TOOLS, on_tool_call=noop_tool)
        self.assertFalse([item for item in deltas if item.type == "error"])
        value = next(item.usage for item in deltas if item.type == "done")
        self.assertEqual((value["inputTokens"], value["outputTokens"], value["cachedInputTokens"]), (210, 10, 160))
        self.assertEqual((value["contextTokens"], value["requestCount"]), (110, 2))

    async def test_anthropic_sdk_object_usage_all_tool_rounds(self):
        def event(class_name, **fields):
            return type(class_name, (), fields)()

        class Stream:
            def __init__(self, index):
                self.index = index
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                pass
            async def __aiter__(self):
                yield event("RawMessageStartEvent", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=0, cache_read_input_tokens=90)))
                if self.index == 0:
                    yield event("RawContentBlockStartEvent", content_block=event("ToolUseBlock", id="t", name="noop"))
                yield event("RawMessageDeltaEvent", delta=SimpleNamespace(stop_reason="tool_use" if self.index == 0 else "end_turn"), usage=SimpleNamespace(output_tokens=5))

        indexes = iter(range(2))
        client = SimpleNamespace(messages=SimpleNamespace(stream=lambda **kwargs: Stream(next(indexes))))
        sdk = SimpleNamespace(AsyncAnthropic=lambda **kwargs: client, NOT_GIVEN=object())
        backend = AnthropicAPIBackend(ModelBackendConfig(id="fake", type=BackendType.ANTHROPIC_API, label="fixture", model="fake"))
        deltas = []
        with patch.dict("sys.modules", {"anthropic": sdk}), patch.object(backend, "get_env", return_value=None), patch("src.backend.anthropic_api.print"):
            await backend.send_message([], "test", None, "fixture", "message", deltas.append,
                                       extra_tools=TOOLS, on_tool_call=noop_tool)
        self.assertFalse([item for item in deltas if item.type == "error"])
        value = next(item.usage for item in deltas if item.type == "done")
        self.assertEqual((value["inputTokens"], value["outputTokens"], value["contextTokens"], value["requestCount"]), (200, 10, 100, 2))


if __name__ == "__main__":
    unittest.main()

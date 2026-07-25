from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

from src.backend.tts import (
    DEFAULT_VOICE,
    MAX_SPEECH_CHARS,
    markdown_to_speech_text,
    normalize_rate,
    normalize_voice,
    synthesize,
)


class TextNormalizationTests(unittest.TestCase):
    def test_markdown_is_made_suitable_for_speech(self) -> None:
        source = """# 标题

这是 **重点**，请看[说明](https://example.com/doc)。

```python
print("不要朗读")
```

![界面截图](https://example.com/image.png)
"""
        spoken = markdown_to_speech_text(source)

        self.assertIn("标题", spoken)
        self.assertIn("这是 重点，请看说明。", spoken)
        self.assertIn("代码块已省略。", spoken)
        self.assertIn("界面截图", spoken)
        self.assertNotIn("print", spoken)
        self.assertNotIn("https://", spoken)
        self.assertNotIn("**", spoken)

    def test_rate_is_clamped_and_invalid_values_use_default(self) -> None:
        self.assertEqual(normalize_rate(80), 50)
        self.assertEqual(normalize_rate(-90), -50)
        self.assertEqual(normalize_rate("15"), 15)
        self.assertEqual(normalize_rate("fast"), 0)

    def test_voice_validation(self) -> None:
        self.assertEqual(normalize_voice(""), DEFAULT_VOICE)
        self.assertEqual(normalize_voice("zh-CN-YunxiNeural"), "zh-CN-YunxiNeural")
        with self.assertRaises(ValueError):
            normalize_voice("../../not-a-voice")


class SynthesisTests(unittest.IsolatedAsyncioTestCase):
    async def test_audio_chunks_and_runtime_options_are_forwarded(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeCommunicate:
            def __init__(self, **kwargs: object) -> None:
                calls.append(kwargs)

            async def stream(self):
                yield {"type": "metadata", "data": b"ignored"}
                yield {"type": "audio", "data": b"first"}
                yield {"type": "audio", "data": b"second"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            result = await synthesize("你好", "zh-CN-YunxiNeural", 15)

        self.assertEqual(result.audio, b"firstsecond")
        self.assertEqual(result.voice, "zh-CN-YunxiNeural")
        self.assertEqual(result.rate, 15)
        self.assertEqual(
            calls,
            [{"text": "你好", "voice": "zh-CN-YunxiNeural", "rate": "+15%"}],
        )

    async def test_long_text_is_bounded_with_spoken_notice(self) -> None:
        received_text: list[str] = []

        class FakeCommunicate:
            def __init__(self, **kwargs: object) -> None:
                received_text.append(str(kwargs["text"]))

            async def stream(self):
                yield {"type": "audio", "data": b"audio"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            result = await synthesize("字" * (MAX_SPEECH_CHARS + 10))

        self.assertTrue(result.truncated)
        self.assertTrue(received_text[0].endswith("内容较长，后续部分已省略。"))
        self.assertLessEqual(len(result.text), MAX_SPEECH_CHARS + 20)

    async def test_empty_audio_is_reported(self) -> None:
        class FakeCommunicate:
            def __init__(self, **_kwargs: object) -> None:
                pass

            async def stream(self):
                yield {"type": "metadata"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            with self.assertRaisesRegex(RuntimeError, "未返回音频"):
                await synthesize("你好")


if __name__ == "__main__":
    unittest.main()

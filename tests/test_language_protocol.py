from __future__ import annotations

import asyncio
import json
import unittest

from src.backend.language_protocol import LspChannel, LspError, LspFrames, MAX_MESSAGE


def frame(row):
    data = json.dumps({'jsonrpc': '2.0', **row}, ensure_ascii=False).encode()
    return f'Content-Length: {len(data)}\r\n\r\n'.encode() + data


class FakeProcess:
    def __init__(self, data, state):
        self.data, self.state = data, state
        self.frames = LspFrames()
        self.sent = []
        self.failed = self.stdout_eof = False
        self.confirmed = False
        self.stop_gate = None

    async def start(self, *args, **kwargs):
        pass

    async def write(self, data):
        self.sent.extend(self.frames.feed(data))

    async def stop(self):
        if self.stop_gate:
            await self.stop_gate
        self.confirmed = True
        return True


class FrameTests(unittest.TestCase):
    def test_fragmented_unicode_and_multiple_frames(self):
        reader = LspFrames(); data = frame({'id': 1, 'result': '文本😀'}) + frame({'id': 2, 'result': None})
        rows = []
        for byte in data:
            rows += reader.feed(bytes([byte]))
        self.assertEqual(rows[0]['result'], '文本😀'); self.assertEqual(rows[1]['id'], 2)

    def test_oversize_length_duplicate_header_and_invalid_json_rejected(self):
        for data in (f'Content-Length: {MAX_MESSAGE + 1}\r\n\r\n'.encode(),
                     b'Content-Length: 4\r\nContent-Length: 4\r\n\r\nnull', b'Content-Length: 4\r\n\r\nnull',
                     b'Content-Length: -4\r\n\r\n', b'x' * 8193):
            with self.assertRaises(LspError):
                LspFrames().feed(data)


class ChannelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.notifications, self.failures = [], []
        self.channel = LspChannel(lambda m, p: self.notifications.append((m, p)),
            lambda items: [{'fixture': True} for _ in items], [], self.failures.append, FakeProcess)
        await self.channel.start(['/fake'], '/qa', {})

    async def test_out_of_order_responses_are_matched_to_original_requests(self):
        a = asyncio.create_task(self.channel.request('a', {}))
        b = asyncio.create_task(self.channel.request('b', {}))
        await asyncio.sleep(0)
        self.channel._data('stdout', frame({'id': 2, 'result': 'b'}))
        self.channel._data('stdout', frame({'id': 1, 'result': 'a'}))
        self.assertEqual(await a, 'a'); self.assertEqual(await b, 'b')
        self.assertFalse(self.channel.pending)

    async def test_timeout_cancels_original_request_and_late_reply_cannot_resolve_next(self):
        with self.assertRaises(asyncio.TimeoutError):
            await self.channel.request('stuck', {}, timeout=.02)
        self.assertEqual(self.channel.process.sent[-1]['method'], '$/cancelRequest')
        self.channel._data('stdout', frame({'id': 1, 'result': 'late'}))
        self.assertFalse(self.channel.pending); self.assertFalse(self.failures)

    async def test_server_edit_or_arbitrary_command_is_never_executed(self):
        self.channel._data('stdout', frame({'id': 'edit', 'method': 'workspace/applyEdit', 'params': {'edit': {}}}))
        self.channel._data('stdout', frame({'id': 'exec', 'method': 'workspace/executeCommand', 'params': {'command': 'forbidden'}}))
        await asyncio.sleep(0)
        self.assertFalse(self.channel.process.sent[0]['result']['applied'])
        self.assertEqual(self.channel.process.sent[1]['error']['code'], -32601)

    async def test_excess_output_and_crash_report_one_failure_no_automatic_restart(self):
        self.channel._data('stderr', b'x' * (1024 * 1024 + 1))
        self.channel._data('stdout', frame({'method': 'other', 'params': {}}))
        self.channel.process.failed = True; self.channel._state()
        self.assertEqual(len(self.failures), 1)
        self.assertFalse(self.notifications)
        with self.assertRaises(LspError):
            await self.channel.request('a', {})

    async def test_bounded_inflight_and_explicit_cancel(self):
        tasks = [asyncio.create_task(self.channel.request('blocked', {})) for _ in range(32)]
        await asyncio.sleep(0)
        with self.assertRaisesRegex(LspError, 'request_limit'):
            await self.channel.request('overflow', {})
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.assertFalse(self.channel.pending)

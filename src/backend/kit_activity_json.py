"""流式校验活动文件，只保留指定字段；历史正文不进入活动状态的内存预算。"""
from __future__ import annotations

import json
import re
from typing import Any, TextIO


_STRING_END = re.compile(r'["\\\x00-\x1f]')
_SPACE = re.compile(r'[ \t\r\n]*')
_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z')


class ActivityJSON:
    """Validate the entire JSON, including skipped values, with bounded buffers.

    A projection is True (keep), False (validate only), a field dictionary, or
    a one-item list describing array elements. No dependency or data migration.
    """

    def __init__(self, stream: TextIO, *, limit: int = 16 * 1024 * 1024,
                 max_chars: int = 64 * 1024 * 1024) -> None:
        self.stream = stream
        self.buffer = ''
        self.pos = 0
        self.remaining = limit
        self.nodes = 1_000_000
        self.chars_left = max_chars

    def peek(self) -> str:
        if self.pos == len(self.buffer):
            self.buffer = self.stream.read(min(65536, self.chars_left + 1))
            self.chars_left -= len(self.buffer)
            if self.chars_left < 0:
                raise ValueError('activity file grew beyond read budget')
            self.pos = 0
        return self.buffer[self.pos:self.pos + 1]

    def take(self) -> str:
        value = self.peek()
        if not value:
            raise ValueError('unexpected end of JSON')
        self.pos += 1
        return value

    def space(self) -> None:
        while self.peek():
            self.pos = _SPACE.match(self.buffer, self.pos).end()
            if self.pos < len(self.buffer):
                break

    def reserve(self, size: int) -> None:
        self.remaining -= size
        if self.remaining < 0:
            raise ValueError('activity projection exceeds limit')

    def string(self, keep: bool) -> str | None:
        if self.take() != '"':
            raise ValueError('expected JSON string')
        parts = ['"'] if keep else []
        while self.peek():
            match = _STRING_END.search(self.buffer, self.pos)
            end = match.start() if match else len(self.buffer)
            if keep:
                chunk = self.buffer[self.pos:end]
                self.reserve(len(chunk.encode('utf-8')))
                parts.append(chunk)
            self.pos = end
            if not match:
                continue
            char = self.take()
            if char == '"':
                if keep:
                    parts.append(char)
                    return json.loads(''.join(parts))
                return None
            if char != '\\':
                raise ValueError('unescaped JSON control character')
            escaped = self.take()
            suffix = escaped
            if escaped == 'u':
                digits = ''.join(self.take() for _ in range(4))
                if any(c not in '0123456789abcdefABCDEF' for c in digits):
                    raise ValueError('invalid Unicode escape')
                suffix += digits
            elif escaped not in '"\\/bfnrt':
                raise ValueError('invalid JSON escape')
            if keep:
                self.reserve(len(suffix) + 1)
                parts.append('\\' + suffix)
        raise ValueError('unterminated JSON string')

    def value(self, projection: Any, depth: int = 0) -> Any:
        self.nodes -= 1
        if depth > 64 or self.nodes < 0:
            raise ValueError('JSON complexity exceeds limit')
        keep = projection is not False
        if keep:
            self.reserve(32)
        self.space()
        char = self.peek()
        if char in ('{', '['):
            obj = char == '{'
            if keep and projection is not True and not isinstance(projection, dict if obj else list):
                raise ValueError('invalid activity field type')
            self.take()
            result = {} if obj else []
            end = '}' if obj else ']'
            self.space()
            if self.peek() == end:
                self.take()
                return result if keep else None
            while True:
                self.space()
                if obj:
                    # Even skipped keys are bounded; only retained fields need duplicate tracking.
                    remaining = self.remaining
                    self.remaining = min(remaining, 4096)
                    key = self.string(True)
                    self.remaining = remaining
                    self.space()
                    if self.take() != ':':
                        raise ValueError('expected JSON colon')
                    child = projection.get(key, False) if isinstance(projection, dict) else keep
                    if child is not False:
                        self.reserve(len(key.encode('utf-8')))
                    if child is not False and key in result:
                        raise ValueError('duplicate activity field')
                else:
                    child = projection[0] if isinstance(projection, list) else keep
                value = self.value(child, depth + 1)
                if child is not False:
                    if obj:
                        result[key] = value
                    else:
                        result.append(value)
                self.space()
                separator = self.take()
                if separator == end:
                    return result if keep else None
                if separator != ',':
                    raise ValueError('expected JSON separator')
        if char == '"':
            value = self.string(keep)
        else:
            token = ''
            while self.peek() and self.peek() not in ' \t\r\n,]}':
                token += self.take()
                if len(token) > 128:
                    raise ValueError('invalid JSON scalar')
            if token not in ('true', 'false', 'null') and not _NUMBER.fullmatch(token):
                raise ValueError('invalid JSON scalar')
            value = json.loads(token) if keep else None
        if keep and projection is not True and value is not None:
            raise ValueError('invalid activity field type')
        return value

    def read(self, projection: dict[str, Any]) -> dict[str, Any]:
        value = self.value(projection)
        self.space()
        if self.peek() or not isinstance(value, dict):
            raise ValueError('invalid activity document')
        return value

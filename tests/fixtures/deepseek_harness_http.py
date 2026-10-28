"""Loopback-only model fixture; never reaches an external model or MCP service."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class LocalModel:
    def __init__(self, replies: list[str | tuple[str, dict[str, Any]]] | None = None) -> None:
        self.replies = replies or ["local fixture done"]
        self.posts: list[dict] = []
        self.paths: list[str] = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_POST(self) -> None:
                fixture.paths.append(self.path)
                fixture.posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                index = len(fixture.posts) - 1
                response = fixture.replies[min(index, len(fixture.replies) - 1)]
                tool = isinstance(response, tuple)
                block = {"type": "tool_use", "id": f"call-{index}", "name": response[0], "input": {}} if tool else {"type": "text", "text": ""}
                delta = {"type": "input_json_delta", "partial_json": json.dumps(response[1])} if tool else {"type": "text_delta", "text": response}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for event in [
                    {"type": "message_start", "message": {"id": f"reply-{index}", "model": "smoke-model", "usage": {"input_tokens": 3, "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": block},
                    {"type": "content_block_delta", "index": 0, "delta": delta},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn"}, "usage": {"output_tokens": 2}},
                    {"type": "message_stop"},
                ]:
                    self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
                    self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self) -> "LocalModel":
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

"""Opt-in observation of Qwen's fetch JSON boundary; no proxy or config edits.

The preload only observes JSON model requests. It preserves request/response objects
and never reads response streams. Auth headers and endpoints are not transported.
Child tools do not inherit the preload. Unsupported transports retain SDK evidence.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import threading
import uuid
from typing import Callable

from . import paths
from .call_trace import _CURRENT

_LOCK = threading.Lock()
_PREFIX = "AWU-CALL-TRACE:"
_HOOK = r'''
'use strict';
(() => {
  const nonce = process.env.AWU_CALL_TRACE_NONCE;
  if (!nonce) return;
  const launchOptions = process.env.NODE_OPTIONS;
  const previous = process.env.AWU_CALL_TRACE_NODE_OPTIONS;
  if (previous) process.env.NODE_OPTIONS = previous;
  else delete process.env.NODE_OPTIONS;
  delete process.env.AWU_CALL_TRACE_NONCE;
  delete process.env.AWU_CALL_TRACE_NODE_OPTIONS;
  // Propagate only to Qwen's own memory relaunch or its verified bin wrapper.
  // Qwen 0.19.8 cli-entry.js uses spawnSync(node, ['--expose-gc', sibling cli.js]).
  // Do not leave NODE_OPTIONS in the environment inherited by tools/MCP.
  const cp = require('node:child_process');
  const path = require('node:path');
  let wrapperTarget = null;
  try {
    const entry = path.resolve(process.argv[1] || '');
    const pkg = JSON.parse(require('node:fs').readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'));
    if (path.basename(entry) === 'cli-entry.js' && pkg.name === '@qwen-code/qwen-code') {
      wrapperTarget = path.join(path.dirname(entry), 'cli.js');
    }
  } catch (_) {}
  for (const method of ['spawn', 'spawnSync']) {
    const originalSpawn = cp[method];
    cp[method] = function(command, args, options) {
      const sameEntry = method === 'spawn' && Array.isArray(args) && args.includes(process.argv[1]) &&
        options && options.env && options.env.QWEN_CODE_NO_RELAUNCH === 'true';
      const binWrapper = method === 'spawnSync' && wrapperTarget && Array.isArray(args) &&
        args[0] === '--expose-gc' && args[1] === wrapperTarget && options && options.stdio === 'inherit';
      if (command === process.execPath && (sameEntry || binWrapper)) {
        options = {...options, env: {...(options.env || process.env), NODE_OPTIONS: launchOptions,
          AWU_CALL_TRACE_NONCE: nonce, AWU_CALL_TRACE_NODE_OPTIONS: previous || ''}};
      }
      return Reflect.apply(originalSpawn, this, [command, args, options]);
    };
  }
  require('node:module').syncBuiltinESMExports();
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  let sequence = 0, remaining = 2400000;
  const publish = value => {
    try {
      if (sequence >= 64 || remaining <= 0) return;
      const text = JSON.stringify(value);
      remaining -= text.length;
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      const id = ++sequence, count = Math.ceil(encoded.length / 4096);
      for (let i = 0; i < count; i++) {
        process.stderr.write('AWU-CALL-TRACE:' + nonce + ':' + id + ':' + i + ':' + count + ':' + encoded.slice(i * 4096, (i + 1) * 4096) + '\n');
      }
    } catch (_) { /* Observation must not affect the request. */ }
  };
  publish({diagnostic: 'observer-ready'});
  const context = new (require('node:async_hooks').AsyncLocalStorage)();
  const observeJSON = (body, source) => {
    try {
      if (typeof body !== 'string') return false;
      if (body.length > 1600000) { publish({omitted:true, chars:body.length}); return true; }
      const parsed = JSON.parse(body);
      if (parsed && (Array.isArray(parsed.messages) || Array.isArray(parsed.contents) || Array.isArray(parsed.input))) {
        publish({body:parsed, source});
        return true;
      }
    } catch (_) {}
    return false;
  };
  // 0.19.8 uses its bundled undici.fetch, bypassing globalThis.fetch. Observe
  // chunks already handed to the socket via onBodySent, never consume/tee a
  // request or response stream. Leave the original callback/return intact.
  const dc = require('node:diagnostics_channel');
  const pendingBodies = new WeakMap();
  let bufferedBytes = 0;
  dc.channel('undici:request:create').subscribe(({request}) => {
    try {
      if (context.getStore() || sequence >= 64 || remaining <= 0 || request.method !== 'POST' ||
          !/\/(?:chat\/completions|responses|messages)(?:\?|$)|:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(request.path) ||
          typeof request.onBodySent !== 'function') return;
      const state = {chunks:[], bytes:0, omitted:false};
      pendingBodies.set(request, state);
      const onBodySent = request.onBodySent;
      request.onBodySent = function(chunk) {
        const result = Reflect.apply(onBodySent, this, arguments);
        try {
          if (!state.omitted) {
            const data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (bufferedBytes + data.length > 4800000) {
              state.omitted = true; bufferedBytes -= state.bytes; state.chunks = [];
            } else {
              state.chunks.push(Buffer.from(data)); state.bytes += data.length; bufferedBytes += data.length;
            }
          }
        } catch (_) {}
        return result;
      };
    } catch (_) {}
  });
  const finishBody = (request, failed) => {
    try {
      const state = pendingBodies.get(request);
      if (!state) return;
      pendingBodies.delete(request);
      if (!state.omitted) bufferedBytes -= state.bytes;
      if (state.omitted) publish({omitted:true, reason:'outgoing-body-limit'});
      else if (!failed) observeJSON(Buffer.concat(state.chunks).toString('utf8'), 'undici outgoing JSON body');
      state.chunks = [];
    } catch (_) {}
  };
  dc.channel('undici:request:bodySent').subscribe(({request}) => finishBody(request, false));
  dc.channel('undici:request:error').subscribe(({request}) => finishBody(request, true));
  globalThis.fetch = function(input, init) {
    const observed = observeJSON(init && init.body, 'globalThis.fetch JSON request body');
    if (observed) return context.run(true, () => Reflect.apply(original, this, arguments));
    return Reflect.apply(original, this, arguments);
  };
})();
'''


def _hook_path() -> Path:
    directory = paths.sub("call-trace-runtime")
    file = directory / (hashlib.sha256(_HOOK.encode()).hexdigest()[:16] + ".cjs")
    with _LOCK:
        directory.mkdir(parents=True, exist_ok=True)
        if not file.exists():
            temporary = directory / (uuid.uuid4().hex + ".tmp")
            try:
                temporary.write_text(_HOOK, encoding="utf-8")
                os.replace(temporary, file)
            finally:
                temporary.unlink(missing_ok=True)
    return file


def prepare_qwen_trace(env: dict) -> tuple[dict, Callable[[str], bool]]:
    trace = _CURRENT.get()
    if trace is None:
        return env, lambda _line: False
    attempt = trace.attempt
    capture = {"status": "pending", "observerReady": False, "observedRequests": 0,
               "transport": "qwen-fetch/undici-json"}
    if attempt is not None:
        attempt["modelRequestCapture"] = capture
    try:
        file = _hook_path()
    except OSError:
        capture.update(status="unavailable", reason="无法准备请求观测器；仅记录 SDK 边界。")
        return env, lambda line: line.startswith(_PREFIX)
    nonce = uuid.uuid4().hex
    prefix = f"{_PREFIX}{nonce}:"
    previous = str(env.get("NODE_OPTIONS", os.environ.get("NODE_OPTIONS", "")))
    updated = {**env, "AWU_CALL_TRACE_NONCE": nonce, "AWU_CALL_TRACE_NODE_OPTIONS": previous,
               "NODE_OPTIONS": f'{previous} --require={json.dumps(file.as_posix())}'.strip()}
    pending: dict[str, dict] = {}
    received_chars = 0

    def consume(line: str) -> bool:
        nonlocal received_chars
        if not line.startswith(_PREFIX):
            return False
        # Never copy diagnostic transport fragments into ordinary stderr logs.
        if not line.startswith(prefix) or trace.closed or trace.attempt is not attempt:
            return True
        try:
            identity, index_text, total_text, chunk = line[len(prefix):].split(":", 3)
            index, total = int(index_text), int(total_text)
            received_chars += len(chunk)
            if not (0 <= index < total <= 1600) or received_chars > 8_000_000 or len(pending) > 64:
                trace.data["truncated"] = True
                return True
            record = pending.setdefault(identity, {"total": total, "chunks": {}})
            if total != record["total"]:
                return True
            record["chunks"][index] = chunk
            if len(record["chunks"]) == total:
                raw = "".join(record["chunks"][i] for i in range(total))
                payload = json.loads(base64.b64decode(raw, validate=True))
                pending.pop(identity, None)
                if payload.get("diagnostic") == "observer-ready":
                    capture["observerReady"] = True
                    return True
                if payload.get("omitted"):
                    trace.data["truncated"] = True
                    capture.update(status="partial", reason="有请求超过观测上限，未保留正文。")
                elif isinstance(payload.get("body"), dict):
                    body = payload["body"]
                    size = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
                    messages = body.get("messages") or body.get("contents") or body.get("input") or []
                    tools = body.get("tools") or []
                    capture["observedRequests"] += 1
                    if capture["status"] != "partial":
                        capture["status"] = "captured"
                    payload["requestIndex"] = capture["observedRequests"]
                    payload["structure"] = {"jsonChars": size(body), "messageCount": len(messages),
                                            "messageJsonChars": size(messages), "toolCount": len(tools),
                                            "toolJsonChars": size(tools), "tokenCount": None}
                trace.add("sent", "qwen-model-request", payload,
                          "观测到 Qwen 在 fetch/undici 边界提交的模型请求 JSON，含当次实际携带的 messages/tools；已脱敏，不含认证头，非逐字节网络报文。字符数为脱敏前 JSON 字符数，不是 Token。响应仍以 SDK 返回事件为准。")
        except (ValueError, KeyError, TypeError, UnicodeError):
            trace.data["truncated"] = True
        return True

    return updated, consume

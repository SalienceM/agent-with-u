import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from src.backend.call_trace import CallTrace, traced_send, read_trace
from src.backend.qwen_trace import prepare_qwen_trace


@unittest.skipUnless(shutil.which("node"), "Node required for the no-network fetch boundary test")
class QwenTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_node_hook_observes_body_without_mutation_or_child_inheritance(self):
        with tempfile.TemporaryDirectory() as tmp, patch("src.backend.call_trace.paths.sub", side_effect=lambda *parts: Path(tmp).joinpath(*parts)):
            class Backend:
                config = SimpleNamespace(id="qwen", type="qwen-code-cli")

                async def send_message(self, **kwargs):
                    env, consume = prepare_qwen_trace({"NODE_OPTIONS": "--no-warnings"})
                    # fake fetch: no provider, networking, auth, or model call.
                    hook = next(Path(tmp).rglob("*.cjs"))
                    script = r'''
                    const before = 'original-body';
                    globalThis.fetch = (url, init) => Promise.resolve({url, body: init.body, sentinel: 42});
                    require(process.argv[1]);
                    const body = JSON.stringify({model:'fixture', messages:[{role:'system',content:'real system'}, {role:'user',content:'你是谁'}],tools:[{name:'read_file'}],token:'lease-secret'});
                    fetch('https://invalid.example', {body, headers:{Authorization:'secret-header'}}).then(result => {
                      const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({nonce:process.env.AWU_CALL_TRACE_NONCE || null,nodeOptions:process.env.NODE_OPTIONS}))'], {encoding:'utf8'});
                      process.stdout.write(JSON.stringify({same:result.body === body, sentinel:result.sentinel,
                        nodeOptions:process.env.NODE_OPTIONS, nonce:process.env.AWU_CALL_TRACE_NONCE || null, child:JSON.parse(child.stdout)}));
                    });
                    '''
                    # Load manually after fake fetch installation; retain hook's saved original env.
                    process = await asyncio.to_thread(subprocess.run, [shutil.which("node"), "-e", script, str(hook)],
                        env={**os.environ, **env, "NODE_OPTIONS": "--no-warnings"}, capture_output=True, text=True, encoding="utf-8", timeout=10)
                    self_outer.assertEqual(process.returncode, 0, process.stderr)
                    for line in process.stderr.splitlines():
                        self_outer.assertTrue(consume(line))
                    observed = json.loads(process.stdout)
                    self_outer.assertEqual(observed, {"same": True, "sentinel": 42, "nodeOptions": "--no-warnings", "nonce": None,
                                                     "child": {"nonce": None, "nodeOptions": "--no-warnings"}})
                    return {}

            self_outer = self
            await traced_send(Backend(), {}, CallTrace("s", "e"))
            data = read_trace("s", "e")
            request = next(item for item in data["attempts"][0]["sent"] if item["scope"] == "qwen-model-request")
            self.assertEqual(request["body"]["body"]["messages"][0]["content"], "real system")
            self.assertNotIn("lease-secret", json.dumps(data))
            self.assertNotIn("secret-header", json.dumps(data))

    async def test_undici_chunks_are_observed_without_changing_callbacks(self):
        with tempfile.TemporaryDirectory() as tmp, patch("src.backend.call_trace.paths.sub", side_effect=lambda *parts: Path(tmp).joinpath(*parts)):
            outer = self
            class Backend:
                config = SimpleNamespace(id="qwen", type="qwen-code-cli")

                async def send_message(self, **kwargs):
                    env, consume = prepare_qwen_trace({})
                    script = r'''
                    const dc = require('node:diagnostics_channel');
                    const sent = [];
                    const request = {method:'POST', path:'/v1/chat/completions', onBodySent(chunk) {sent.push(chunk); return 42;}};
                    dc.channel('undici:request:create').publish({request});
                    const a = Buffer.from('{"messages":[{"role":"user","content":"hello"}],');
                    const b = Buffer.from('"tools":[],"token":"fixture-secret"}');
                    const results = [request.onBodySent(a), request.onBodySent(b)];
                    dc.channel('undici:request:bodySent').publish({request});
                    const other = {method:'POST', path:'/upload', onBodySent() {}};
                    const original = other.onBodySent;
                    dc.channel('undici:request:create').publish({request:other});
                    process.stdout.write(JSON.stringify({results, same:sent[0] === a && sent[1] === b, untouched:other.onBodySent === original}));
                    '''
                    proc = await asyncio.to_thread(subprocess.run, [shutil.which('node'), '-e', script], env={**os.environ, **env},
                                                   capture_output=True, text=True, encoding='utf8', timeout=10)
                    outer.assertEqual(proc.returncode, 0, proc.stderr)
                    for line in proc.stderr.splitlines():
                        outer.assertTrue(consume(line))
                    outer.assertEqual(json.loads(proc.stdout), {'results': [42, 42], 'same': True, 'untouched': True})
                    return {}

            await traced_send(Backend(), {}, CallTrace('s', 'e'))
            attempt = read_trace('s', 'e')['attempts'][0]
            actual = [entry for entry in attempt['sent'] if entry['scope'] == 'qwen-model-request']
            self.assertEqual(len(actual), 1)
            self.assertEqual(actual[0]['body']['body']['messages'][0]['content'], 'hello')
            self.assertEqual(actual[0]['body']['structure']['messageCount'], 1)
            self.assertIsNone(actual[0]['body']['structure']['tokenCount'])
            self.assertNotIn('fixture-secret', json.dumps(attempt))

    async def test_capture_failure_is_explicit_not_claimed_complete(self):
        with tempfile.TemporaryDirectory() as tmp, patch("src.backend.call_trace.paths.sub", side_effect=lambda *parts: Path(tmp).joinpath(*parts)):
            class Backend:
                config = SimpleNamespace(id='qwen', type='qwen-code-cli')
                async def send_message(self, **kwargs):
                    prepare_qwen_trace({})
                    return {}
            await traced_send(Backend(), {}, CallTrace('s', 'e'))
            capture = read_trace('s', 'e')['attempts'][0]['modelRequestCapture']
            self.assertEqual(capture['status'], 'unavailable')
            self.assertFalse(capture['observerReady'])
            self.assertEqual(capture['observedRequests'], 0)

    async def test_disabled_is_a_noop(self):
        env = {"NODE_OPTIONS": "--no-warnings"}
        result, consume = prepare_qwen_trace(env)
        self.assertIs(result, env)
        self.assertFalse(consume("ordinary stderr"))


if __name__ == "__main__":
    unittest.main()

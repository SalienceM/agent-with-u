"""Opt-in Windows contracts in isolated homes, without paid model calls.

AWU_TEST_LOOP_NATIVE=1 python -m unittest tests.test_loop_environment_native -v
Deterministic probes use fixed synthetic commands without thread/turn creation.
A separate loopback fake-provider fixture drives one fixed real command-tool call
per policy in isolated native threads. Never calls sandbox/setup, copies auth,
changes ACLs, touches production Sessions, or enables full-access fallback.
"""
import asyncio
import json
import os
import platform
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from pathlib import Path

from src.backend.codex_app_server import CodexAppServerProcess, local_app_server_command
from src.backend.codex_environment import (probe_environment, native_error_code, ProbeAppServerProcess,
    command_exec, probe_policy, effective_probe_policy, FRAME_CAP, NATIVE_CAPTURE_CAP)
from src.backend.loop_execution_environment import EnvironmentError
from src.backend.codex_office import resolve_codex_cli
from src.backend.loop_execution_environment import ExecutionIdentity


class QuietNativeProcess(ProbeAppServerProcess):
    async def _read_one(self, timeout=None):
        value = await super()._read_one(timeout)
        if 'error' in value:
            # 仅输出固定分类，不保存原生异常正文。
            error = value['error'] if isinstance(value['error'], dict) else {}
            print(json.dumps({'fixtureProtocolError': native_error_code(error),
                              'code': error.get('code') if type(error.get('code')) is int else None}))
        return value

    async def _read_stderr(self):
        # 原生错误可带本机路径；测试报告只输出规范化结果。
        assert self.proc and self.proc.stderr
        while await self.proc.stderr.readline():
            pass


@unittest.skipUnless(os.name == 'nt' and os.environ.get('AWU_TEST_LOOP_NATIVE') == '1', 'opt-in native Windows contract')
class NativeEnvironmentContract(unittest.IsolatedAsyncioTestCase):
    async def test_actual_tool_with_loopback_provider_no_paid_model(self):
        observations = []
        calls = []
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length < 4 * 1024 * 1024:
                    self.send_error(400); return
                try:
                    body = json.loads(self.rfile.read(length))
                except (ValueError, UnicodeError):
                    self.send_error(400); return
                # 仅保留工具名称及固定合成输出的布尔匹配，不保存请求提示词。
                names = [tool.get('name') for tool in body.get('tools', [])]
                outputs = [item for item in body.get('input', []) if item.get('type') == 'function_call_output']
                calls.append({'tools': names, 'hasOutput': bool(outputs),
                    'success': any('AWU_NATIVE_TOOL_OK' in str(item.get('output', '')) for item in outputs)})
                rid = f'fixture-{len(calls)}'
                if outputs:
                    item = {'id': 'message-done', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                        'content': [{'type': 'output_text', 'text': 'fixture finished', 'annotations': []}]}
                else:
                    tool = next((name for name in ('exec_command', 'shell_command', 'shell') if name in names), '')
                    command = 'Write-Output AWU_NATIVE_TOOL_OK'
                    args = {'cmd': command, 'yield_time_ms': 1000, 'max_output_tokens': 100} if tool == 'exec_command' else (
                        {'command': command, 'timeout_ms': 3000} if tool == 'shell_command' else
                        {'command': ['powershell.exe', '-NoProfile', '-Command', command], 'timeout_ms': 3000})
                    item = {'id': 'call-fixed', 'call_id': 'fixed', 'type': 'function_call', 'name': tool,
                        'arguments': json.dumps(args), 'status': 'completed'}
                events = [
                    {'type': 'response.created', 'response': {'id': rid, 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                    {'type': 'response.completed', 'response': {'id': rid, 'status': 'completed', 'output': [item],
                        'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}},
                ]
                data = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='awu-loop-native-tool-') as raw_root:
                root = Path(raw_root).resolve()
                self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
                home, workspace = root / 'home', root / 'workspace'
                home.mkdir(); workspace.mkdir()
                env = {key: value for key, value in os.environ.items()
                    if key.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'}}
                env.update(CODEX_HOME=str(home), HOME=str(home), USERPROFILE=str(home), APPDATA=str(home),
                    LOCALAPPDATA=str(home), TEMP=str(root), TMP=str(root), HTTP_PROXY='http://127.0.0.1:9',
                    HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='127.0.0.1')
                conn = QuietNativeProcess(launch_command=local_app_server_command(resolve_codex_cli(), [
                    '-c', "windows.sandbox='unelevated'", '-c', "model_provider='fixture'", '-c', "model='gpt-5.1-codex'",
                    '-c', "model_providers.fixture.name='fixture'", '-c', f"model_providers.fixture.base_url='http://127.0.0.1:{server.server_port}/v1'",
                    '-c', "model_providers.fixture.wire_api='responses'", '-c', 'model_providers.fixture.requires_openai_auth=false',
                    '-c', 'model_providers.fixture.request_max_retries=0', '-c', 'model_providers.fixture.stream_max_retries=0',
                    '-c', 'features.shell_snapshot=false',
                ]), env=env, cwd=str(workspace), isolated_process_group=True)
                try:
                    await conn.start()
                    for access in ('read-only', 'workspace-write'):
                        bootstrap = await conn.request('thread/start', {'cwd': str(workspace), 'sandbox': access, 'approvalPolicy': 'never'}, timeout=15)
                        identity = ExecutionIdentity('fixture', 'fixture', 'fixture', str(workspace), 'fixture', 'app-server', 'prepare', access)
                        policy = await effective_probe_policy(conn, identity, bootstrap)
                        check = await probe_environment(conn, identity, dependencies=[], policy=policy, system_root=env['SYSTEMROOT'])
                        self.assertEqual(check['status'], 'passed')
                        await conn.request('turn/start', {'threadId': bootstrap['thread']['id'],
                            'input': [{'type': 'text', 'text': 'Run the fixed isolated fixture command.'}]}, timeout=10)
                        deadline = asyncio.get_running_loop().time() + 25
                        events = []
                        while True:
                            message = await conn.next_message(timeout=max(.01, deadline - asyncio.get_running_loop().time()))
                            if asyncio.get_running_loop().time() >= deadline:
                                self.fail('Bounded local provider fixture timed out')
                            if message.get('method') == 'item/completed':
                                item = message.get('params', {}).get('item', {})
                                if item.get('type') == 'commandExecution':
                                    events.append({'exitCode': item.get('exitCode'), 'status': item.get('status'),
                                        'marker': 'AWU_NATIVE_TOOL_OK' in item.get('aggregatedOutput', '')})
                            if message.get('method') == 'turn/completed':
                                break
                        observations.append({'access': access, 'events': events})
                        self.assertTrue(events and events[-1]['marker'] and events[-1]['exitCode'] == 0,
                            'Actual tool fixture did not verify success; native-policy alone is insufficient')
                finally:
                    await conn.close()
                self.assertTrue(conn.cleanup_confirmed)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close(); thread.join(2)
            print(json.dumps({'fixtureActualTool': observations, 'loopbackResponses': len(calls),
                'paidModelRequests': 0, 'helperFailureParity': 'unverified'}, ensure_ascii=False))

    async def test_isolated_readonly_command_path(self):
        cli = resolve_codex_cli()
        with tempfile.TemporaryDirectory(prefix='awu-loop-native-') as raw_root:
            root = Path(raw_root).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith('awu-loop-native-'))
            home, workspace, temp = (root / name for name in ('home', 'workspace', 'temp'))
            for directory in (home, workspace, temp):
                directory.mkdir()
            # 白名单构造，不继承用户认证、代理、真实配置或工作区。
            env = {key: value for key, value in os.environ.items()
                   if key.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'}}
            env.update(CODEX_HOME=str(home), HOME=str(home), USERPROFILE=str(home),
                       APPDATA=str(home), LOCALAPPDATA=str(home), TEMP=str(temp), TMP=str(temp),
                       HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9',
                       ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
            conn = QuietNativeProcess(launch_command=local_app_server_command(cli, [
                '-c', "windows.sandbox='unelevated'", '-c', "model_provider='fixture'",
                '-c', "model_providers.fixture.name='fixture'",
                '-c', "model_providers.fixture.base_url='http://127.0.0.1:9/v1'",
                '-c', "model_providers.fixture.wire_api='responses'",
                '-c', 'model_providers.fixture.requires_openai_auth=false',
            ]), env=env, cwd=str(workspace), isolated_process_group=True, stream_limit=FRAME_CAP)
            observations = []
            proc = None
            try:
                await asyncio.wait_for(conn.start(), 25)
                self.assertEqual(conn.server_version, '0.154.0', 'Native version is not in the verified profile')
                proc = conn.proc
                isolated_config = await conn.request('config/read', {'cwd': str(workspace), 'includeLayers': False})
                print(json.dumps({'fixtureEnvironmentPolicy': {key: isolated_config['config'].get(key) for key in
                    ('permissions', 'default_permissions', 'shell_environment_policy')}}, ensure_ascii=False))
                for access in ('read-only', 'workspace-write'):
                    identity = ExecutionIdentity('fixture', 'fixture', 'fixture', str(workspace),
                                                 'fixture', 'app-server', 'prepare', access)
                    policy = await effective_probe_policy(conn, identity)
                    check = await asyncio.wait_for(probe_environment(conn, identity, dependencies=[],
                        system_root=env['SYSTEMROOT'], policy=policy), 35)
                    observations.append({key: check[key] for key in
                        ('status', 'coverage', 'reasonCode', 'quiesced', 'access', 'probePath')})
                # 全部为测试目录的合成入口；不运行用户真实 OpenSpec、不变更 ACL。
                shim = workspace / 'fixture 空格.cmd'
                identity = ExecutionIdentity('fixture', 'fixture', 'fixture', str(workspace), 'fixture', 'app-server', 'prepare', 'read-only')
                policy = await effective_probe_policy(conn, identity)
                missing = await probe_environment(conn, identity, dependencies=['openspec'], entry=str(shim), policy=policy)
                self.assertEqual(missing['reasonCode'], 'env_cli_entry_missing')
                shim.write_text('@echo off\necho 1.2.3\n', encoding='utf-8')
                import ctypes
                from ctypes import wintypes
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
                kernel.CreateFileW.restype = wintypes.HANDLE
                kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                handle = kernel.CreateFileW(str(shim), 0x80000000, 0, None, 3, 0, None)
                self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
                try:
                    refused = await probe_environment(conn, identity, dependencies=['openspec'], entry=str(shim), policy=policy)
                    self.assertEqual(refused['status'], 'blocked')
                finally:
                    kernel.CloseHandle(handle)
                recovered = await probe_environment(conn, identity, dependencies=['openspec'], entry=str(shim), policy=policy)
                self.assertEqual(recovered['status'], 'passed', {k: recovered[k] for k in ('reasonCode', 'dependencyId', 'quiesced')})
                self.assertEqual(recovered['entry'], str(shim))
                print(json.dumps({'fixtureEntry': {'missing': missing['reasonCode'], 'exclusiveHandleRefusal': refused['reasonCode'],
                    'samePolicyRecovery': recovered['status'], 'aclDenial': 'unverified'}}))
                # 固定合成输出，不读取用户数据；验证两个流的原生默认捕获上限。
                for access in ('read-only', 'workspace-write'):
                    captured = await conn.request('command/exec', {
                        'command': [sys.executable, '-I', '-S', '-c',
                                    "import sys; sys.stdout.write('X'*2097152); sys.stderr.write('E'*2097152)"],
                        'cwd': str(workspace), 'sandboxPolicy': probe_policy(access, str(workspace)), 'timeoutMs': 5000,
                    }, timeout=8)
                    self.assertEqual(captured['exitCode'], 0)
                    self.assertEqual(len(captured['stdout'].encode()), NATIVE_CAPTURE_CAP)
                    self.assertEqual(len(captured['stderr'].encode()), NATIVE_CAPTURE_CAP)
                with self.assertRaises(EnvironmentError) as timed_out:
                    await command_exec(conn, [sys.executable, '-I', '-S', '-c', 'import time; time.sleep(5)'],
                        str(workspace), probe_policy('read-only', str(workspace)), timeout=.3)
                self.assertEqual(timed_out.exception.code, 'env_probe_timeout')
                self.assertTrue(timed_out.exception.quiesced)
                self.assertTrue(conn.cleanup_confirmed)
                cancelled_conn = QuietNativeProcess(launch_command=conn.launch_command, env=env, cwd=str(workspace), isolated_process_group=True)
                try:
                    await cancelled_conn.start()
                    task = asyncio.create_task(command_exec(cancelled_conn, [sys.executable, '-I', '-S', '-c', 'import time; time.sleep(5)'],
                        str(workspace), probe_policy('read-only', str(workspace)), timeout=.6))
                    await asyncio.sleep(.1)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError) as cancelled:
                        await task
                    # Python 3.10 跨 Task 传播可能重建 CancelledError，退出证明来自连接租约。
                    self.assertTrue(getattr(cancelled.exception, 'probe_quiesced', cancelled_conn.cleanup_confirmed))
                    self.assertTrue(cancelled_conn.cleanup_confirmed)
                finally:
                    await cancelled_conn.close()
            finally:
                await conn.close()
                if proc:
                    await asyncio.wait_for(proc.wait(), 5)
                    self.assertIsNotNone(proc.returncode)
            print(json.dumps({'os': platform.platform(), 'transport': 'executor-local app-server',
                              'sandbox': 'unelevated test-only configuration', 'observations': observations,
                              'stdoutCaptureBytes': NATIVE_CAPTURE_CAP, 'stderrCaptureBytes': NATIVE_CAPTURE_CAP,
                              'timeoutCleanupConfirmed': conn.cleanup_confirmed,
                              'cancelCleanupConfirmed': cancelled_conn.cleanup_confirmed,
                              'actualToolParity': 'unverified', 'modelCalls': 0}, ensure_ascii=False))
            self.assertEqual(len(observations), 2)
            self.assertTrue(all(item['status'] == 'passed' for item in observations),
                            'Native baseline unavailable; do not claim end-to-end acceptance.')


if __name__ == '__main__':
    unittest.main()

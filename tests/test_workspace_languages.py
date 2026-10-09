from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from pathlib import Path
from unittest.mock import patch
import unittest

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.language_providers import ProviderPlan, provider_plan
from src.backend.workspace_languages import LanguageManager
from tests.engine_workbench_fixtures import EngineFixture


class FakeChannel:
    def __init__(self, notification, configuration, folders, failure):
        self.notification, self.failure = notification, failure
        self.sent = []
        self.pending = None
        self.stop_gate = None
        self.confirm = True

    async def start(self, argv, cwd, env):
        self.cwd = cwd

    async def notify(self, method, params):
        self.sent.append((method, params))

    async def request(self, method, params, **kwargs):
        if method == 'initialize':
            return {'capabilities': {'completionProvider': {'resolveProvider': False}, 'definitionProvider': True,
                'referencesProvider': True, 'renameProvider': True, 'documentFormattingProvider': True}}
        if self.pending:
            await self.pending
        return {'fixture': True}

    async def stop(self):
        if self.stop_gate:
            await self.stop_gate
        return self.confirm


class LanguageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.fixture.write_project_file('hello.py', 'value = 1\n')
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._loop_control_reserved = lambda _: False
        self.bridge._ensure_kit_scheduler = lambda: None
        async def emit(*args, **kwargs):
            pass
        self.bridge._send_for_session = emit
        self.token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.workspace = self.bridge._workbench_identity(self.session.id)
        self.manager = self.bridge._language_manager = LanguageManager(self.bridge, FakeChannel)
        self.plan = ProviderPlan(self.workspace, {'provider': 'python'}, ['/fake'], {}, {}, {'kind': 'lsp'}, 'a' * 64, {})
        self.plan_patch = patch('src.backend.workspace_languages.provider_plan', return_value=self.plan)
        self.plan_patch.start()
        self.manager.plan(self.workspace, {'provider': 'python'})

    async def asyncTearDown(self):
        for row in self.manager.rows.values():
            if row.task and not row.task.done():
                row.task.cancel(); await asyncio.gather(row.task, return_exceptions=True)
            if row.notice:
                row.notice.cancel()
        self.plan_patch.stop(); _REQUEST_OWNER_ID.reset(self.token)

    async def start(self):
        row = self.manager.start(self.workspace, {'requestId': 'start', 'planFingerprint': self.plan.fingerprint,
            'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})
        await row.task
        self.assertEqual(row.status, 'ready')
        return row

    def doc(self, revision=1, text='value = "😀"\n'):
        return {'relativePath': 'hello.py', 'revision': revision, 'text': text}

    async def test_planning_and_list_never_start_and_separate_trust_required(self):
        self.assertEqual(self.manager.rows, {})
        with self.assertRaisesRegex(WorkbenchError, 'trust_required'):
            self.manager.start(self.workspace, {'requestId': 'start', 'planFingerprint': self.plan.fingerprint, 'controlRevision': 0})
        self.assertFalse(self.bridge._engineering_active(self.session.id))
        row = await self.start()
        self.assertEqual(row.channel.cwd, self.workspace.workingDir)
        with self.assertRaisesRegex(WorkbenchError, 'already_running'):
            self.manager.start(self.workspace, {'requestId': 'duplicate', 'planFingerprint': self.plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})

    async def test_unsaved_sync_and_late_diagnostics_never_replace_new_version(self):
        row = await self.start()
        old = await self.manager.sync(row, self.doc())
        new = await self.manager.sync(row, self.doc(2, 'value = 2\n'))
        self.assertEqual([m for m, _ in row.channel.sent][-2:], ['textDocument/didOpen', 'textDocument/didChange'])
        item = {'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 5}}, 'message': 'fixture'}
        row.channel.notification('textDocument/publishDiagnostics', {'uri': new.uri, 'version': old.version, 'diagnostics': [item]})
        self.assertFalse(row.diagnostics)
        row.channel.notification('textDocument/publishDiagnostics', {'uri': new.uri, 'version': new.version, 'diagnostics': [item]})
        self.assertEqual(row.diagnostics['hello.py']['revision'], 2)
        self.assertEqual(row.diagnostics['hello.py']['freshness'], 'current')
        self.assertEqual((self.fixture.workspace / 'hello.py').read_text(), 'value = 1\n')

    async def test_late_completion_is_rejected_after_edit(self):
        row = await self.start()
        row.channel.pending = asyncio.get_running_loop().create_future()
        task = asyncio.create_task(self.manager.request(row, {**self.doc(), 'requestId': 'complete', 'action': 'completion',
            'position': {'line': 0, 'character': 3}}))
        await asyncio.sleep(0)
        await self.manager.sync(row, self.doc(2, 'different = 3'))
        row.channel.pending.set_result(None)
        with self.assertRaisesRegex(WorkbenchError, 'document_stale'):
            await task

    async def test_close_is_versioned_and_frees_bounded_document_slots(self):
        row = await self.start()
        for i in range(33):
            relative = f'file{i}.py'
            self.fixture.write_project_file(relative, 'value = 1')
            doc = await self.manager.sync(row, {'relativePath': relative, 'revision': 1, 'text': 'value = 1'})
            closed = {'requestId': f'close-{i}', 'action': 'close', 'relativePath': relative,
                      'revision': doc.revision, 'protocolVersion': doc.version}
            await self.manager.request(row, closed)
            self.assertFalse(row.documents)
        old = await self.manager.sync(row, self.doc())
        current = await self.manager.sync(row, self.doc(2, 'value = 2'))
        with self.assertRaisesRegex(WorkbenchError, 'document_stale'):
            await self.manager.request(row, {'requestId': 'stale-close', 'action': 'close',
                'relativePath': 'hello.py', 'revision': old.revision, 'protocolVersion': old.version})
        self.assertIs(row.documents['hello.py'], current)
        self.assertEqual(sum(method == 'textDocument/didClose' for method, _ in row.channel.sent), 33)

    async def test_unknown_stop_and_cancelled_waiter_keep_activity(self):
        row = await self.start(); row.channel.confirm = False
        await self.manager.stop(row)
        self.assertEqual(row.status, 'unknown'); self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        row.channel.confirm = True; row.channel.stop_gate = asyncio.get_running_loop().create_future()
        waiter = asyncio.create_task(self.manager.stop(row)); await asyncio.sleep(0); await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        row.channel.stop_gate.set_result(None); await row.stop_task
        self.assertFalse(self.bridge._engineering_active(self.session.id)); self.assertEqual(row.status, 'stopped')

    async def test_wrong_identity_and_escaping_document_are_rejected(self):
        row = await self.start()
        with self.assertRaises(WorkbenchError):
            await self.manager.sync(row, {**self.doc(), 'relativePath': '../home/private.py'})
        with self.assertRaisesRegex(WorkbenchError, 'unavailable'):
            self.manager.require(self.workspace, row.resource_id, 'prior-generation')
        token = _REQUEST_OWNER_ID.set('other')
        try:
            with self.assertRaises(PermissionError):
                self.bridge._rpc_languageServiceList(self.session.id, json.dumps(self.workspace.to_dict()))
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_missing_runtime_and_unknown_options_do_not_execute_project_config(self):
        with self.assertRaisesRegex(WorkbenchError, 'config_invalid'):
            provider_plan(self.workspace, {'provider': 'python', 'command': 'arbitrary'})
        with self.assertRaisesRegex(WorkbenchError, 'dependency_missing'):
            provider_plan(self.workspace, {'provider': 'python', 'nodePath': str(self.fixture.root / 'missing')})

    async def test_selected_typescript_missing_is_not_replaced_and_project_plugins_are_not_executed(self):
        root = self.fixture.workspace
        for file, text in {
            'node': 'not executed', 'tools/typescript/package.json': '{"version":"5.7.3"}',
            'tools/typescript/lib/tsserver.js': 'throw Error("must not execute in plan")',
            'tools/typescript-language-server/package.json': '{"version":"4.3.3"}',
            'tools/prettier/package.json': '{"version":"3.5.3"}',
            '.prettierrc.cjs': 'throw Error("untrusted configuration")',
            'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"untrusted"}]}}',
        }.items():
            self.fixture.write_project_file(file, text)
        config = {'provider': 'react', 'nodePath': str(root / 'node'), 'toolsHome': str(root / 'tools'),
                  'typescriptHome': str(root / 'missing-typescript')}
        before = sorted(str(p) for p in root.rglob('*'))
        with self.assertRaisesRegex(WorkbenchError, 'dependency_missing'):
            provider_plan(self.workspace, config)
        config['typescriptHome'] = str(root / 'tools/typescript')
        plan = provider_plan(self.workspace, config)
        self.assertTrue(plan.options['disableAutomaticTypingAcquisition'])
        self.assertEqual(plan.options['plugins'], [])
        self.assertEqual(sorted(str(p) for p in root.rglob('*')), before)
        self.assertFalse(self.manager.rows)

    async def test_large_language_payload_does_not_weaken_terminal_input_limit(self):
        payload = json.dumps({**self.doc(text='x' * 300000)})
        identity = json.dumps(self.workspace.to_dict())
        with self.assertRaisesRegex(WorkbenchError, 'invalid_request'):
            self.bridge._terminal_args(self.session.id, identity, payload)
        workspace, parsed = self.bridge._terminal_args(self.session.id, identity, payload, payload_limit=4 * 1024 * 1024)
        self.assertEqual(workspace, self.workspace)
        row = await self.start(); await self.manager.sync(row, parsed)
        self.assertEqual(len(row.documents['hello.py'].text), 300000)

    async def test_unversioned_push_cannot_downgrade_current_adapter_result(self):
        row = await self.start(); doc = await self.manager.sync(row, self.doc())
        item = {'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 1}}, 'message': 'current'}
        row.channel.notification('textDocument/publishDiagnostics', {'uri': doc.uri, 'version': doc.version, 'diagnostics': [item]})
        row.channel.notification('textDocument/publishDiagnostics', {'uri': doc.uri, 'diagnostics': []})
        self.assertEqual(row.diagnostics['hello.py']['items'][0]['message'], 'current')

    async def test_helper_unknown_prevents_release_even_after_lsp_confirmed(self):
        row = await self.start()
        class Helper:
            confirmed = False
            async def stop(self):
                return self.confirmed
        helper = Helper(); row.helpers.add(helper)
        await self.manager.stop(row)
        self.assertEqual(row.status, 'unknown'); self.assertFalse(row.lease_released)
        self.assertEqual(len(self.bridge._engineering_active(self.session.id)), 1)
        helper.confirmed = True; await self.manager.stop(row); await self.manager.stop(row)
        self.assertEqual(row.status, 'stopped'); self.assertTrue(row.lease_released)

    async def test_java_lsp_uri_keeps_actual_filename_case_but_identity_is_canonical(self):
        self.fixture.write_project_file('Main.java', 'public class Main {}')
        row = await self.start()
        doc = await self.manager.sync(row, {'relativePath': 'Main.java', 'text': 'public class Main {}', 'revision': 1})
        self.assertTrue(doc.uri.endswith('/Main.java'))

    async def test_format_uses_isolated_formatter_and_stale_result_cannot_touch_disk(self):
        from dataclasses import replace
        row = await self.start()
        row.plan = replace(row.plan, formatter={'kind': 'ruff', 'argv': ['/fixture/ruff', 'format', '--isolated', '--stdin-filename']})
        received = []
        async def run_tool(service, argv, data):
            received.append((argv, data))
            await self.manager.sync(row, self.doc(2, 'newer = 1'))
            return 'value = 1\n'
        with patch('src.backend.workspace_languages.run_tool', run_tool):
            with self.assertRaisesRegex(WorkbenchError, 'document_stale'):
                await self.manager.request(row, {**self.doc(), 'action': 'format', 'requestId': 'format'})
        self.assertIn('--isolated', received[0][0])
        self.assertEqual((self.fixture.workspace / 'hello.py').read_text(), 'value = 1\n')

    async def test_java_build_import_requires_separate_grant_before_process_admission(self):
        self.plan = replace(self.plan, config={'provider': 'java', 'mavenImport': True})
        self.plan_patch.return_value = self.plan
        self.manager.plans[self.workspace.workspaceRevision, self.plan.fingerprint] = self.plan
        with self.assertRaisesRegex(WorkbenchError, 'build_import_trust_required'):
            self.manager.start(self.workspace, {'requestId': 'build', 'planFingerprint': self.plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})
        self.assertFalse(self.bridge._engineering_active(self.session.id))
        self.assertFalse(self.manager.rows)

    async def test_java_initialize_is_not_ready_until_project_import_finishes(self):
        plan = replace(self.plan, config={'provider': 'java', 'mavenRepository': str(self.fixture.root / 'offline-cache')})
        with patch('src.backend.workspace_languages.provider_plan', return_value=plan):
            self.manager.plan(self.workspace, plan.config)
            row = self.manager.start(self.workspace, {'requestId': 'java', 'planFingerprint': plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})
            for _ in range(10):
                await asyncio.sleep(0)
                if row.channel:
                    break
            self.assertEqual(row.status, 'initializing')
            settings = row.settings['java']['configuration']['maven']
            xml = Path(settings['userSettings']).read_text(encoding='utf-8')
            self.assertIn('offline-cache', xml); self.assertIn('<offline>true</offline>', xml)
            self.assertEqual(plan.settings, {})  # Runtime isolation never changes the frozen plan.
            row.channel.notification('language/status', {'type': 'ServiceReady'})
            await row.task; self.assertEqual(row.status, 'ready')
            await self.manager.stop(row)

    async def test_java_import_error_is_visible_and_cleanup_precedes_release(self):
        plan = replace(self.plan, config={'provider': 'java'})
        with patch('src.backend.workspace_languages.provider_plan', return_value=plan):
            self.manager.plan(self.workspace, plan.config)
            row = self.manager.start(self.workspace, {'requestId': 'java-fail', 'planFingerprint': plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})
            for _ in range(10):
                await asyncio.sleep(0)
                if row.channel:
                    break
            row.channel.notification('language/status', {'type': 'Error'})
            await row.task
            self.assertEqual(row.status, 'stopped')
            self.assertEqual(row.reason, 'java_project_import_failed_check_offline_dependencies')
            self.assertFalse(self.bridge._engineering_active(self.session.id))

    async def test_interpreter_switch_requires_confirmed_stop_and_discards_old_results(self):
        old = await self.start()
        old.channel.pending = asyncio.get_running_loop().create_future()
        request = asyncio.create_task(self.manager.request(old, {**self.doc(), 'requestId': 'old-completion',
            'action': 'completion', 'position': {'line': 0, 'character': 3}}))
        await asyncio.sleep(0)
        await self.manager.stop(old)
        await asyncio.gather(request, return_exceptions=True)
        plan = replace(self.plan, config={'provider': 'python', 'pythonPath': '/fixture/venv2/python'}, fingerprint='b' * 64)
        with patch('src.backend.workspace_languages.provider_plan', return_value=plan):
            self.manager.plan(self.workspace, plan.config)
            new = self.manager.start(self.workspace, {'requestId': 'new-environment', 'planFingerprint': plan.fingerprint,
                'allowProjectCode': True, 'allowWorkspaceWrite': True, 'controlRevision': 0})
            await new.task
            self.assertNotEqual(new.generation, old.generation)
            self.assertFalse(new.documents); self.assertFalse(new.diagnostics)
            with self.assertRaisesRegex(WorkbenchError, 'not_ready'):
                await self.manager.sync(old, self.doc(2))
            await self.manager.stop(new)

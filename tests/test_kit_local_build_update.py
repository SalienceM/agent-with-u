"""本机构建直装：临时项目、真实构建登记、惰性 MSI 字节和 fake 桌面，绝不安装。"""
import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tests import test_kit_standalone_update as fixture
from src.backend.kit_capabilities import BUILD_UPDATE_CAPABILITY
from src.backend.kit_local_build import local_build_manifest
from src.backend.kit_update_journal import durable_json
from src.backend.kit_update_template import build_template, local_build_requested, requested
from src.backend.workspace_kit_store import WorkspaceKit


class LocalBuildUpdateTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.StandaloneUpdateTests.asyncTearDown
    until = fixture.StandaloneUpdateTests.until
    confirm = fixture.StandaloneUpdateTests.confirm

    async def asyncSetUp(self):
        await fixture.StandaloneUpdateTests.asyncSetUp(self)
        self.manager.configure({'manifestUrl': ''})
        self.reader.side_effect = AssertionError('本机路径不能读取网络清单')
        self.publisher = self.bridge._release_center()
        guard = patch.object(self.publisher, 'start_publish', side_effect=AssertionError('本机路径不能发布'))
        self.publish = guard.start()
        self.addCleanup(guard.stop)
        (self.workspace / 'src').mkdir()
        (self.workspace / 'dist').mkdir()
        self.script = self.workspace / 'register_release_candidate.py'
        self.script.write_text(
            "import sys, time\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(Path.cwd())!r})\n"
            "from src.backend.release_center import ReleaseCenterManager\n"
            "from src.backend.kit_build_receipts import register_build_receipt\n"
            f"root = Path({str(self.workspace)!r})\n"
            "seq = time.time_ns() // 1000\n"
            "(root/'src/_version.py').write_text(f\"__version__='99.1.1'\\n__package_version__='99.1.1'\\n__build_id__='fixture-{seq}'\\n__build_sequence__={seq}\\n__kit_update_protocol__=1\\n\", encoding='utf-8')\n"
            "(root/'dist/AgentWithU_x64.msi').write_bytes(f'INERT installer {seq}'.encode())\n"
            "register_build_receipt(ReleaseCenterManager().scan_project(str(root))['candidate'])\n",
            encoding='utf-8')
        self.build = WorkspaceKit.from_dict({'id': 'fixture-builder', 'title': '隔离构建', 'enabled': True,
            'command': f"& '{sys.executable}' '{self.script}'", 'shell': 'powershell', 'cwd': '.'})
        state = self.bridge._kit_get(self.session.id)
        state.kits.append(self.build)
        self.bridge._kit_save(state)

    def spec(self):
        return build_template(self.bridge._kit_get(self.session.id), '本机打包直接更新，不用上传', local_build=True)['kit']

    async def run_update(self, mutate=None):
        original = self.bridge._run_kit_update_step
        async def before_stage(state, session, run, step, *args, **kwargs):
            if mutate:
                mutate(run)
            return await original(state, session, run, step, *args, **kwargs)
        with patch.object(self.bridge, '_run_kit_update_step', side_effect=before_stage):
            created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(self.spec())))
            self.assertEqual('ok', created['status'], created)
            started = json.loads(self.bridge._rpc_kitRun(self.session.id, created['kit']['id']))
            self.assertEqual('ok', started['status'], started)
            run = self.bridge._kit_get(self.session.id).runs[-1]
            # 临时子进程只写测试根，允许冷启动 Python 的时间。
            for _ in range(600):
                if run.status in {'waiting_approval', 'error', 'failed'}:
                    break
                await asyncio.sleep(.02)
            else:
                self.fail('fixture build did not settle')
        self.reader.assert_not_awaited()
        self.publish.assert_not_called()
        return run, run.steps[-1], run.steps[-1].config.get('capabilityRuntime', {})

    def receipt(self, run):
        return next(step.config['buildReceipt'] for step in run.steps if step.config.get('captureBuild'))

    async def test_local_build_needs_confirmation_and_actual_restart_without_network(self):
        config_before = self.manager.config_path.read_bytes()
        run, step, runtime = await self.run_update()
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        self.desktop.send.assert_not_awaited()
        self.assertEqual(['kit_call', 'command', 'awu_capability'], [s.type for s in run.steps])
        self.assertEqual('local_build', runtime['plan']['sourceKind'])
        self.assertNotIn('publishedRelease', runtime['plan'])
        self.assertNotIn('updateSource', runtime['plan'])
        original = Path(runtime['plan']['artifact']['url'])
        self.assertTrue(original.is_relative_to(self.workspace))
        self.assertEqual(original.read_bytes(), Path(self.manager.status()['stagedPath']).read_bytes())
        self.confirm(run, step, runtime)
        await self.until(lambda: run.status == 'waiting_restart')
        self.confirm(run, step, runtime)
        self.assertEqual(1, self.desktop.send.await_count)
        self.assertEqual('cannot_cancel', json.loads(self.bridge._rpc_kitCancel(self.session.id, run.id))['status'])
        durable_json(self.manager.journal.path(runtime['installRequestId']).with_suffix('.result.json'),
            dict(protocol=1, requestId=runtime['installRequestId'], identity=runtime['identity'],
                 planFingerprint=runtime['planFingerprint'], installation='succeeded', restart='started'))
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertNotEqual('succeeded', run.status)
        self.current = runtime['plan']['release'].copy()
        self.desktop_view['release'] = self.current.copy()
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.assertEqual('succeeded', run.status)
        self.assertFalse(self.manager.journal.active())
        self.assertEqual(config_before, self.manager.config_path.read_bytes())

    async def test_cancel_retains_build_and_only_releases_own_reservation(self):
        run, step, runtime = await self.run_update()
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        original = Path(runtime['plan']['artifact']['url'])
        content = original.read_bytes()
        self.bridge._rpc_kitCancel(self.session.id, run.id)
        self.assertEqual('cancelled', run.status)
        self.assertEqual(content, original.read_bytes())
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_changed_missing_foreign_and_old_builds_fail_before_approval(self):
        def change(run):
            Path(self.receipt(run)['candidate']['artifacts'][0]['path']).write_bytes(b'tampered')
        def missing(run):
            # 仅删除已核对在临时工作区中的 fixture 文件。
            path = Path(self.receipt(run)['candidate']['artifacts'][0]['path'])
            self.assertTrue(path.resolve().is_relative_to(self.workspace))
            path.unlink()
        def foreign(run):
            self.receipt(run)['runId'] = 'another-run'
        def old(run):
            candidate = self.receipt(run)['candidate']
            self.current = {k: candidate[k] for k in ('version', 'packageVersion', 'buildId', 'sequence')}
            self.desktop_view['release'] = self.current.copy()
        for mutate, reason in ((change, '改变'), (missing, '不存在'), (foreign, '不属于'), (old, '更新的版本')):
            with self.subTest(mutate=mutate.__name__):
                run, _, _ = await self.run_update(mutate)
                self.assertEqual('error', run.status, run.to_dict())
                self.assertIn(reason, run.error)
                self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_signature_policy_is_not_bypassed(self):
        self.manager.configure({'requireSignature': True, 'signatureKey': 'fixture-not-secret'})
        before = self.manager.config_path.read_bytes()
        run, _, _ = await self.run_update()
        self.assertEqual('error', run.status, run.to_dict())
        self.assertIn('signature', run.error)
        self.assertFalse(self.manager.journal.active())
        self.assertEqual(before, self.manager.config_path.read_bytes())
        self.desktop.send.assert_not_awaited()

    async def test_receipt_and_policy_drift_block_confirmation(self):
        run, step, runtime = await self.run_update()
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        receipt = self.receipt(run)
        original = copy.deepcopy(receipt)
        receipt['candidate']['buildId'] = 'changed'
        with self.assertRaisesRegex(Exception, '已变化'):
            self.confirm(run, step, runtime)
        receipt.clear(); receipt.update(original)
        config = json.loads(self.manager.config_path.read_text(encoding='utf-8'))
        config['requireSignature'] = True
        self.manager.config_path.write_text(json.dumps(config), encoding='utf-8')
        with self.assertRaisesRegex(Exception, '已变化'):
            self.confirm(run, step, runtime)
        self.desktop.send.assert_not_awaited()

    def add_second_installer(self):
        script = self.script.read_text(encoding='utf-8').replace(
            'register_build_receipt(ReleaseCenterManager()',
            "(root/'dist/AgentWithU_other_x64.msi').write_bytes(f'INERT second {seq}'.encode())\nregister_build_receipt(ReleaseCenterManager()")
        self.script.write_text(script, encoding='utf-8')

    async def test_multiple_installers_select_exact_local_build(self):
        self.add_second_installer()
        run, step, runtime = await self.run_update()
        self.assertEqual('needs_selection', runtime.get('phase'), run.to_dict())
        self.assertEqual(self.current, runtime['plan']['current'])
        artifact = runtime['plan']['artifacts'][1]
        args = (self.session.id, run.id, artifact['id'], runtime['planFingerprint'], 'select-local')
        self.bridge._rpc_kitUpdateSelect(*args)
        self.bridge._rpc_kitUpdateSelect(*args)
        await self.until(lambda: runtime['phase'] not in {'needs_selection', 'staging'})
        self.assertEqual('waiting_approval', runtime['phase'], run.to_dict())
        self.assertEqual(artifact['sha256'], runtime['plan']['artifact']['sha256'])
        self.assertEqual(artifact['url'], runtime['plan']['artifact']['url'])
        self.reader.assert_not_awaited()
        self.publish.assert_not_called()
        self.desktop.send.assert_not_awaited()

    async def test_selection_rejects_changed_receipt(self):
        self.add_second_installer()
        run, step, runtime = await self.run_update()
        self.assertEqual('needs_selection', runtime.get('phase'), run.to_dict())
        self.receipt(run)['candidate']['buildId'] = 'drift'
        self.bridge._rpc_kitUpdateSelect(self.session.id, run.id, runtime['plan']['artifacts'][0]['id'],
            runtime['planFingerprint'], 'select-local')
        await self.until(lambda: runtime['phase'] not in {'needs_selection', 'staging'})
        self.assertEqual('error', run.status)
        self.assertIn('已变化', run.error)
        self.assertFalse(self.manager.journal.active())
        self.desktop.send.assert_not_awaited()

    async def test_generation_and_nested_capture_validation(self):
        for objective in ('本机打包直接更新', '本机打包更新，不用上传', '本地构建安装，无需发布',
                          '本机打包更新，不需要再上传', 'local build and update without uploading'):
            self.assertTrue(local_build_requested(objective))
            self.assertFalse(requested(objective))
            preview = json.loads(await self.bridge._rpc_kitGenerate(self.session.id, json.dumps({'objective': objective})))
            self.assertTrue(preview['ready'], preview)
            self.assertEqual(2, len(preview['kit']['steps']))
            self.assertEqual(BUILD_UPDATE_CAPABILITY, preview['kit']['steps'][-1]['config']['capability'])
            self.assertNotIn('SSH', preview['kit']['implementationSummary'])
        for objective in ('打包上传并更新本机', '本机打包但不安装', '本机打包无需安装', '只构建', '检查更新'):
            self.assertFalse(local_build_requested(objective))
        state = self.bridge._kit_get(self.session.id)
        wrapper = WorkspaceKit.from_dict({'id': 'wrapper', 'title': 'nested', 'enabled': True,
            'steps': [{'id': 'inner', 'type': 'kit_call', 'kitId': self.build.id}]})
        state.kits.append(wrapper)
        spec = self.spec()
        spec['steps'][0]['kitId'] = wrapper.id
        kit = WorkspaceKit.from_dict(spec)
        self.assertEqual([], self.bridge._kit_definition_errors(state, kit))
        plan, errors = self.bridge._kit_build_plan(state, kit, {})
        self.assertEqual([], errors)
        self.assertEqual(1, sum(s.config.get('captureBuild') is True for s in plan))
        self.assertFalse(state.runs)
        self.reader.assert_not_awaited()

    async def test_client_build_is_not_offered_for_executor_install(self):
        self.build.execution_target = 'client'
        self.build.steps = [{'id': 'build', 'type': 'command', 'command': self.build.command}]
        result = build_template(self.bridge._kit_get(self.session.id), '本机打包直接更新', local_build=True)
        self.assertFalse(result['ready'])
        self.assertEqual([], result['candidates'])

    async def test_invalid_definitions_are_rejected_without_execution(self):
        for scenario in ('missing', 'multiple', 'publish', 'schedule', 'nonlast', 'duplicate', 'args', 'fake-capture'):
            spec = self.spec()
            if scenario == 'missing':
                spec['steps'][0].pop('captureBuild')
            elif scenario == 'multiple':
                spec['steps'].insert(0, {**copy.deepcopy(spec['steps'][0]), 'id': 'another-build'})
            elif scenario == 'publish':
                spec['steps'].insert(1, {'id': 'pub', 'type': 'awu_capability', 'config': {
                    'capability': 'release.publish_latest', 'arguments': {}}})
            elif scenario == 'schedule':
                spec['schedule'] = {'mode': 'interval', 'intervalSeconds': 60}
            elif scenario == 'nonlast':
                spec['steps'].append({'id': 'after', 'type': 'command', 'command': 'echo after'})
            elif scenario == 'duplicate':
                spec['steps'].append({**copy.deepcopy(spec['steps'][-1]), 'id': 'duplicate'})
            elif scenario == 'args':
                spec['steps'][-1]['config']['arguments'] = {'path': 'C:/arbitrary.msi'}
            else:
                spec['steps'][0] = {'id': 'fake', 'type': 'command', 'command': 'echo fake', 'config': {'captureBuild': True}}
            with self.subTest(scenario=scenario):
                result = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
                self.assertEqual('error', result['status'], result)
        self.assertFalse(self.bridge._kit_get(self.session.id).runs)

    async def test_manifest_rejects_outside_and_network_paths(self):
        run, _, runtime = await self.run_update()
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        receipt = copy.deepcopy(self.receipt(run))
        for path in (str(self.root / 'fixture.msi'), 'https://fixture.invalid/a.msi', r'\\server\share\a.msi'):
            receipt['candidate']['artifacts'][0]['path'] = path
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, '路径'):
                local_build_manifest(receipt, self.workspace)


if __name__ == '__main__':
    unittest.main()

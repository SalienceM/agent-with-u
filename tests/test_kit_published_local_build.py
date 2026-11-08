"""真实发布状态机 + 假上传，隔离本地包安装；不访问网络、不执行安装器。"""
import asyncio
import copy
import json
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tests import test_kit_local_update_chain as fixture
from src.backend import paths
from src.backend.kit_capabilities import BUILD_UPDATE_CAPABILITY
from src.backend.kit_update_template import build_template, local_build_requested
from src.backend.release_center import ReleaseCenterManager
from src.backend.update_manager import UpdateManager


class PublishedLocalBuildTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.LocalUpdateChainTests.asyncTearDown
    until = fixture.LocalUpdateChainTests.until
    test_second_confirmation_and_restart = fixture.LocalUpdateChainTests.test_chain_requires_second_confirmation_and_actual_restart
    test_cancel_keeps_publication = fixture.LocalUpdateChainTests.test_cancel_before_install_preserves_published_result
    test_busy_identity_permission_and_save_failure = fixture.LocalUpdateChainTests.test_busy_identity_permission_and_double_file_failure_never_notify
    test_failed_handoff_does_not_replay = fixture.LocalUpdateChainTests.test_failed_or_disconnected_handoff_never_replays_or_erases_publication

    async def asyncSetUp(self):
        await fixture.LocalUpdateChainTests.asyncSetUp(self)
        self.assertTrue(paths.data_root().resolve().is_relative_to(self.root.resolve()))
        self.updater = self.bridge._update_manager
        self.assertTrue(self.updater.root.resolve().is_relative_to(self.root.resolve()))
        self.manager.configure({'retentionCount': 0})
        self.updater.configure({'manifestUrl': ''})
        self.reader = AsyncMock(side_effect=AssertionError('本地安装不读取远端清单'))
        self.download = AsyncMock(side_effect=AssertionError('不得下载远端安装包'))
        self.upload = AsyncMock()
        self.before_install = None
        async def readback(source, manifest, **kwargs):
            return copy.deepcopy(manifest)
        async def publish(job_id, plan):
            self.publish_count += 1
            await ReleaseCenterManager._run_publish(self.manager, job_id, plan)
        original = self.bridge._run_kit_update_step
        async def install(state, session, run, step, *args, **kwargs):
            if self.before_install:
                self.before_install(run)
            return await original(state, session, run, step, *args, **kwargs)
        patches = [
            patch.dict(os.environ, {'AGENT_WITH_U_UPDATE_KEY': '', 'AGENT_WITH_U_UPDATE_SIGNING_KEY': ''}),
            patch.object(self.manager, '_run_publish', side_effect=publish),
            patch.object(self.manager, '_upload', self.upload),
            patch.object(self.manager, '_refresh_cdn', new=AsyncMock()),
            patch.object(self.manager, '_verify_published_manifest', side_effect=readback),
            patch.object(self.updater, '_read_source', self.reader),
            patch('src.backend.update_download.download_http', self.download),
            patch.object(self.updater, '_artifact_url', UpdateManager._artifact_url.__get__(self.updater)),
            patch.object(self.bridge, '_run_kit_update_step', side_effect=install),
        ]
        for module in ('kit_update_bridge', 'update_manager'):
            patches.append(patch(f'src.backend.{module}._current_release', return_value=self.desktop_view['release']))
        for stub in patches:
            stub.start(); self.addCleanup(stub.stop)

    def spec(self):
        spec = build_template(self.bridge._kit_get(self.session.id), '本机打包发布后本地安装，不重新下载', local_build=True)['kit']
        spec['steps'][1]['config']['arguments']['kinds'] = ['msi']
        return spec

    async def start(self, spec=None):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec or self.spec())))
        self.assertEqual('ok', created['status'], created)
        self.bridge._rpc_kitRun(self.session.id, created['kit']['id'])
        run = self.bridge._kit_get(self.session.id).runs[-1]
        await self.until(lambda: run.status in {'waiting_approval', 'error', 'failed'})
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        self.assertEqual('release.publish_latest', run.steps[run.current_step].config.get('capability'))
        self.assertEqual(0, self.publish_count)
        self.assertIsNone(self.updater._selection)
        return run

    async def finish_publish(self, run):
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, run.steps[run.current_step].id, True)
        await self.until(lambda: (run.current_step == len(run.steps) - 1 and run.status == 'waiting_approval')
                         or run.status in {'error', 'failed'})
        self.reader.assert_not_awaited()
        self.download.assert_not_awaited()
        self.assertEqual([], self.desktop.notifications)
        return run.steps[-1]

    async def prepared(self):
        before = self.updater.config_path.read_bytes()
        run = await self.start()
        step = await self.finish_publish(run)
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        plan = step.config['capabilityRuntime']['plan']
        self.assertEqual('stable', plan['channel'])
        self.assertEqual('local_build', plan['sourceKind'])
        self.assertEqual(run.id, plan['publishedRelease']['runId'])
        self.assertEqual('succeeded', run.steps[-2].status)
        self.assertEqual(before, self.updater.config_path.read_bytes())
        if 'artifact' in plan:
            source = Path(plan['artifact']['url'])
            self.assertTrue(source.resolve().is_relative_to(self.workspace.resolve()))
            self.assertEqual(source.read_bytes(), Path(self.updater.status()['stagedPath']).read_bytes())
        return run, step

    async def test_signed_publication_uses_local_bytes(self):
        self.updater.configure({'requireSignature': True, 'signatureKey': 'fixture-only'})
        with patch.dict(os.environ, {'AGENT_WITH_U_UPDATE_SIGNING_KEY': 'fixture-only'}):
            run, step = await self.prepared()
        self.assertTrue(self.updater._selection['signed'])
        self.assertEqual(3, self.upload.await_count)  # 制品及两份清单；只上传一次制品。
        self.assertEqual('waiting_approval', step.config['capabilityRuntime']['phase'])

    async def test_missing_signature_rejected_without_policy_change(self):
        self.updater.configure({'requireSignature': True, 'signatureKey': 'fixture-only'})
        before = self.updater.config_path.read_bytes()
        run = await self.start()
        await self.finish_publish(run)
        self.assertEqual('error', run.status, run.to_dict())
        self.assertIn('signature', run.error)
        self.assertEqual(before, self.updater.config_path.read_bytes())

    async def test_wrong_signature_rejected(self):
        self.updater.configure({'requireSignature': True, 'signatureKey': 'fixture-only'})
        with patch.dict(os.environ, {'AGENT_WITH_U_UPDATE_SIGNING_KEY': 'fixture-wrong'}):
            run = await self.start()
            await self.finish_publish(run)
        self.assertEqual('error', run.status, run.to_dict())
        self.assertIn('signature verification failed', run.error)

    async def test_publish_failure_skips_local_install(self):
        self.upload.side_effect = OSError('fixture upload failed')
        run = await self.start()
        step = await self.finish_publish(run)
        self.assertEqual('error', run.status)
        self.assertEqual('skipped', step.status)
        self.assertNotIn('capabilityRuntime', step.config)
        self.assertFalse(self.updater.journal.active())

    async def assert_bad_source(self, mutate, reason):
        self.before_install = mutate
        run = await self.start()
        await self.finish_publish(run)
        self.assertEqual('error', run.status, run.to_dict())
        self.assertIn(reason, run.error)
        self.assertEqual('succeeded', run.steps[-2].status)
        self.assertFalse(self.updater.journal.active())

    async def test_missing_local_installer_never_downloads(self):
        def remove(run):
            path = self.workspace / 'dist/AgentWithU_x64.msi'
            self.assertTrue(path.resolve().is_relative_to(self.root.resolve()))
            path.unlink()
        await self.assert_bad_source(remove, '不存在')

    async def test_tampered_local_installer_never_downloads(self):
        await self.assert_bad_source(lambda run: (self.workspace / 'dist/AgentWithU_x64.msi').write_bytes(b'changed'), '改变')

    async def test_foreign_publication_is_rejected(self):
        await self.assert_bad_source(lambda run: run.steps[-2].config['capabilityRuntime'].update(planFingerprint='wrong'), '不匹配')

    async def test_modified_uploaded_manifest_is_rejected(self):
        def mutate(run):
            runtime = run.steps[-2].config['capabilityRuntime']
            path = self.manager.generated_dir / runtime['jobId'] / 'manifest.json'
            document = json.loads(path.read_text(encoding='utf-8'))
            document['release']['buildId'] = 'other'
            path.write_text(json.dumps(document), encoding='utf-8')
        await self.assert_bad_source(mutate, '摘要不匹配')

    async def test_published_artifact_must_match_local_build(self):
        original = self.updater.stage_published_local_build
        async def changed(local, published, manifest, *args, **kwargs):
            local['artifacts'][0]['sha256'] = 'b' * 64
            return await original(local, published, manifest, *args, **kwargs)
        with patch.object(self.updater, 'stage_published_local_build', side_effect=changed):
            await self.assert_bad_source(lambda run: None, '制品与本次本机构建不一致')

    async def test_published_release_must_match_local_build(self):
        original = self.updater.stage_published_local_build
        async def changed(local, published, manifest, *args, **kwargs):
            local['release']['packageVersion'] = 'other'
            return await original(local, published, manifest, *args, **kwargs)
        with patch.object(self.updater, 'stage_published_local_build', side_effect=changed):
            await self.assert_bad_source(lambda run: None, '发布版本与本次本机构建不一致')

    async def test_confirmation_rechecks_publication_binding(self):
        run, step = await self.prepared()
        run.steps[-2].config['capabilityRuntime']['planFingerprint'] = 'changed'
        runtime = step.config['capabilityRuntime']
        with self.assertRaisesRegex(Exception, '不匹配'):
            self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, step.id, True,
                runtime['planFingerprint'], 'confirmation')
        self.assertEqual([], self.desktop.notifications)

    def add_second_installer(self):
        script = self.workspace / 'register_release_candidate.py'
        script.write_text(script.read_text(encoding='utf-8').replace(
            'register_build_receipt(ReleaseCenterManager()',
            "(root/'dist/AgentWithU_other_x64.msi').write_bytes(b'inert second')\nregister_build_receipt(ReleaseCenterManager()"), encoding='utf-8')

    async def test_multiple_installers_require_selection(self):
        self.add_second_installer()
        run, step = await self.prepared()
        runtime = step.config['capabilityRuntime']
        self.assertEqual('needs_selection', runtime['phase'])
        self.assertIsNone(self.updater._selection)
        artifact = runtime['plan']['artifacts'][1]
        self.bridge._rpc_kitUpdateSelect(self.session.id, run.id, artifact['id'], runtime['planFingerprint'], 'choose')
        await self.until(lambda: runtime['phase'] not in {'needs_selection', 'staging'})
        self.assertEqual('waiting_approval', runtime['phase'], run.to_dict())
        self.assertEqual(artifact, runtime['plan']['artifact'])
        self.reader.assert_not_awaited(); self.download.assert_not_awaited()

    async def test_selection_rechecks_publication(self):
        self.add_second_installer()
        run, step = await self.prepared()
        runtime = step.config['capabilityRuntime']
        run.steps[-2].config['capabilityRuntime']['planFingerprint'] = 'changed'
        self.bridge._rpc_kitUpdateSelect(self.session.id, run.id, runtime['plan']['artifacts'][0]['id'],
            runtime['planFingerprint'], 'choose')
        await self.until(lambda: run.status == 'error')
        self.assertIsNone(self.updater._selection)
        self.assertEqual([], self.desktop.notifications)
        self.reader.assert_not_awaited(); self.download.assert_not_awaited()

    async def test_only_published_subset_is_offered(self):
        self.add_second_installer()
        script = self.workspace / 'register_release_candidate.py'
        script.write_text(script.read_text(encoding='utf-8').replace('AgentWithU_other_x64.msi', 'AgentWithU_other_x64-setup.exe'), encoding='utf-8')
        spec = self.spec()
        spec['steps'][1]['config']['arguments']['kinds'] = ['nsis']
        run = await self.start(spec)
        step = await self.finish_publish(run)
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        runtime = step.config['capabilityRuntime']
        self.assertEqual('waiting_approval', runtime['phase'])
        self.assertEqual('nsis', runtime['plan']['artifact']['kind'])
        self.assertEqual(1, len(runtime['plan']['publishedRelease']['artifacts']))
        self.assertTrue((self.workspace / 'dist/AgentWithU_x64.msi').exists())

    async def test_default_publishes_only_nsis_then_installs_the_same_local_package(self):
        self.add_second_installer()
        script = self.workspace / 'register_release_candidate.py'
        script.write_text(script.read_text(encoding='utf-8').replace('AgentWithU_other_x64.msi', 'AgentWithU_other_x64-setup.exe'), encoding='utf-8')
        spec = self.spec()
        spec['steps'][1]['config']['arguments'].pop('kinds')
        run = await self.start(spec)
        frozen = run.steps[run.current_step].config['capabilityRuntime']['plan']['artifacts']
        self.assertEqual(['nsis'], [item['kind'] for item in frozen])
        step = await self.finish_publish(run)
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        plan = step.config['capabilityRuntime']['plan']
        self.assertEqual('nsis', plan['artifact']['kind'])
        self.assertEqual(1, len(plan['publishedRelease']['artifacts']))
        self.assertEqual(3, self.upload.await_count)  # 一份安装包 + 两份清单，未上传 MSI。
        self.assertTrue((self.workspace / 'dist/AgentWithU_x64.msi').exists())
        self.reader.assert_not_awaited(); self.download.assert_not_awaited()

    async def test_generation_and_sequence_constraints(self):
        for objective in ('本机打包发布后本地安装', '本机打包上传并更新，不用再从远端拉',
                          'local build publish and update without downloading'):
            self.assertTrue(local_build_requested(objective))
            preview = json.loads(await self.bridge._rpc_kitGenerate(self.session.id, json.dumps({'objective': objective})))
            self.assertTrue(preview['ready'], preview)
            self.assertEqual(3, len(preview['kit']['steps']))
            self.assertEqual(BUILD_UPDATE_CAPABILITY, preview['kit']['steps'][-1]['config']['capability'])
            self.assertNotIn('SSH', preview['kit']['implementationSummary'])
            self.assertIn('不重新下载', preview['kit']['implementationSummary'])
        for case in ('unbound', 'duplicate', 'before-build'):
            spec = self.spec()
            if case == 'unbound': spec['steps'][1]['config']['arguments'].pop('bindBuild')
            elif case == 'duplicate': spec['steps'].insert(2, {**copy.deepcopy(spec['steps'][1]), 'id': 'second-publish'})
            else: spec['steps'][0], spec['steps'][1] = spec['steps'][1], spec['steps'][0]
            result = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(spec)))
            self.assertEqual('error', result['status'], result)
        self.assertEqual([], self.bridge._kit_get(self.session.id).runs)


if __name__ == '__main__':
    unittest.main()

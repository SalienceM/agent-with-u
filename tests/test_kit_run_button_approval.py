"""仅隔离临时数据、假桌面和假发布；测试不会安装、退出或访问真实更新源。"""
import json
import unittest
from unittest.mock import patch

from tests import test_kit_standalone_update as standalone
from tests import test_kit_published_local_build as publication
from src.backend.kit_update_template import standalone_template
from src.backend.workspace_kit_store import KitRun


class ButtonUpdateTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = standalone.StandaloneUpdateTests.asyncSetUp
    asyncTearDown = standalone.StandaloneUpdateTests.asyncTearDown
    until = standalone.StandaloneUpdateTests.until

    def preview(self):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(standalone_template()['kit'])))
        self.assertEqual('ok', created['status'], created)
        kit_id = created['kit']['id']
        result = json.loads(self.bridge._rpc_kitRunPreview(self.session.id, kit_id))
        self.assertEqual('ok', result['status'], result)
        self.assertEqual([], self.bridge._kit_get(self.session.id).runs)
        self.assertFalse(self.manager.journal.active())
        self.reader.assert_not_awaited()
        self.assertIn('fixture-device', result['actions'][0])
        return kit_id, result['previewId']

    def start(self, kit_id, token):
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', token))
        self.assertEqual('ok', result['status'], result)
        return self.bridge._kit_get(self.session.id).runs[-1]

    async def test_button_approves_install_once_and_persists_scope(self):
        kit_id, token = self.preview()
        run = self.start(kit_id, token)
        duplicate = self.start(kit_id, token)
        self.assertIs(run, duplicate)
        self.assertEqual(1, len(self.bridge._kit_get(self.session.id).runs))
        await self.until(lambda: run.status in {'waiting_restart', 'waiting_approval', 'failed', 'error'})
        self.assertEqual('waiting_restart', run.status, run.to_dict())
        self.desktop.send.assert_awaited_once()
        runtime = run.steps[-1].config['capabilityRuntime']
        self.assertEqual('run_button', runtime['approval']['source'])
        self.assertEqual(runtime['planFingerprint'], run.button_approval['plans'][run.steps[-1].id])
        self.assertEqual(run.button_approval, KitRun.from_dict(run.to_dict()).button_approval)
        self.bridge._rpc_kitUpdateReconcile(self.session.id, run.id)
        self.desktop.send.assert_awaited_once()
        self.assertNotEqual('succeeded', run.status)

    async def test_changed_device_or_source_rejects_before_start(self):
        kit_id, token = self.preview()
        self.desktop_view['instanceId'] = 'different'
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', token))
        self.assertEqual('error', result['status'])
        self.assertIn('变化', result['message'])
        self.assertEqual([], self.bridge._kit_get(self.session.id).runs)
        self.desktop.send.assert_not_awaited()

    async def test_expired_preview_and_ai_cannot_consume_button_scope(self):
        kit_id, token = self.preview()
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'ai', token))
        self.assertEqual('error', result['status'])
        self.bridge._kit_run_previews[token]['expiresAt'] = 0
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', token))
        self.assertEqual('error', result['status'])
        self.assertEqual([], self.bridge._kit_get(self.session.id).runs)

    async def test_busy_does_not_skip_barrier_or_retry_install(self):
        kit_id, token = self.preview()
        run = self.start(kit_id, token)
        with patch.object(self.bridge, '_begin_update_handoff', side_effect=RuntimeError('另一个任务仍在运行')):
            await self.until(lambda: run.status in {'waiting_approval', 'failed', 'error'})
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        self.assertIn('另一个任务', run.button_approval['invalidated'])
        self.desktop.send.assert_not_awaited()
        runtime = run.steps[-1].config['capabilityRuntime']
        self.assertFalse(self.manager.journal.get(runtime['installRequestId']).get('confirmationId'))
        self.bridge._rpc_kitCapabilityRespond(self.session.id, run.id, run.steps[-1].id, True,
            runtime['planFingerprint'], 'explicit-human-confirmation')
        await self.until(lambda: run.status == 'waiting_restart')
        self.desktop.send.assert_awaited_once()

    async def test_multiple_artifacts_still_require_selection_then_use_button_approval(self):
        kit_id, token = self.preview()
        self.document['artifacts'].append({**self.document['artifacts'][0], 'id': 'msi-b'})
        run = self.start(kit_id, token)
        await self.until(lambda: run.status == 'waiting_approval')
        runtime = run.steps[-1].config['capabilityRuntime']
        self.assertEqual('needs_selection', runtime['phase'])
        self.desktop.send.assert_not_awaited()
        self.bridge._rpc_kitUpdateSelect(self.session.id, run.id, 'msi-b', runtime['planFingerprint'], 'explicit-selection')
        await self.until(lambda: run.status == 'waiting_restart')
        self.assertEqual('msi-b', runtime['plan']['artifact']['id'])
        self.desktop.send.assert_awaited_once()

    async def test_expired_grant_waits_at_actual_plan(self):
        kit_id, token = self.preview()
        run = self.start(kit_id, token)
        run.button_approval['expiresAt'] = 0
        await self.until(lambda: run.status == 'waiting_approval')
        self.assertIn('过期', run.button_approval['invalidated'])
        self.desktop.send.assert_not_awaited()

    async def test_unknown_handoff_is_not_replayed_by_readback(self):
        kit_id, token = self.preview()
        self.desktop.send.side_effect = RuntimeError('连接断开，发送结果未知')
        run = self.start(kit_id, token)
        await self.until(lambda: run.status == 'result_unknown')
        self.bridge._rpc_kitUpdateReconcile(self.session.id, run.id)
        self.bridge._rpc_kitResume(self.session.id, run.id)
        self.desktop.send.assert_awaited_once()
        self.assertTrue(self.manager.journal.active())


class ButtonPublicationTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = publication.PublishedLocalBuildTests.asyncSetUp
    asyncTearDown = publication.PublishedLocalBuildTests.asyncTearDown
    until = publication.PublishedLocalBuildTests.until
    spec = publication.PublishedLocalBuildTests.spec

    async def test_build_publish_install_run_without_second_confirmation(self):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(self.spec())))
        kit_id = created['kit']['id']
        preview = json.loads(self.bridge._rpc_kitRunPreview(self.session.id, kit_id))
        self.assertEqual('ok', preview['status'], preview)
        self.assertEqual(2, len(preview['actions']))
        self.assertIn('fake / stable', preview['actions'][0])
        self.assertIn('本次构建产物', preview['actions'][0])
        self.assertEqual(0, self.publish_count)
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', preview['previewId']))
        self.assertEqual('ok', result['status'], result)
        run = self.bridge._kit_get(self.session.id).runs[-1]
        await self.until(lambda: run.status in {'waiting_restart', 'failed', 'error'} or bool(run.button_approval.get('invalidated')))
        self.assertEqual('waiting_restart', run.status, run.to_dict())
        self.assertEqual(1, self.publish_count)
        self.assertEqual(1, len(self.desktop.notifications))
        self.reader.assert_not_awaited()
        self.download.assert_not_awaited()
        for step in run.steps[-2:]:
            self.assertEqual('run_button', step.config['capabilityRuntime']['approval']['source'])

    async def test_nested_kit_change_invalidates_preview_without_running(self):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(self.spec())))
        kit_id = created['kit']['id']
        preview = json.loads(self.bridge._rpc_kitRunPreview(self.session.id, kit_id))
        self.assertEqual('ok', preview['status'], preview)
        self.build.command += '; Write-Output changed'
        result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', preview['previewId']))
        self.assertEqual('error', result['status'], result)
        self.assertEqual([], self.bridge._kit_get(self.session.id).runs)
        self.assertEqual(0, self.publish_count)

    async def test_changed_publication_config_after_build_waits_without_publishing(self):
        created = json.loads(self.bridge._rpc_kitCreate(self.session.id, json.dumps(self.spec())))
        kit_id = created['kit']['id']
        preview = json.loads(self.bridge._rpc_kitRunPreview(self.session.id, kit_id))
        original = self.bridge._kit_capabilities.prepare
        async def prepare(capability, arguments, context):
            if capability == 'release.publish_latest':
                self.manager.configure({'qiniuBucket': 'changed-bucket'})
            return await original(capability, arguments, context)
        with patch.object(self.bridge._kit_capabilities, 'prepare', side_effect=prepare):
            result = json.loads(self.bridge._rpc_kitRun(self.session.id, kit_id, '{}', 'human', preview['previewId']))
            self.assertEqual('ok', result['status'], result)
            run = self.bridge._kit_get(self.session.id).runs[-1]
            await self.until(lambda: run.status in {'waiting_approval', 'error', 'failed'})
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        self.assertIn('变化', run.button_approval['invalidated'])
        self.assertEqual(0, self.publish_count)
        self.assertEqual([], self.desktop.notifications)

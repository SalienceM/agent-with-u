"""运行按钮的一次性人工授权；与聊天委托隔离，不能跳过真实计划/安装核验。"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from .kit_capabilities import LOCAL_UPDATE_CAPABILITIES, CHECK_UPDATE_CAPABILITY, ReleasePublishLatestCapability
from .kit_update_journal import fingerprint
from .release_center import _safe_id, _safe_key
from .workspace_kit_store import resolve_kit_inputs


class KitRunApprovalBridge:
    def _kit_run_action_scope(self, session: Any, step: Any) -> dict[str, Any]:
        capability = step.config.get('capability')
        arguments = step.config.get('arguments') or {}
        scope = {'capability': capability, 'arguments': arguments}
        if capability == 'release.publish_latest':
            config = {**self._release_center()._config(), **{key: value for key, value in arguments.items()
                      if key in {'channel', 'baseUrl', 'qiniuBucket', 'prefix', 'manifestKey',
                                 'stableManifestUrl', 'requireSignature'}}}
            project = ReleasePublishLatestCapability._project_root(arguments, Path(session.working_dir).resolve())
            channel = _safe_id(config.get('channel'), 'stable')[:40]
            prefix = _safe_key(config.get('prefix'), 'agentwithu/releases') or 'agentwithu/releases'
            manifest_key = _safe_key(config.get('manifestKey'), f'{prefix}/{channel}/manifest.json') or f'{prefix}/{channel}/manifest.json'
            scope.update(project=str(project), channel=channel, manifestKey=manifest_key,
                         bucket=str(config.get('qiniuBucket') or '').strip(), baseUrl=str(config.get('baseUrl') or '').strip(),
                         retentionCount=config.get('retentionCount') or 0,
                         configFingerprint=fingerprint({**config,
                             'signingKey': os.environ.get('AGENT_WITH_U_UPDATE_SIGNING_KEY', '')}))
        elif capability in LOCAL_UPDATE_CAPABILITIES:
            _client, desktop = self._kit_desktop()
            config = self._update_manager._config()
            scope.update(desktop=desktop, policyFingerprint=self._update_manager._kit_source_fingerprint())
            if capability == CHECK_UPDATE_CAPABILITY:
                scope.update(manifestUrl=config['manifestUrl'], channel=config['channel'])
        return scope

    def _kit_run_approval_snapshot(self, session: Any, kit: Any, inputs: dict, steps: list) -> dict:
        if any(step.type == 'awu_capability' for step in steps):
            self._require_node_update_capability()
        scopes = {step.id: self._kit_run_action_scope(session, step) for step in steps
                  if step.type == 'awu_capability' and (step.config.get('capability') == 'release.publish_latest'
                      or step.config.get('capability') in LOCAL_UPDATE_CAPABILITIES)}
        return {'ownerId': self._current_owner_id(), 'sessionId': session.id, 'kitId': kit.id,
                'workspace': str(Path(session.working_dir).resolve()), 'scopes': scopes,
                'definition': fingerprint({'inputs': inputs, 'steps': [step.to_dict() for step in steps]})}

    def _rpc_kitRunPreview(self, session_id: str, kit_id: str, inputs_json: str = '{}') -> str:
        """只读展开运行范围，不构建、不预留更新、不启动发布。预览仅短暂保存在内存。"""
        self._require_session_access(session_id)
        self._require_update_work_allowed()
        try:
            state = self._kit_get(session_id)
            kit = self._kit_find(state, state.canonical_chain_id(kit_id))
            session = self._kit_session(session_id)
            if not kit or not kit.enabled or not session:
                raise ValueError('Kit 不存在或已停用')
            supplied = json.loads(inputs_json)
            if not isinstance(supplied, dict):
                raise ValueError('Kit 输入必须是对象')
            inputs, errors = resolve_kit_inputs(kit, supplied, state)
            steps, plan_errors = self._kit_build_plan(state, kit, inputs)
            if errors or plan_errors:
                raise ValueError('；'.join(errors + plan_errors))
            snapshot = self._kit_run_approval_snapshot(session, kit, inputs, steps)
            actions = []
            for step_id, scope in snapshot['scopes'].items():
                capability = scope['capability']
                if capability == 'release.publish_latest':
                    source = '本次构建产物' if scope['arguments'].get('bindBuild') else '执行时该项目的最新候选包'
                    filters = '；'.join(f'{key}: {value}' for key, value in scope['arguments'].items()
                                       if key in {'platforms', 'archs', 'targets', 'kinds', 'artifactIds'})
                    actions.append(f"发布{source} → {scope['bucket'] or '未配置 Bucket'} / {scope['channel']}\n"
                                   f"项目：{scope['project']}\n地址：{scope['baseUrl'] or '未配置'} / {scope['manifestKey']}"
                                   + (f'\n制品筛选：{filters}' if filters else '')
                                   + (f"\n发布后保留最近 {scope['retentionCount']} 个版本" if scope['retentionCount'] else ''))
                else:
                    source = (f"已配置更新源 {scope['manifestUrl']}（{scope['channel']}）"
                              if capability == CHECK_UPDATE_CAPABILITY else '本次流程的已核验安装包')
                    actions.append(f"安装并重启执行设备 {scope['desktop']['deviceId']}\n来源：{source}\n"
                                   '优先复用匹配的本机安装包；安装会退出该设备的桌面与 Backend。')
            preview_id = uuid.uuid4().hex if actions else ''
            if actions:
                pending = getattr(self, '_kit_run_previews', {})
                pending = {key: value for key, value in pending.items() if value['expiresAt'] > time.time()}
                if len(pending) >= 100:
                    raise ValueError('运行确认过多，请稍后重试')
                pending[preview_id] = {'snapshot': snapshot, 'expiresAt': time.time() + 600,
                                      'requestFingerprint': fingerprint(supplied)}
                self._kit_run_previews = pending
            return json.dumps({'status': 'ok', 'previewId': preview_id, 'actions': actions}, ensure_ascii=False)
        except (ValueError, RuntimeError, PermissionError) as error:
            return json.dumps({'status': 'error', 'message': str(error)}, ensure_ascii=False)

    def _kit_run_button_approval(self, preview_id: str, session: Any, kit: Any, inputs: dict,
                                supplied: dict, steps: list, run_id: str) -> dict:
        preview = getattr(self, '_kit_run_previews', {}).get(preview_id)
        if not preview or preview['expiresAt'] <= time.time():
            raise ValueError('运行确认已失效，请重新点击运行')
        current = self._kit_run_approval_snapshot(session, kit, inputs, steps)
        if current != preview['snapshot'] or fingerprint(supplied) != preview['requestFingerprint']:
            raise ValueError('Kit、输入、发布配置或目标设备已变化，请重新确认')
        secret_keys = [spec['key'] for spec in kit.inputs if spec.get('type') == 'secret']
        return {'source': 'run_button', 'previewId': preview_id, 'runId': run_id,
                'ownerId': current['ownerId'], 'sessionId': session.id, 'kitId': kit.id,
                'workspace': current['workspace'], 'scopes': current['scopes'], 'plans': {},
                'requestFingerprint': fingerprint({key: '••••••' if key in secret_keys else value
                                                   for key, value in supplied.items()}),
                'secretInputs': secret_keys,
                'approvedAt': time.time(), 'expiresAt': time.time() + 86400}

    def _kit_button_approval(self, state: Any, session: Any, run: Any, step: Any) -> dict | None:
        """每步只绑定第一次冻结计划；变化或异常撤销自动授权，保留具体步骤的人工入口。"""
        grant = run.button_approval
        if not grant or step.id not in grant.get('scopes', {}):
            return None
        runtime = step.config.get('capabilityRuntime') or {}
        try:
            if grant.get('invalidated'):
                return None
            if (grant.get('source') != 'run_button' or run.trigger != 'manual' or run.owner != 'human'
                    or grant.get('runId') != run.id or grant.get('kitId') != run.kit_id
                    or grant.get('sessionId') != session.id
                    or grant.get('ownerId') != self._current_owner_id()
                    or grant.get('ownerId') != self._session_owner_id(session.id)
                    or grant.get('workspace') != str(Path(session.working_dir).resolve())
                    or grant.get('expiresAt', 0) < time.time()):
                raise ValueError('运行前确认已过期或归属发生变化')
            self._require_node_update_capability()
            if self._kit_run_action_scope(session, step) != grant['scopes'][step.id]:
                raise ValueError('发布配置、更新源或目标设备已变化')
            if step.config.get('capability') == 'release.publish_latest':
                scope = grant['scopes'][step.id]
                actual = runtime.get('plan') or {}
                if any(actual.get(field) != scope[key] for field, key in
                       (('channel', 'channel'), ('qiniuBucket', 'bucket'), ('manifestKey', 'manifestKey'))):
                    raise ValueError('实际发布目的地与运行前确认不一致')
            plan = runtime.get('planFingerprint')
            if not plan or grant['plans'].get(step.id, plan) != plan:
                raise ValueError('具体执行计划已变化')
            grant['plans'][step.id] = plan
            self._kit_save(state)
            return {'source': 'run_button', 'previewId': grant['previewId'],
                    'requestId': fingerprint([grant['previewId'], step.id]), 'approvedAt': grant['approvedAt']}
        except (ValueError, RuntimeError, PermissionError) as error:
            grant['invalidated'] = str(error)
            runtime['message'] = f'运行前确认已停止自动继续：{error}。请核对当前计划后确认。'
            self._kit_save(state)
            return None

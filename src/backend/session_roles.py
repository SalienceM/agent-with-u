"""节点内角色模板；模板只描述职责和路由，不携带 Session 权限。"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .session_collaboration_store import CollaborationError, identifier
from .text_only import TEXT_ONLY_BACKENDS


def role_profile(raw: Any) -> dict:
    fields = {'id', 'name', 'instructions', 'backendId', 'runtime', 'enabled', 'archived'}
    if not isinstance(raw, dict) or set(raw) - fields:
        raise CollaborationError('角色字段无效；不接受节点、工作目录或授权字段')
    result = {}
    for key, maximum in [('name', 80), ('instructions', 8000), ('backendId', 200)]:
        value = raw.get(key, '')
        if not isinstance(value, str) or len(value) > maximum or '\x00' in value:
            raise CollaborationError(f'角色 {key} 无效')
        result[key] = value.strip()
    if not result['name'] or not result['instructions']:
        raise CollaborationError('请填写角色名称和职责')
    for key, default in [('enabled', True), ('archived', False)]:
        if type(raw.get(key, default)) is not bool:
            raise CollaborationError('角色状态无效')
        result[key] = raw.get(key, default)
    runtime = raw.get('runtime', {})
    if not isinstance(runtime, dict) or set(runtime) - {'model', 'reasoningEffort'}:
        raise CollaborationError('角色运行参数无效')
    result['runtime'] = {}
    for key, value in runtime.items():
        if not isinstance(value, str) or len(value) > 160 or any(ord(c) < 32 for c in value):
            raise CollaborationError('角色运行参数无效')
        value = value.strip()
        if key == 'reasoningEffort' and value and not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', value):
            raise CollaborationError('推理档位格式无效')
        if value:
            result['runtime'][key] = value
    if result['archived']:
        result['enabled'] = False
    result['id'] = identifier(raw['id']) if raw.get('id') else uuid.uuid4().hex
    return result


class SessionRoles:
    def _role_route(self, source: Any, role: dict) -> tuple[Any, dict]:
        backend_id = role.get('backendId') or source.backend_id
        config = next((item for item in self._backend_configs if item.id == backend_id and item.enabled), None)
        if config is None:
            raise CollaborationError('角色 Backend 在本节点不可用，请明确选择有效 Backend')
        kind = getattr(config.type, 'value', config.type)
        from .poe_api import is_poe_api_base_url
        if kind not in TEXT_ONLY_BACKENDS or kind == 'openai-compatible' and is_poe_api_base_url(config.base_url):
            raise CollaborationError('该 Backend 不支持受控角色评议')
        runtime = dict(self._session_runtime(source)) if not role.get('backendId') else {}
        runtime.update(role.get('runtime') or {})
        if runtime.get('model') and kind not in {'codex-office', 'qwen-code-cli', 'deepseek-harness'}:
            raise CollaborationError('该 Backend 不支持 Session 模型覆盖，请在 Backend 配置中选择模型')
        if runtime.get('reasoningEffort') and kind not in {'codex-office', 'deepseek-harness'}:
            raise CollaborationError('该 Backend 不支持推理档位')
        if kind == 'deepseek-harness' and runtime.get('reasoningEffort'):
            from .deepseek_harness_config import REASONING_EFFORTS
            if runtime['reasoningEffort'] not in REASONING_EFFORTS:
                raise CollaborationError('Harness 不支持该推理档位')
        return config, runtime

    def _rpc_roleProfileSave(self, session_id: str, request_id: str, profile_json: str, expected_revision: int = 0) -> str:
        self._window_guard(session_id)
        source = self._collaboration_session(session_id)
        raw = json.loads(profile_json)
        # 新建 id 从 requestId 确定，重发同一请求不会创建第二个模板。
        if isinstance(raw, dict) and not raw.get('id'):
            raw['id'] = 'role-' + uuid.uuid5(uuid.NAMESPACE_URL, identifier(request_id)).hex
        profile = role_profile(raw)
        if type(expected_revision) is not int or expected_revision < 0:
            raise CollaborationError('角色修订无效')
        if profile['enabled']:
            self._role_route(source, profile)
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        receipt, created = store.begin_request(scope, request_id, 'roleSave', {'sessionId': session_id, 'profile': profile, 'expectedRevision': expected_revision})
        if not created:
            return self._rpc_roleProfileSaveStatus(session_id, request_id)
        old = store.read(scope, 'role', profile['id'])
        if (old or {}).get('revision', 0) != expected_revision:
            result = {'state': 'rejected', 'reason': '角色已变化，请重新读取后编辑'}
            store.finish_request(scope, request_id, receipt['revision'], 'failed', result)
            return json.dumps(result, ensure_ascii=False)
        saved = store.write(scope, 'role', profile['id'], {**profile, 'lastRequestId': request_id}, expected_revision)
        result = {'state': 'succeeded', 'role': saved}
        store.finish_request(scope, request_id, receipt['revision'], 'succeeded', result)
        self._emit_event('roleProfilesChanged', {'sessionId': session_id, 'id': saved['id'], 'revision': saved['revision']})
        return json.dumps(result, ensure_ascii=False)

    def _rpc_roleProfileSaveStatus(self, session_id: str, request_id: str) -> str:
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        receipt = store.request(scope, request_id)
        if not receipt or receipt['sessionId'] != session_id or receipt['kind'] != 'roleSave':
            raise CollaborationError('角色保存请求不可用')
        # 回执可能晚于模板保存；未知时只查询，不重写模板。
        if receipt['status'] in {'succeeded', 'failed'}:
            return json.dumps(receipt['result'], ensure_ascii=False)
        return json.dumps({'state': 'unknown', 'reason': '保存结果未知，请刷新角色库核对；没有重复保存'}, ensure_ascii=False)

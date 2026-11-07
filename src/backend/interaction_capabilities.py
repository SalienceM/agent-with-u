"""按运行模式声明已适配契约；不通过猜测版本添加 default/skip。"""
from __future__ import annotations

from typing import Any


def interaction_capability(config: Any, session: Any) -> dict:
    kind = getattr(config.type, 'value', config.type)
    base = {'version': 1, 'backendType': kind, 'questions': False, 'skip': False,
            'fields': [], 'currentRuntimeVersion': None}
    if kind == 'codex-office':
        mode = session.codex_connection_mode or ('node' if str((config.env or {}).get('AGENTWITHU_CODEX_APP_SERVER', 'true')).lower() != 'false' else 'exec')
        if mode in {'node', 'ssh'}:
            return {**base, 'questions': True, 'mode': mode, 'contractVersion': '0.166.0',
                    'fields': ['questions', 'single', 'text', 'secret'],
                    'notice': 'Codex 原生问答已适配；必填问题不能自动跳过。'}
        return {**base, 'mode': 'exec', 'notice': '旧 Codex exec 没有双向问答通道。问题将使用普通回复，请在下一轮回答。'}
    if kind in {'claude-agent-sdk', 'claude-code-official'}:
        return {**base, 'questions': True, 'mode': kind, 'contractVersion': 'Claude 2.1.85 / SDK 0.2.115',
                'fields': ['questions', 'single', 'multiple', 'text'], 'notice': '通过 Claude updatedInput 回传；未验证 option.preview 专用预览。'}
    if kind == 'qwen-code-cli':
        return {**base, 'mode': 'stream-json', 'contractVersion': 'Qwen 0.14.0 / SDK 0.1.0rc0',
                'notice': '当前 Qwen stream-json 不把答案传入问题工具。请在普通下一轮回答，不能自动允许空答案。'}
    if kind == 'deepseek-harness':
        return {**base, 'mode': 'external-runtime', 'contractVersion': '0.2.1-rc.3',
                'notice': '当前 Harness 契约只验证了执行审批，没有独立问题回答通道。请在普通下一轮回复。'}
    if kind in {'openai-compatible', 'anthropic-api'}:
        from .poe_api import is_poe_api_base_url
        if kind == 'openai-compatible' and is_poe_api_base_url(config.base_url or ''):
            return {**base, 'mode': 'poe-chat', 'notice': 'Poe 为纯聊天通道，请在普通下一轮回复。'}
        return {**base, 'questions': 'tool-chat-only', 'skip': True, 'mode': 'api', 'contractVersion': 'awu_ask_user/v1',
                'fields': ['questions', 'single', 'multiple', 'text'],
                'notice': '仅在已有工具聊天路由提供问答；纯文本辅助调用不启用。'}
    return {**base, 'mode': kind, 'notice': '此通道未声明结构化问答能力。'}

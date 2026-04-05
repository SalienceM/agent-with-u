"""Backend factory — maps BackendType to implementation class."""
from ..types import ModelBackendConfig, BackendType
from .base import ModelBackend
from .claude_agent import ClaudeAgentBackend
from .claude_code import ClaudeCodeOfficialBackend
from .openai_compat import OpenAICompatibleBackend
from .anthropic_api import AnthropicAPIBackend
from .dashscope_image import DashScopeImageBackend
from .web_search import WebSearchBackend


def create_backend(config: ModelBackendConfig) -> ModelBackend:
    """Factory: instantiate the correct ModelBackend for the given config."""
    if config.type == BackendType.CLAUDE_AGENT_SDK:
        return ClaudeAgentBackend(config)
    elif config.type == BackendType.CLAUDE_CODE_OFFICIAL:
        return ClaudeCodeOfficialBackend(config)
    elif config.type == BackendType.ANTHROPIC_API:
        return AnthropicAPIBackend(config)
    elif config.type == BackendType.OPENAI_COMPATIBLE:
        return OpenAICompatibleBackend(config)
    elif config.type == BackendType.DASHSCOPE_IMAGE:
        return DashScopeImageBackend(config)
    elif config.type == BackendType.WEB_SEARCH:
        return WebSearchBackend(config)
    else:
        raise ValueError(f"Unknown backend type: {config.type}")

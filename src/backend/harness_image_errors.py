"""Harness 安全错误出口：只投影固定类别、阶段和合法数值，不回显异常正文。"""
from __future__ import annotations

from .deepseek_harness_images import IMAGE_POLICY_REASONS, ImagePolicyError
from .harness_image_receipts import ReceiptError
from .deepseek_harness_cli import DEPENDENCY_REASONS, HarnessDependencyError

_LOCAL_MESSAGES = frozenset({
    "Harness 不支持请求中的额外运行选项", "此 Harness 版本不支持该推理强度",
    "Harness 纯文本调用不能恢复主会话或继承活动身份", "Harness 工作目录不是目录",
    "Harness 尚无已验证的 AWU OS 沙箱覆盖，不能忽略沙箱请求", "Harness Session 已有运行",
    "Harness 已取消", "Harness AWU 桥握手不匹配，禁止提交", "Harness 图片提交回执未知，不自动重放",
    "Harness 本轮等待超时，不自动重放", "Harness 根空闲但缺少本轮终态", "Harness turn/end 缺少有效结束原因",
    "Harness 图片资源缺失或不匹配，禁止提交图片；请重新准备配套桥",
    "Harness 图片资源清单缺失或不匹配", "Harness 图片资源契约不匹配",
    "缺少版本匹配的 Harness AWU 桥；请准备发行依赖，不会在聊天时下载",
    "缺少锁定的 Harness SDK/runtime；请安装配套发行依赖", "Harness SDK/runtime 版本不匹配，禁止混配或自动降级",
})

_STAGES = {
    "preflight": "请求校验", "workspace": "工作目录检查", "preparation": "运行准备",
    "history": "原生会话关联检查", "dependencies": "运行依赖检查", "startup": "运行时启动",
    "initialize": "运行时初始化", "handshake": "AWU 桥握手", "configure": "工具与权限配置",
    "resume": "历史恢复", "image_admission": "图片准入", "submit": "请求提交",
    "execution": "模型与工具执行", "wait": "等待本轮结束", "unknown": "未知",
    "projection": "流式事件处理",
}
_ERRORS = {
    "unknown": ("unknown", "未取得可分类的错误；请查看本轮调用诊断。"),
    "workspace_missing": ("filesystem", "工作目录不存在；请核对 Session 所属执行节点上的目录。"),
    "workspace_denied": ("filesystem", "无法访问工作目录；请核对执行节点上的目录权限。"),
    "workspace_invalid": ("filesystem", "工作目录无效；请选择执行节点上的实际目录。"),
    "file_missing": ("filesystem", "所需文件或目录不存在；请核对当前阶段的配套文件。"),
    "file_denied": ("filesystem", "所需文件或目录访问被拒绝；请核对执行账号权限。"),
    "history_invalid": ("history", "原生会话关联缺失或不匹配；请核对原执行节点、工作目录和历史记录。"),
    "timeout": ("timeout", "等待超时；请根据失败阶段核对运行时或服务响应。"),
    "transport_closed": ("network", "与 Harness 运行时的连接已关闭；请核对运行时是否正常启动和退出。"),
    "protocol_error": ("protocol", "运行时协议或事件不完整；请核对配套运行时与 AWU 版本。"),
    "event_overflow": ("protocol", "运行时事件积压超过接收容量，等待消化后仍未恢复；本轮已中断，已收到的内容保留。"),
    "stream_gap": ("protocol", "流式输出缺帧，无法确认回复完整；已收到的内容保留。"),
    "stream_mismatch": ("protocol", "实时输出与原生保存内容不一致，无法确认回复完整；已收到的内容保留。"),
    "stream_backpressure": ("protocol", "流式事件处理持续堵塞，本轮已中断；已收到的内容保留。"),
    "usage_invalid": ("protocol", "运行时用量数据不符合协议，本轮未正常完成。"),
    "rpc_error": ("protocol", "运行时拒绝了本阶段请求；请核对运行配置和配套版本。"),
    "auth": ("auth", "模型服务认证或访问权限检查失败；请核对所选 Backend 的凭据和账号权限。"),
    "not_found": ("provider", "模型服务接口未找到；请核对 Base URL 的 Messages API 路径与模型名。"),
    "quota": ("provider", "模型服务报告额度不足；请核对账号余额或额度。"),
    "rate_limit": ("rate_limit", "模型服务限流；请稍后重试或降低请求频率。"),
    "context_limit": ("context_limit", "模型服务报告上下文超限；请缩小本次输入或历史范围。"),
    "invalid_request": ("provider", "模型服务拒绝请求参数；请核对模型、接口兼容性和输入大小。"),
    "server_error": ("provider", "模型服务返回服务器错误；请检查服务状态。"),
    "network": ("network", "模型服务连接失败；请核对执行节点的网络、代理和服务地址。"),
    "malformed_response": ("protocol", "模型服务响应不符合当前 Harness 协议；请核对接口兼容性。"),
    "runtime_error": ("unknown", "原生运行报告失败，但未提供可分类的错误信息。"),
    "aborted": ("cancelled", "本轮已中止，未完成任务。"),
    "blocked": ("blocked", "本轮被原生运行时阻止，未完成任务；请核对工具权限与运行限制。"),
    "max_tokens": ("context_limit", "本轮达到输出 token 上限，任务未完成。"),
    "exit_unknown": ("concurrency", "运行进程退出尚未确认，活动保护继续保留。"),
}
_NATIVE_CODES = {
    "AUTH": "auth", "INVALID_CREDENTIAL": "auth", "QUOTA": "quota", "RATE_LIMIT": "rate_limit",
    "CONTEXT_WINDOW_EXCEEDED": "context_limit", "INVALID_REQUEST": "invalid_request",
    "SERVER": "server_error", "TRANSPORT": "network", "TIMEOUT": "timeout",
    "MALFORMED_RESPONSE": "malformed_response",
}
_LOCAL_CODES = {
    "Harness 工作目录不是目录": "workspace_invalid",
    "Harness 原生关联元数据缺失，不能创建替代会话": "history_invalid",
    "Harness 原生关联元数据超出限额": "history_invalid",
    "Harness 原生关联身份/版本/工作目录不匹配，禁止替代或自动迁移": "history_invalid",
    "Harness 原生 Session ID 不匹配": "history_invalid",
    "Harness 协议连接已关闭": "transport_closed", "Harness 协议连接未启动": "transport_closed",
    "Harness 协议写入失败": "transport_closed",
    "Harness 根空闲但缺少本轮终态": "protocol_error",
    "Harness turn/end 缺少有效结束原因": "protocol_error",
    "Harness 本轮收到重复终态": "protocol_error", "Harness 根事件序列无效": "protocol_error",
    "Harness 进程树退出未确认，活动保护保留": "exit_unknown",
    "Harness 实时流有缺帧": "stream_gap",
    "Harness 实时与已提交内容不一致": "stream_mismatch",
    "Harness 工具增量与原生参数不一致": "stream_mismatch",
    "Harness 异步消费背压超出限额": "stream_backpressure",
    "Harness 用量计数无效": "usage_invalid",
    "Harness 用量子计数无效": "usage_invalid",
    "Harness 用量总计与子项不一致": "usage_invalid",
    "Harness 本轮事件数量超限": "event_overflow",
    "Harness 实时帧缺少 start": "protocol_error",
    "Harness chunk 类型未知": "protocol_error",
    "Harness chunk 缺失": "protocol_error",
    "Harness 收到旧运行的实时帧": "protocol_error",
    "Harness 收到其他 Session 的事件": "protocol_error",
}


def _http_status(value: object) -> int | None:
    return value if type(value) is int and 400 <= value <= 599 else None


def _status_code(status: int | None) -> str | None:
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "not_found"
    if status == 402:
        return "quota"
    if status == 429:
        return "rate_limit"
    if status in (408, 504):
        return "timeout"
    if status is not None and status >= 500:
        return "server_error"
    return "invalid_request" if status is not None else None


class HarnessRuntimeError(RuntimeError):
    """仅保存从当前根轮终态归约的安全字段，不保留供应商 message/requestId。"""

    def __init__(self, code: str, http_status: int | None = None) -> None:
        self.code = code if isinstance(code, str) and code in _ERRORS else "runtime_error"
        self.http_status = _http_status(http_status)
        super().__init__(self.code)


def terminal_error(reason: object) -> HarnessRuntimeError:
    """锁定 rc.3 根轮 turn/end 的 reason.error.{code,status}，不是 LLM finish.failure。"""
    if not isinstance(reason, dict):
        return HarnessRuntimeError("protocol_error")
    kind = reason.get("kind")
    if kind in ("aborted", "blocked", "max-tokens"):
        return HarnessRuntimeError({"aborted": "aborted", "blocked": "blocked", "max-tokens": "max_tokens"}[kind])
    failure = reason.get("error")
    if kind != "error" or not isinstance(failure, dict):
        return HarnessRuntimeError("runtime_error")
    status = _http_status(failure.get("status"))
    native_code = failure.get("code")
    code = _NATIVE_CODES.get(native_code) if isinstance(native_code, str) else None
    # HTTP 状态是独立事实；404 不会因供应商写了 invalid_request 而失去排错建议。
    code = (code if code == "context_limit" and status in (400, 413)
            else _status_code(status) or code)
    return HarnessRuntimeError(code or "runtime_error", status)


def harness_error_details(error: Exception, *, stage: str = "unknown") -> dict:
    stage = stage if isinstance(stage, str) and stage in _STAGES else "unknown"
    code, status, rpc_code = "unknown", None, None
    if isinstance(error, HarnessRuntimeError):
        code = error.code if isinstance(error.code, str) and error.code in _ERRORS else "runtime_error"
        status = _http_status(error.http_status)
    elif isinstance(error, TimeoutError):
        code = "timeout"
    elif isinstance(error, FileNotFoundError):
        code = "workspace_missing" if stage == "workspace" else "file_missing"
    elif isinstance(error, PermissionError):
        code = "workspace_denied" if stage == "workspace" else "file_denied"
    elif isinstance(error, NotADirectoryError):
        code = "workspace_invalid" if stage == "workspace" else "file_missing"
    elif isinstance(error, ConnectionError):
        code = "transport_closed"
    else:
        code = _LOCAL_CODES.get(str(error), "unknown")
        # SDK 可缺失；不以类名、模块名或异常正文冒充类型化证据。
        try:
            from deepseek_harness.errors import JsonRpcError, SdkProtocolError, TransportClosedError
        except ImportError:
            pass
        else:
            if isinstance(error, TransportClosedError):
                code = "transport_closed"
            elif isinstance(error, SdkProtocolError):
                code = "protocol_error"
            elif isinstance(error, JsonRpcError):
                code = "rpc_error"
                if type(error.code) is int and -32768 <= error.code <= -32000:
                    rpc_code = error.code
    return {"category": _ERRORS[code][0], "errorCode": code, "failureStage": stage,
            **({"httpStatus": status} if status is not None else {}),
            **({"rpcCode": rpc_code} if rpc_code is not None else {})}


def harness_error_text(error: Exception, *, stage: str = "unknown") -> str:
    if (isinstance(error, HarnessDependencyError) and isinstance(error.reason, str)
            and error.reason in DEPENDENCY_REASONS):
        # 只按受控分类重建指引，不透传原始异常正文/路径/环境。
        return str(HarnessDependencyError(error.reason))
    if (isinstance(error, ImagePolicyError) and isinstance(error.reason, str)
            and error.reason in IMAGE_POLICY_REASONS):
        return str(ImagePolicyError(error.reason))
    if isinstance(error, ReceiptError):
        return str(ReceiptError(error.code if isinstance(error.code, str) else "invalid_receipt"))
    message = str(error)
    if message in _LOCAL_MESSAGES:
        return message
    details = harness_error_details(error, stage=stage)
    facts = [details["errorCode"]]
    if "httpStatus" in details:
        facts.append(f"HTTP {details['httpStatus']}")
    if "rpcCode" in details:
        facts.append(f"RPC {details['rpcCode']}")
    return (f"Harness 在{_STAGES[details['failureStage']]}阶段失败（{' / '.join(facts)}）。"
            f"{_ERRORS[details['errorCode']][1]}不会自动重发。")


def harness_event_metadata(event: dict) -> dict:
    kinds = {"agent/inbox/spliced", "turn/start", "turn/end", "assistant/message", "tool/call", "tool/result"}
    kind, seq = event.get("type"), event.get("seq")
    return {"type": kind if isinstance(kind, str) and kind in kinds else "other",
            "seq": seq if type(seq) is int and 0 <= seq <= 2**53 - 1 else None}

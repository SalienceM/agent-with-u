"""安全分类使用结构化事实；用户正文、供应商响应和路径从不成为诊断。"""
from __future__ import annotations

import json
import unittest

from src.backend.harness_image_errors import (harness_error_details, harness_error_text, terminal_error,
                                             harness_projection_failure_metadata)
from src.backend.deepseek_harness_images import ImagePolicyError


class HarnessErrorDiagnosticsTests(unittest.TestCase):
    def test_projection_metadata_keeps_shape_without_text_paths_or_custom_types(self) -> None:
        marker = "PRIVATE_PAYLOAD_PATH_TOKEN"
        note = {"method": "awu/assistantStream", "payload": {"sessionId": marker,
            "frame": {"type": "chunk", "index": 2, "revision": 3, "attemptId": marker,
                      "chunk": {"type": "tool-call-delta", "argumentsDelta": marker, "text": marker}}}}
        metadata = harness_projection_failure_metadata(ValueError(marker), note)["projection"]
        self.assertEqual(metadata["method"], "awu/assistantStream")
        self.assertEqual(metadata["index"], 2)
        self.assertEqual(metadata["chunkType"], "tool-call-delta")
        self.assertEqual(metadata["exceptionType"], "ValueError")
        self.assertNotIn(marker, json.dumps(metadata))
        custom_error = type(marker, (ValueError,), {})(marker)
        data = harness_projection_failure_metadata(custom_error, {"method": marker, "payload": {
            "event": {"type": marker, "seq": marker}, "frame": {"type": marker, "revision": True,
            "index": marker, "chunk": {"type": marker}}}})
        self.assertNotIn(marker, json.dumps(data))
        self.assertEqual(data["projection"]["exceptionType"], "other")

    def test_controlled_projection_failures_are_no_longer_unknown(self) -> None:
        for message, code in (("Harness 实时帧 index 无效", "protocol_error"),
                              ("Harness 工具结果没有对应调用", "protocol_error"),
                              ("Harness 本轮文本超出限额", "projection_limit"),
                              ("Harness Session 已有运行", "session_busy")):
            self.assertEqual(harness_error_details(ValueError(message))["errorCode"], code)

    def test_projection_and_backpressure_failures_keep_distinct_safe_reasons(self) -> None:
        for message, code in (("Harness 实时流有缺帧", "stream_gap"),
                              ("Harness 实时与已提交内容不一致", "stream_mismatch"),
                              ("Harness 异步消费背压超出限额", "stream_backpressure")):
            error = RuntimeError(message)
            self.assertEqual(harness_error_details(error, stage="projection")["errorCode"], code)
            self.assertIn("流式事件处理", harness_error_text(error, stage="projection"))
        self.assertEqual(harness_error_details(RuntimeError("PRIVATE Harness 实时流有缺帧"))["errorCode"], "unknown")

    def test_text_failure_never_blames_images_or_echoes_exception(self) -> None:
        marker = "PRIVATE_PAYLOAD https://private.invalid/?token=secret HTTP 401 timeout"
        error = RuntimeError(marker)
        message = harness_error_text(error, stage="initialize")
        self.assertIn("运行时初始化", message)
        self.assertIn("unknown", message)
        self.assertNotIn("图片", message)
        self.assertNotIn("附件", message)
        self.assertNotIn(marker, message)
        self.assertEqual(harness_error_details(error)["category"], "unknown")
        self.assertNotIn(marker, harness_error_text(error, stage=marker))

    def test_typed_failures_distinguish_workspace_timeout_and_history(self) -> None:
        for error, stage, code in (
            (FileNotFoundError("PRIVATE_PATH"), "workspace", "workspace_missing"),
            (PermissionError("PRIVATE_PATH"), "workspace", "workspace_denied"),
            (NotADirectoryError("PRIVATE_PATH"), "workspace", "workspace_invalid"),
            (FileNotFoundError("PRIVATE_PATH"), "dependencies", "file_missing"),
            (TimeoutError("PRIVATE_REQUEST"), "initialize", "timeout"),
            (ValueError("Harness 原生关联元数据缺失，不能创建替代会话"), "history", "history_invalid"),
        ):
            with self.subTest(code=code):
                self.assertEqual(harness_error_details(error, stage=stage)["errorCode"], code)
                self.assertNotIn("PRIVATE", harness_error_text(error, stage=stage))

    def test_native_http_statuses_and_codes_have_actionable_fixed_messages(self) -> None:
        for status, code in ((401, "auth"), (403, "auth"), (404, "not_found"), (402, "quota"),
                             (429, "rate_limit"), (503, "server_error"), (408, "timeout")):
            with self.subTest(status=status):
                error = terminal_error({"kind": "error", "error": {"status": status,
                    "message": "PRIVATE_BODY", "requestId": "PRIVATE_ID"}})
                self.assertEqual(harness_error_details(error)["errorCode"], code)
                message = harness_error_text(error, stage="execution")
                self.assertIn(f"HTTP {status}", message)
                self.assertNotIn("PRIVATE", message)
        for native, expected in (("TRANSPORT", "network"), ("TIMEOUT", "timeout"),
                                 ("CONTEXT_WINDOW_EXCEEDED", "context_limit")):
            error = terminal_error({"kind": "error", "error": {"code": native}})
            self.assertEqual(harness_error_details(error)["errorCode"], expected)
        error = terminal_error({"kind": "error", "error": {"code": "CONTEXT_WINDOW_EXCEEDED", "status": 400}})
        self.assertEqual(harness_error_details(error)["errorCode"], "context_limit")

    def test_prepared_call_and_empty_response_keep_safe_classification(self) -> None:
        for native, expected in (("INVALID_PREPARED_CALL", "call_config"),
                                 ("UNSUPPORTED_REASONING_EFFORT", "call_config"),
                                 ("NO_ADAPTER", "call_config"), ("EMPTY_RESPONSE", "empty_response"),
                                 ("MISSING_CREDENTIAL", "auth"), ("ACCOUNT_QUOTA", "quota"),
                                 ("ABORTED", "aborted")):
            error = terminal_error({"kind": "error", "error": {"code": native, "message": "PRIVATE"}})
            self.assertEqual(harness_error_details(error)["errorCode"], expected)
            self.assertNotIn("PRIVATE", harness_error_text(error))

    def test_malformed_native_evidence_and_mutated_exception_do_not_escape(self) -> None:
        for value in (None, [], {}, {"kind": []}, {"kind": "error", "error": "PRIVATE"},
                      {"kind": "error", "error": {"status": True, "code": []}},
                      {"kind": "error", "error": {"status": "401", "code": "PRIVATE"}},
                      {"kind": "error", "error": {"status": 9999999, "message": "HTTP 401 PRIVATE"}}):
            error = terminal_error(value)
            error.args = ("PRIVATE",)
            result = harness_error_details(error)
            self.assertNotIn("httpStatus", result)
            self.assertNotIn("PRIVATE", json.dumps(result) + harness_error_text(error))

    def test_image_errors_remain_precise_and_terminal_reasons_stay_failures(self) -> None:
        error = ImagePolicyError("endpoint_text_only")
        self.assertEqual(harness_error_text(error), str(error))
        for kind, code in (("aborted", "aborted"), ("blocked", "blocked"), ("max-tokens", "max_tokens")):
            self.assertEqual(harness_error_details(terminal_error({"kind": kind}))["errorCode"], code)


if __name__ == "__main__":
    unittest.main()

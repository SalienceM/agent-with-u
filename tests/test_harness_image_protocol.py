from __future__ import annotations

import copy
import unittest

from src.backend.deepseek_harness_config import COMMIT, RUNTIME_VERSION
from src.backend.deepseek_harness_images import (ImagePolicyError, LIMITS, admission_request,
    admitted_image_token, image_admission_error, is_image_prompt_rejection)


class HarnessImageProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.identity = {key: key for key in ("ownerId", "executorId", "awuSessionId", "backendId", "sessionId",
            "generation", "configFingerprint", "provider", "model")}
        self.capabilities = {**{key: self.identity[key] for key in ("sessionId", "generation", "configFingerprint")},
            "runtimeVersion": RUNTIME_VERSION, "sourceCommit": COMMIT,
            "imageAdmission": {"version": 1, "bridgeVersion": 1, "limits": dict(LIMITS)}}

    def test_exact_extension_builds_only_bounded_identity_and_digest(self) -> None:
        request = admission_request(self.capabilities, self.identity, ())
        self.assertEqual(request["limits"], LIMITS)
        self.assertEqual(len(request["imageDigest"]), 64)
        self.assertEqual(set(request), set(self.identity) | {"version", "bridgeVersion", "runtimeVersion", "sourceCommit", "limits", "imageDigest"})

    def test_missing_extension_wrong_versions_limits_and_identity_reject(self) -> None:
        for key in ("imageAdmission", "runtimeVersion", "sourceCommit", "sessionId", "generation", "configFingerprint"):
            with self.subTest(key=key):
                cap = copy.deepcopy(self.capabilities)
                del cap[key]
                with self.assertRaises(ImagePolicyError):
                    admission_request(cap, self.identity, ())
        for key in LIMITS:
            cap = copy.deepcopy(self.capabilities)
            cap["imageAdmission"]["limits"][key] += 1
            with self.assertRaises(ImagePolicyError):
                admission_request(cap, self.identity, ())
        for key in ("version", "bridgeVersion"):
            cap = copy.deepcopy(self.capabilities)
            cap["imageAdmission"][key] = True
            with self.assertRaises(ImagePolicyError):
                admission_request(cap, self.identity, ())
        for key in self.identity:
            with self.subTest(identity=key), self.assertRaises(ImagePolicyError):
                admission_request(self.capabilities, {**self.identity, key: ""}, ())

    def test_admission_response_requires_full_frozen_identity_and_exact_permission(self) -> None:
        request = admission_request(self.capabilities, self.identity, ())
        reply = {"version": 1, "admitted": True, "capability": "supported", "reason": "route_declares_image",
            "source": "endpoint-and-native", "limits": dict(LIMITS), "admissionId": "a" * 36,
            "route": {key: value for key, value in request.items() if key not in {"version", "limits", "imageDigest"}}}
        self.assertEqual(admitted_image_token(reply, request), "a" * 36)
        for key, value in (("version", True), ("admitted", 1), ("source", "native-adapter"),
                           ("capability", "unknown"), ("admissionId", "http://fixture.invalid/?secret=hidden")):
            with self.subTest(key=key), self.assertRaises(ImagePolicyError):
                admitted_image_token({**reply, key: value}, request)
        for key in reply["route"]:
            with self.subTest(route=key), self.assertRaises(ImagePolicyError):
                admitted_image_token({**reply, "route": {**reply["route"], key: "changed"}}, request)
        with self.assertRaises(ImagePolicyError):
            admitted_image_token({**reply, "limits": {**LIMITS, "maxImages": True}}, request)

    def test_rejection_requires_explicit_boundary_and_reason_is_never_echoed(self) -> None:
        reply = {"version": 1, "admitted": False, "status": "rejected", "boundary": "before-native-handler"}
        self.assertTrue(is_image_prompt_rejection(reply))
        for key, value in (("version", True), ("admitted", 0), ("boundary", "unknown"), ("messageId", "accepted")):
            self.assertFalse(is_image_prompt_rejection({**reply, key: value}))
        self.assertEqual(image_admission_error("endpoint_text_only").reason, "endpoint_text_only")
        self.assertEqual(image_admission_error("safety_guard_unavailable").reason, "safety_guard_unavailable")
        for raw in ("secret base64 or http://fixture.invalid", {}, None):
            self.assertEqual(image_admission_error(raw).reason, "capability_unknown")


if __name__ == "__main__":
    unittest.main()

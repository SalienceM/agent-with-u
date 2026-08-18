import http
import unittest

from src.backend.auth import AuthConfig, AuthGuard
from src.backend.bridge_ws import BridgeWS


USER_ID = "c0139607-df3e-4f25-92ef-c52d471d3030"
LOCAL_IDENTITY_TOKEN = "test-local-identity-token-with-enough-entropy"


class _Connection:
    def __init__(self, peer="127.0.0.1"):
        self.remote_address = (peer, 44321)

    @staticmethod
    def respond(status, message):
        return status, message


class _Request:
    def __init__(self, path="/ws"):
        self.path = path
        self.headers = {}


class LocalUserAuthTests(unittest.TestCase):
    def setUp(self):
        self.guard = AuthGuard(
            AuthConfig(
                bind_host="127.0.0.1",
                local_identity_token=LOCAL_IDENTITY_TOKEN,
            )
        )

    def test_plain_loopback_keeps_legacy_local_owner(self):
        connection = _Connection()
        self.assertIsNone(self.guard.process_request(connection, _Request()))
        self.assertEqual("local", connection.identity)
        self.assertEqual("loopback", connection.identity_src)

    def test_relay_user_can_scope_the_trusted_local_sidecar(self):
        connection = _Connection()
        request = _Request(
            f"/ws?localUserId={USER_ID}"
            f"&localIdentityToken={LOCAL_IDENTITY_TOKEN}"
            "&localUsername=alice&localDisplayName=Alice"
        )

        self.assertIsNone(self.guard.process_request(connection, request))
        self.assertEqual(USER_ID, connection.identity)
        self.assertEqual("local-user", connection.identity_src)
        self.assertEqual("alice", connection.username)
        self.assertEqual("Alice", connection.display_name)
        self.assertEqual(USER_ID, BridgeWS._owner_id_for_client(connection))

    def test_missing_local_identity_token_is_rejected(self):
        connection = _Connection()
        result = self.guard.process_request(
            connection, _Request(f"/ws?localUserId={USER_ID}")
        )

        self.assertEqual(http.HTTPStatus.UNAUTHORIZED, result[0])

    def test_wrong_local_identity_token_is_rejected(self):
        connection = _Connection()
        result = self.guard.process_request(
            connection,
            _Request(f"/ws?localUserId={USER_ID}&localIdentityToken=wrong"),
        )

        self.assertEqual(http.HTTPStatus.UNAUTHORIZED, result[0])

    def test_unconfigured_sidecar_never_accepts_an_asserted_user(self):
        guard = AuthGuard(AuthConfig(bind_host="127.0.0.1"))
        result = guard.process_request(
            _Connection(),
            _Request(
                f"/ws?localUserId={USER_ID}"
                f"&localIdentityToken={LOCAL_IDENTITY_TOKEN}"
            ),
        )

        self.assertEqual(http.HTTPStatus.UNAUTHORIZED, result[0])

    def test_invalid_local_user_id_is_rejected_after_token_check(self):
        connection = _Connection()
        result = self.guard.process_request(
            connection,
            _Request(
                "/ws?localUserId=not-a-stable-user-id"
                f"&localIdentityToken={LOCAL_IDENTITY_TOKEN}"
            ),
        )

        self.assertEqual(http.HTTPStatus.BAD_REQUEST, result[0])

    def test_untrusted_peer_cannot_assert_a_local_user(self):
        connection = _Connection("192.168.50.99")
        result = self.guard.process_request(
            connection,
            _Request(
                f"/ws?localUserId={USER_ID}"
                f"&localIdentityToken={LOCAL_IDENTITY_TOKEN}"
            ),
        )

        self.assertEqual(http.HTTPStatus.FORBIDDEN, result[0])

    def test_trusted_non_loopback_peer_still_cannot_assert_local_user(self):
        guard = AuthGuard(
            AuthConfig(
                bind_host="0.0.0.0",
                trusted_proxies=["192.168.50.0/24"],
                local_identity_token=LOCAL_IDENTITY_TOKEN,
            )
        )
        result = guard.process_request(
            _Connection("192.168.50.99"),
            _Request(
                f"/ws?localUserId={USER_ID}"
                f"&localIdentityToken={LOCAL_IDENTITY_TOKEN}"
            ),
        )

        self.assertEqual(http.HTTPStatus.FORBIDDEN, result[0])


if __name__ == "__main__":
    unittest.main()

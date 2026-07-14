import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from src.backend.device_auth import DeviceAuthStore
from src.web_server import PortableWebServer


class _BridgeStub:
    async def _route_http_api(self, method, path, body, peer_ip):
        return 200, "application/json", json.dumps({"path": path, "ip": peer_ip}).encode()


class PortableWebServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "dist"
        root.mkdir()
        (root / "index.html").write_text(
            "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>",
            encoding="utf-8",
        )
        auth = DeviceAuthStore(Path(self.tmp.name) / "auth.json", device_code="ABCD-EFGH")
        self.web = PortableWebServer(
            bind_host="127.0.0.1", port=0, ws_port=45421, web_root=root,
            auth=auth, bridge=_BridgeStub(),
        )
        self.server = await self.web.start()
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.tmp.cleanup()

    async def request(self, method, path, body=b"", headers=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        hdr = {"host": f"127.0.0.1:{self.port}", "connection": "close", **(headers or {})}
        if body:
            hdr["content-length"] = str(len(body))
        wire = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdr.items()) + "\r\n"
        writer.write(wire.encode("ascii") + body)
        await writer.drain()
        raw = await reader.read()
        writer.close()
        await writer.wait_closed()
        head, payload = raw.split(b"\r\n\r\n", 1)
        lines = head.decode("iso-8859-1").split("\r\n")
        status = int(lines[0].split()[1])
        response_headers = {}
        for line in lines[1:]:
            key, _, value = line.partition(":")
            response_headers[key.lower()] = value.strip()
        return status, response_headers, payload

    async def test_login_cookie_unlocks_app_and_api(self):
        status, _, body = await self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Device", body.decode("utf-8"))

        payload = json.dumps({"code": "ABCD-EFGH"}).encode()
        status, headers, _ = await self.request(
            "POST", "/device-auth/login", payload, {"content-type": "application/json"},
        )
        self.assertEqual(status, 200)
        cookie = headers["set-cookie"].split(";", 1)[0]

        status, _, body = await self.request("GET", "/", headers={"cookie": cookie})
        self.assertEqual(status, 200)
        page = body.decode("utf-8")
        self.assertIn("__AGENT_WITH_U_WS_URL__", page)
        self.assertIn("ws://127.0.0.1:45421", page)

        status, _, body = await self.request("GET", "/api/test", headers={"cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/api/test")


if __name__ == "__main__":
    unittest.main()

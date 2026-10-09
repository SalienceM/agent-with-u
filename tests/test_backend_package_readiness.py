from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from scripts import prepare_backend_build as dependencies
from scripts import check_backend_package as smoke
from scripts.build_backend_package import command
from src import package_readiness as readiness

ROOT = Path(__file__).resolve().parents[1]


class DependencyTests(unittest.TestCase):
    def test_webview_registry_guid_keeps_braces(self) -> None:
        installer = (ROOT / "installer" / "installer.nsi").read_text(encoding="utf-8")
        self.assertIn('StrCpy $R0 "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"', installer)
        self.assertEqual(installer.count('ReadRegStr $0 HKLM "Software\\Microsoft\\EdgeUpdate\\Clients\\$R0" "pv"'), 2)

    def test_new_dependency_missing_despite_old_dependencies(self) -> None:
        original = importlib.metadata.version
        def version(name: str) -> str:
            if name == "pathspec":
                raise importlib.metadata.PackageNotFoundError(name)
            return original(name)
        with patch.object(importlib.metadata, "version", side_effect=version):
            self.assertIn("missing:pathspec", dependencies.validate_requirements())

    def test_wrong_version(self) -> None:
        with patch.object(importlib.metadata, "version", return_value="0.0.0"):
            self.assertIn("version:pathspec", dependencies.validate_requirements())

    def test_install_failure_stops_before_checks(self) -> None:
        with patch.object(dependencies.subprocess, "run", return_value=SimpleNamespace(returncode=19)) as run:
            with patch.object(dependencies, "validate_requirements") as validate:
                self.assertEqual(dependencies.prepare(), 19)
                validate.assert_not_called()
                self.assertEqual(run.call_args.args[0][:3], [sys.executable, "-m", "pip"])

    def test_platform_components(self) -> None:
        def load(name: str) -> object:
            if name in {"pathspec", "winpty.enums"}:
                raise ImportError(name)
            return object()
        with patch.object(readiness.importlib, "import_module", side_effect=load):
            with patch.object(sys, "platform", "win32"):
                value = readiness.check_components(resources=False)
                self.assertIn("module:winpty.enums", value["failures"])
                self.assertIn("module:pathspec", value["failures"])
            with patch.object(sys, "platform", "linux"):
                value = readiness.check_components(resources=False)
                self.assertNotIn("module:winpty.enums", value["failures"])

    def test_resource_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(sys, "_MEIPASS", temporary, create=True), patch.object(sys, "frozen", True, create=True):
                with patch.object(readiness.importlib, "import_module", return_value=SimpleNamespace(GitIgnoreSpec=object)):
                    value = readiness.check_components(web=True)
                    self.assertIn("resource:awu-jdt-diagnostics.jar", value["failures"])
                    self.assertIn("resource:frontend_dist/index.html", value["failures"])

    def test_shared_freezer_collects_declared_modules(self) -> None:
        args = command()
        self.assertIn("pathspec", args)
        self.assertIn("qwen_code_sdk", args)
        if sys.platform == "win32":
            self.assertIn("winpty", args)


class IsolationTests(unittest.TestCase):
    def test_isolation_and_root_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.dict(os.environ, {"AGENT_WITH_U_RELAY_TOKEN": "secret", "ANTHROPIC_API_KEY": "secret", "PYTHONPATH": "private"}):
                env = smoke.isolated_environment(root)
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertNotIn("AGENT_WITH_U_RELAY_TOKEN", env)
            self.assertNotIn("PYTHONPATH", env)
            previous = Path.cwd()
            try:
                os.chdir(root / "work")
                with patch.dict(os.environ, env, clear=True):
                    self.assertEqual(readiness.probe_root(), root)
                    os.environ["AGENT_WITH_U_DATA_ROOT"] = str(previous)
                    with self.assertRaises(RuntimeError):
                        readiness.probe_root()
            finally:
                os.chdir(previous)

    def test_confirm_rejects_changed_artifact_and_failed_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "backend.exe"
            binary.write_bytes(b"first")
            report = Path(temporary) / "report.json"
            value = {"ok": True, "path": str(binary), "platform": sys.platform, "sha256": smoke.digest(binary)}
            report.write_text(json.dumps(value))
            self.assertTrue(smoke.confirm(binary, report))
            binary.write_bytes(b"replacement")
            self.assertFalse(smoke.confirm(binary, report))
            value["ok"] = False
            report.write_text(json.dumps(value))
            self.assertFalse(smoke.confirm(binary, report))

    def test_ports_reserved_as_triplet(self) -> None:
        import socket
        port, held = smoke.reserve_ports()
        try:
            self.assertFalse(44321 <= port <= 44323)
            for number in range(port, port + 3):
                with socket.socket() as connection:
                    with self.assertRaises(OSError):
                        connection.bind(("127.0.0.1", number))
        finally:
            for connection in held:
                connection.close()

    def test_entrypoint_order_and_packaging_gates(self) -> None:
        for name in ("ws_main_entry.py", "web_main_entry.py"):
            content = (ROOT / name).read_text(encoding="utf-8")
            self.assertLess(content.index("entry_check("), content.index("from src.ws_main import main"))
        for name in ("build_all.bat", "build_fat_sideonly.bat", "build_fat.bat", "build_lite.bat", "build_web.bat", "build_web_linux.sh"):
            content = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn("check_backend_package.py", content, name)
            self.assertIn("--confirm", content, name)
            self.assertNotIn("[WARN] Backend sidecar not found", content, name)
        full = (ROOT / "build_all.bat").read_text(encoding="utf-8")
        self.assertLess(full.index("prepare_backend_build.py"), full.index("build_backend_package.py"))
        self.assertLess(full.index("check_backend_package.py"), full.index('copy /y "dist'))
        wrapper = (ROOT / "build_fat_all.bat").read_text(encoding="utf-8")
        self.assertIn("if errorlevel 1", wrapper)


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_child_cannot_write_production_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            production = base / "production"
            production.mkdir()
            sentinel = production / "backend.log"
            sentinel.write_text("production-sentinel")
            root = base / "probe"
            root.mkdir()
            with patch.dict(os.environ, {"USERPROFILE": str(production), "HOME": str(production),
                                         "APPDATA": str(production), "AGENT_WITH_U_DATA_ROOT": str(production)}):
                env = smoke.isolated_environment(root)
            probe = smoke.ProbeProcess()
            code = "import sys,os,pathlib;sys.stdin.readline();p=pathlib.Path.home()/'backend.log';p.write_text('isolated');print(p,flush=True)"
            try:
                await probe.start([sys.executable, "-c", code], env, root / "work")
                await asyncio.wait_for(probe.proc.wait(), 5)
            finally:
                self.assertTrue(await probe.stop())
            self.assertEqual(sentinel.read_text(), "production-sentinel")
            self.assertEqual((root / "home/backend.log").read_text(), "isolated")

    async def test_unknown_launch_cannot_claim_cleanup(self) -> None:
        probe = smoke.ProbeProcess()
        probe.launch_pending = True
        self.assertFalse(await probe.stop())

    async def test_failed_components_and_unknown_cleanup_stay_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "backend.exe"
            binary.write_bytes(b"test-fixture")
            for cleanup in (True, False):
                fake = SimpleNamespace(
                    proc=SimpleNamespace(returncode=1, wait=AsyncMock(return_value=1)),
                    readers=[], tails=[bytearray(b'{"ok":false,"failures":["module:pathspec"]}'), bytearray()],
                    start=AsyncMock(), stop=AsyncMock(return_value=cleanup))
                with patch.object(smoke, "ProbeProcess", return_value=fake):
                    result = await smoke.verify(binary)
                self.assertFalse(result["ok"])
                self.assertEqual(result["componentFailures"], ["module:pathspec"])
                self.assertEqual(result["failure"], "components-failed" if cleanup else "cleanup-unconfirmed")
                self.assertEqual(fake.start.await_count, 1)

    async def test_unowned_endpoint_rejects_probe_token(self) -> None:
        from websockets.asyncio.server import serve
        import time
        async def reject(connection: object, request: object) -> object:
            return connection.respond(401, "unauthorized")
        async def handler(ws: object) -> None:
            self.fail("an unauthenticated probe must not enter this service")
        async with serve(handler, "127.0.0.1", 0, process_request=reject) as server:
            port = server.sockets[0].getsockname()[1]
            probe = SimpleNamespace(proc=SimpleNamespace(returncode=None))
            with self.assertRaisesRegex(RuntimeError, "startup-timeout"):
                await smoke.wait_ping(probe, port, "per-probe-token", time.monotonic() + .3)

    async def test_owned_child_and_bounded_high_output_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            env = smoke.isolated_environment(root)
            probe = smoke.ProbeProcess()
            code = "import sys,subprocess,time; sys.stdin.readline(); subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)']); sys.stdout.write('x'*1000000);sys.stdout.flush();time.sleep(90)"
            try:
                await probe.start([sys.executable, "-c", code], env, root / "work")
                await asyncio.sleep(.5)
                self.assertLessEqual(len(probe.tails[0]), smoke.LIMIT)
            finally:
                self.assertTrue(await probe.stop())

    async def test_missing_binary(self) -> None:
        result = await smoke.verify(Path("does-not-exist.exe"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "missing-binary")

    async def test_ping_success_and_wrong_response(self) -> None:
        from websockets.asyncio.server import serve
        import time
        for reply, expected in (("pong", True), ("wrong", False)):
            async def handler(ws: object) -> None:
                request = json.loads(await ws.recv())
                await ws.send(json.dumps({"id": request["id"], "result": reply}))
            async with serve(handler, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]
                probe = SimpleNamespace(proc=SimpleNamespace(returncode=None))
                if expected:
                    await smoke.wait_ping(probe, port, "test", time.monotonic() + 3)
                else:
                    with self.assertRaisesRegex(RuntimeError, "rpc-mismatch"):
                        await smoke.wait_ping(probe, port, "test", time.monotonic() + 3)

    async def test_timeout_and_exited_process(self) -> None:
        import time
        probe = SimpleNamespace(proc=SimpleNamespace(returncode=None))
        port, held = smoke.reserve_ports()
        for item in held:
            item.close()
        with self.assertRaisesRegex(RuntimeError, "startup-timeout"):
            await smoke.wait_ping(probe, port, "test", time.monotonic() + .2)
        probe.proc.returncode = 1
        with self.assertRaisesRegex(RuntimeError, "startup-exited"):
            await smoke.wait_ping(probe, port, "test", time.monotonic() + 1)


if __name__ == "__main__":
    unittest.main()

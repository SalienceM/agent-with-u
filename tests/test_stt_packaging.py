from __future__ import annotations

import ast
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.package_policy import FROZEN_EXCLUDES, validate_analysis
from src.backend import stt_service as stt


ROOT = Path(__file__).resolve().parents[1]


class PackagingPolicyTests(unittest.TestCase):
    def test_desktop_and_web_share_exclusion_and_post_analysis_guard(self) -> None:
        for filename in ("agent-with-u-backend.spec", "agent-with-u-web.spec"):
            tree = ast.parse((ROOT / filename).read_text(encoding="utf-8"))
            calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name)]
            analysis = next(node for node in calls if node.func.id == "Analysis")
            excludes = next(item.value for item in analysis.keywords if item.arg == "excludes")
            self.assertEqual(ast.unparse(excludes), "list(FROZEN_EXCLUDES)")
            guard = next(node for node in calls if node.func.id == "validate_analysis")
            pyz = next(node for node in calls if node.func.id == "PYZ")
            self.assertLess(analysis.lineno, guard.lineno)
            self.assertLess(guard.lineno, pyz.lineno)

    def test_shared_libraries_are_not_excluded(self) -> None:
        self.assertIn("faster_whisper", FROZEN_EXCLUDES)
        self.assertTrue(set(FROZEN_EXCLUDES).isdisjoint({"numpy", "pandas", "PIL", "dashscope", "deepseek_harness"}))
        validate_analysis(SimpleNamespace(pure=[("numpy", "", "PYMODULE")],
            binaries=[("PIL/_imaging.pyd", "", "BINARY")], datas=[]))

    def test_rejects_leaks_in_every_table_and_path_style(self) -> None:
        for field in ("pure", "binaries", "datas"):
            for name in ("faster_whisper.transcribe", "faster_whisper/assets/model.onnx",
                         "ctranslate2/ctranslate2.dll", "onnxruntime\\capi\\runtime.dll",
                         "av.libs/avcodec.dll", "av.audio"):
                analysis = SimpleNamespace(pure=[], binaries=[], datas=[])
                setattr(analysis, field, [(name, "", "DATA")])
                with self.subTest(field=field, name=name), self.assertRaisesRegex(RuntimeError, "local-STT"):
                    validate_analysis(analysis)


class FrozenSttTests(unittest.IsolatedAsyncioTestCase):
    async def test_frozen_stt_still_uses_external_python(self) -> None:
        with tempfile.TemporaryDirectory(prefix="awu-stt-test-") as temporary:
            real_temporary = tempfile.NamedTemporaryFile
            create_file = lambda **kwargs: real_temporary(dir=temporary, **kwargs)
            run = Mock(return_value=SimpleNamespace(returncode=0, stdout='{"text":"external result"}', stderr=""))
            with patch.object(sys, "frozen", True, create=True), \
                    patch.object(stt, "_find_system_python", return_value="external-python.exe"), \
                    patch.object(stt, "_get_local_model", side_effect=AssertionError("must not use bundled model")), \
                    patch.object(stt.tempfile, "NamedTemporaryFile", side_effect=create_file), \
                    patch.object(subprocess, "run", run):
                self.assertEqual(await stt.transcribe_local(b"RIFFtest"), "external result")
            args = run.call_args.args[0]
            self.assertEqual(args[:2], ["external-python.exe", "-c"])
            self.assertEqual(args[2], stt._SUBPROCESS_SCRIPT)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    async def test_missing_external_python_remains_actionable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="awu-stt-test-") as temporary:
            real_temporary = tempfile.NamedTemporaryFile
            with patch.object(sys, "frozen", True, create=True), \
                    patch.object(stt, "_find_system_python", return_value=None), \
                    patch.object(stt.tempfile, "NamedTemporaryFile",
                                 side_effect=lambda **kwargs: real_temporary(dir=temporary, **kwargs)), \
                    patch.object(subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Python"):
                    await stt.transcribe_local(b"RIFFtest")
                run.assert_not_called()
            self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()

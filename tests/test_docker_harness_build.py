from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts import build_docker_harness as builder


class DockerHarnessBuildTests(unittest.TestCase):
    def test_sdk_resources_require_audited_bytes_and_do_not_invent_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "deploy").mkdir()
            wheel = root / "deepseek_harness_sdk-0.2.1rc3-py3-none-any.whl"
            prefix = "deepseek_harness_sdk-0.2.1rc3.dist-info/"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(prefix + "METADATA", "Metadata-Version: 2.4\nName: deepseek-harness-sdk\n"
                    "Version: 0.2.1rc3\nLicense-Expression: MIT\nLicense-File: LICENSE\n"
                    "Requires-Dist: deepseek-harness-runtime-bin==0.2.1rc3\n")
                archive.writestr(prefix + "WHEEL", "Wheel-Version: 1.0\nTag: py3-none-any\n")
                archive.writestr(prefix + "licenses/LICENSE", "isolated fixture")
            with zipfile.ZipFile(wheel, "a") as archive:
                for member in archive.infolist():
                    member.create_system = 0
                archive.comment = archive.comment
            receipt = {"commit": builder.load_lock()["commit"], "wheels": [{
                "filename": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
            }]}
            path = root / "deploy/deepseek-harness.build-linux.json"
            path.write_text(json.dumps(receipt), encoding="utf-8")
            with patch.object(builder, "ROOT", root):
                resources = builder.sdk_resources(wheel)
                self.assertEqual(set(resources), {prefix + "METADATA", prefix + "licenses/LICENSE"})
                with zipfile.ZipFile(wheel, "a") as archive:
                    for member in archive.infolist():
                        member.create_system = 3
                    archive.comment = archive.comment
                self.assertNotEqual(hashlib.sha256(wheel.read_bytes()).hexdigest(), receipt["wheels"][0]["sha256"])
                self.assertEqual(builder.sdk_resources(wheel), resources)
                self.assertEqual(hashlib.sha256(wheel.read_bytes()).hexdigest(), receipt["wheels"][0]["sha256"])
                with zipfile.ZipFile(wheel, "a") as archive:
                    archive.writestr("deepseek_harness/unexpected.py", "changed = True")
                with self.assertRaisesRegex(ValueError, "audited"):
                    builder.sdk_resources(wheel)

    def test_wrong_source_stops_before_installation_or_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(builder, "verify_source", side_effect=ValueError("wrong commit")), \
                patch.object(builder.subprocess, "run") as run:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "wrong commit"):
                builder.build(root, root, root / "node")
            self.assertEqual(list(root.iterdir()), [])
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

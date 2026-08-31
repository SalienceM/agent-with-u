import re
import unittest
from pathlib import Path


class DockerRuntimeDependencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repository = Path(__file__).resolve().parents[1]
        cls.dockerfile = (cls.repository / "deploy" / "Dockerfile").read_text(
            encoding="utf-8",
        )
        cls.requirements = (
            cls.repository / "deploy" / "requirements-docker.txt"
        ).read_text(encoding="utf-8")

    def test_qwen_code_sdk_is_pinned_for_backend_image(self) -> None:
        self.assertRegex(
            self.requirements,
            re.compile(r"^qwen-code-sdk==[^\s]+$", re.MULTILINE),
        )

    def test_qwen_cli_and_supported_node_runtime_are_built_in(self) -> None:
        self.assertIn("FROM node:20-bookworm-slim AS node-runtime", self.dockerfile)
        install_at = self.dockerfile.index('"@qwen-code/qwen-code@${QWEN_CODE_VERSION}"')
        probe_at = self.dockerfile.index("qwen --version")
        self.assertGreater(probe_at, install_at)

    def test_backend_build_probes_the_qwen_sdk_api_used_at_runtime(self) -> None:
        install_at = self.dockerfile.index(
            "pip install --no-cache-dir -r requirements-docker.txt",
        )
        probe_at = self.dockerfile.index("from qwen_code_sdk import")
        self.assertGreater(probe_at, install_at)
        for symbol in (
            "ProcessExitError",
            "is_sdk_assistant_message",
            "is_sdk_partial_assistant_message",
            "is_sdk_result_message",
            "query",
        ):
            self.assertIn(symbol, self.dockerfile[probe_at:])


if __name__ == "__main__":
    unittest.main()

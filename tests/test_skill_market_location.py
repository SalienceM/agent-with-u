import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS


class MarketLocationTests(unittest.TestCase):
    def test_actual_node_paths_are_read_only_and_respect_custom_data_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            library = root / "自定义目录" / "skill-library"
            runtime = root / "runtime-on-another-volume"
            bridge = BridgeWS.__new__(BridgeWS)
            bridge._skill_runtime = SimpleNamespace(root=runtime)
            with patch("src.backend.skill_store.LIBRARY_DIR", library), \
                    patch("socket.gethostname", return_value="build-node-02"), \
                    patch("platform.system", return_value="Linux"):
                result = json.loads(bridge._rpc_skillMarketLocation())
            self.assertEqual(result, {
                "status": "ok", "host": "build-node-02", "platform": "Linux",
                "libraryPath": str(library.resolve()), "runtimePath": str(runtime.resolve()),
            })
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

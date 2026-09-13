import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_market_jobs import SkillMarketJobs


class MarketJobTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_receipt_dedup_and_owner_boundary(self):
        jobs = SkillMarketJobs()
        gate = asyncio.Event()

        async def work():
            await gate.wait()
            return {"status": "ok", "items": []}

        first = jobs.start("alice", ("list", ""), work)
        second = jobs.start("alice", ("list", ""), work)
        self.assertEqual(first["jobId"], second["jobId"])
        self.assertEqual(first["state"], "running")
        with self.assertRaisesRegex(ValueError, "无权"):
            jobs.get("bob", first["jobId"])
        gate.set()
        await asyncio.gather(*jobs._tasks.values())
        result = jobs.get("alice", first["jobId"])
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["result"], {"status": "ok", "items": []})
        self.assertNotIn("owner", result)
        self.assertNotIn("key", result)

    async def test_error_is_observable_and_retry_starts_new_job(self):
        jobs = SkillMarketJobs()

        async def fail():
            raise ValueError("network failed")

        first = jobs.start("alice", ("list", ""), fail)
        await asyncio.gather(*jobs._tasks.values())
        self.assertEqual(jobs.get("alice", first["jobId"])["message"], "network failed")
        second = jobs.start("alice", ("list", ""), fail)
        self.assertNotEqual(first["jobId"], second["jobId"])
        await asyncio.gather(*jobs._tasks.values())

    async def test_bridge_background_list_and_install_return_without_waiting(self):
        gate = asyncio.Event()

        async def slow(*args, **kwargs):
            await gate.wait()
            return {"status": "ok", "items": [], "name": "demo"}

        bridge = BridgeWS.__new__(BridgeWS)
        bridge._skill_market_jobs = SkillMarketJobs()
        bridge._skill_market = SimpleNamespace(list_catalog=slow, install=slow, _sources_revision=0,
            _progress={"source": {"name": "Demo", "phase": "downloading", "downloaded": 90_000_000}})
        bridge._current_owner_id = lambda: "alice"
        first = json.loads(await asyncio.wait_for(bridge._rpc_skillMarketList("", True, True), .1))
        second = json.loads(await asyncio.wait_for(bridge._rpc_skillMarketInstall("source", "path", "digest", False, True), .1))
        self.assertEqual(first["state"], "running")
        self.assertEqual(second["state"], "running")
        progress = json.loads(bridge._rpc_skillMarketJobGet(first["jobId"]))
        self.assertEqual(progress["progress"][0]["downloaded"], 90_000_000)
        bridge._current_owner_id = lambda: "bob"
        self.assertEqual(json.loads(bridge._rpc_skillMarketJobGet(first["jobId"]))["status"], "error")
        gate.set()
        await asyncio.gather(*bridge._skill_market_jobs._tasks.values())

    async def test_legacy_awaited_rpc_remains_compatible(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._skill_market = SimpleNamespace(list_catalog=AsyncMock(return_value={"status": "ok", "items": []}))
        self.assertEqual(json.loads(await bridge._rpc_skillMarketList()), {"status": "ok", "items": []})


if __name__ == "__main__":
    unittest.main()

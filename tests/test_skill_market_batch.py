import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_market_batch import install_batch, parse_batch
from src.backend.skill_market_jobs import SkillMarketJobs
from src.backend.skill_market import SkillMarket
from src.backend.skill_store import SkillStore
from tests.test_standard_skill_market import make_zip


def progress_for(items):
    return {"total": len(items), "completed": 0, "items": [
        {**item, "status": "pending", "name": item["path"], "message": ""} for item in items
    ]}


class BatchTests(unittest.IsolatedAsyncioTestCase):
    def make_market(self, candidates, states=None):
        states = states or {}
        market = SimpleNamespace(
            list_sources=lambda: [{"id": "repo", "name": "Repo"}],
            _catalog_for_source=AsyncMock(return_value=(candidates, "main", [])),
            _public_item=lambda s, c, r: dict(installed=False, sameSource=False,
                updateAvailable=False, conflict=False, localModified=False) | states.get(c["path"], {}),
            install=AsyncMock(side_effect=lambda *a, **kw: {"name": a[1]}),
        )
        return market

    async def test_batch_preserves_conflicts_skips_current_and_keeps_partial_results(self):
        candidates = [{"name": name, "path": name, "digest": "d"} for name in
                      ["new", "current", "conflict", "dirty", "failed", "last"]]
        states = {"current": {"installed": True, "sameSource": True},
                  "conflict": {"conflict": True}, "dirty": {"localModified": True}}
        market = self.make_market(candidates, states)
        order = []

        async def install(source, path, digest, **kwargs):
            self.assertEqual(source, "repo")
            self.assertEqual(kwargs, {"allow_replace": False, "protect_local": True})
            order.append(path)
            await asyncio.sleep(0)
            if path == "failed":
                raise ValueError("download failed")
            return {"name": path}

        market.install.side_effect = install
        items = [{"path": c["path"], "digest": c["digest"]} for c in candidates]
        original = copy.deepcopy(items)
        result = await install_batch(market, "repo", items, False, progress_for(items))
        self.assertEqual(result["status"], "partial")
        self.assertEqual([r["status"] for r in result["batch"]["items"]],
                         ["installed", "skipped", "skipped", "skipped", "failed", "installed"])
        self.assertEqual(order, ["new", "failed", "last"])
        self.assertEqual(items, original)
        self.assertEqual(result["batch"]["completed"], 6)

    async def test_digest_duplicate_names_and_explicit_replace(self):
        candidates = [{"path": "one", "name": "duplicate", "digest": "d"},
                      {"path": "two", "name": "Duplicate", "digest": "d"},
                      {"path": "changed", "name": "changed", "digest": "new"},
                      {"path": "dirty", "name": "dirty", "digest": "d"}]
        market = self.make_market(candidates, {"dirty": {"localModified": True, "conflict": True}})
        items = [{"path": c["path"], "digest": "d"} for c in candidates] + [{"path": "foreign", "digest": "d"}]
        result = await install_batch(market, "repo", items, True, progress_for(items))
        self.assertEqual([r["status"] for r in result["batch"]["items"]],
                         ["skipped", "skipped", "failed", "installed", "failed"])
        market.install.assert_awaited_once_with("repo", "dirty", "d", allow_replace=True, protect_local=True)

    async def test_bridge_short_receipt_owner_and_terminal_idempotency(self):
        gate = asyncio.Event()
        market = self.make_market([{"path": "new", "name": "new", "digest": "d"}])

        async def install(*args, **kwargs):
            await gate.wait()
            return {"name": "new"}

        market.install.side_effect = install
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._current_owner_id = lambda: "alice"
        bridge._skill_market = market
        bridge._skill_market_jobs = SkillMarketJobs()
        args = ("repo", '[{"path":"new","digest":"d"}]', False, "request-1")
        first = json.loads(bridge._rpc_skillMarketInstallBatch(*args))
        self.assertEqual(first["state"], "running")
        second = json.loads(bridge._rpc_skillMarketInstallBatch(*args))
        self.assertEqual(second["jobId"], first["jobId"])
        with self.assertRaisesRegex(ValueError, "无权"):
            bridge._skill_market_jobs.get("bob", first["jobId"])
        gate.set()
        await asyncio.gather(*bridge._skill_market_jobs._tasks.values())
        terminal = json.loads(bridge._rpc_skillMarketInstallBatch(*args))
        self.assertEqual(terminal["state"], "done")
        self.assertEqual(terminal["jobId"], first["jobId"])
        self.assertEqual(market.install.await_count, 1)
        changed = json.loads(bridge._rpc_skillMarketInstallBatch(*args[:2], True, args[3]))
        self.assertEqual(changed["status"], "error")

    async def test_real_import_reuses_archive_and_copies_all_support_files(self):
        archive = make_zip({
            f"repo-main/skills/{name}/{file}": content
            for name in ("first", "second") for file, content in {
                "SKILL.md": f"---\nname: {name}\ndescription: Batch demo\n---\nRead scripts/check.py",
                "scripts/check.py": "raise RuntimeError('must never execute during import')",
                "references/guide.md": "Usage guide",
            }.items()
        })
        downloads = []

        def handler(request):
            if request.url.host == "api.github.com":
                return httpx.Response(403, json={})
            downloads.append(str(request.url))
            return httpx.Response(200, content=archive)

        with tempfile.TemporaryDirectory() as tmp, patch.multiple("src.backend.skill_store",
                LIBRARY_DIR=Path(tmp) / "library", INDEX_FILE=Path(tmp) / "library/index.json",
                SECRETS_DIR=Path(tmp) / "secrets"), patch("src.backend.skill_market.DEFAULT_SOURCES", []):
            market = SkillMarket(SkillStore(), data_dir=Path(tmp) / "market", transport=httpx.MockTransport(handler))
            source = market.add_source("example/skills")
            catalog = await market.list_catalog()
            items = [{"path": row["path"], "digest": row["digest"]} for row in catalog["items"]]
            result = await install_batch(market, source["id"], items, False, progress_for(items))
            self.assertEqual([r["status"] for r in result["batch"]["items"]], ["installed", "installed"])
            self.assertEqual(len(downloads), 1)
            for name in ("first", "second"):
                self.assertTrue((Path(tmp) / "library" / name / "scripts/check.py").is_file())
                self.assertTrue((Path(tmp) / "library" / name / "references/guide.md").is_file())
            repeated = await install_batch(market, source["id"], items, False, progress_for(items))
            self.assertEqual([r["status"] for r in repeated["batch"]["items"]], ["skipped", "skipped"])
            self.assertEqual(len(downloads), 1)

    def test_schema_rejects_empty_large_duplicate_and_extra_fields(self):
        self.assertEqual(parse_batch('[{"path":"","digest":"d"}]'), [{"path": "", "digest": "d"}])
        for value in [[], {}, [None], [{"path": "x", "digest": ""}],
                      [{"path": "x", "digest": "d", "command": "bad"}],
                      [{"path": "x", "digest": "d"}] * 2,
                      [{"path": str(i), "digest": "d"} for i in range(501)]]:
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                parse_batch(json.dumps(value))

    def test_atomic_store_protection_preserves_edits_and_other_sources(self):
        with tempfile.TemporaryDirectory() as tmp, patch.multiple("src.backend.skill_store",
                LIBRARY_DIR=Path(tmp) / "library", INDEX_FILE=Path(tmp) / "library/index.json",
                SECRETS_DIR=Path(tmp) / "secrets"):
            store = SkillStore()
            files = {"SKILL.md": b"---\nname: batch-demo\ndescription: Demo\n---\nOriginal"}
            source = {"kind": "github", "repository": "example/skills", "ref": "main", "path": "demo"}
            store.install_standard_files(files, source=source)
            store.save_skill("batch-demo", files["SKILL.md"].decode() + "\nLocal edit")
            with self.assertRaises(FileExistsError):
                store.install_standard_files(files, source=source, protect_local=True)
            self.assertIn("Local edit", store.get_skill("batch-demo")["content"])
            store.install_standard_files(files, source={**source, "repository": "other/skills"})
            with self.assertRaises(FileExistsError):
                store.install_standard_files(files, source=source, protect_local=True)
            store.install_standard_files(files, source=source)  # explicitly allowed overwrite
            self.assertEqual(store.get_skill("batch-demo")["source"]["repository"], "example/skills")


if __name__ == "__main__":
    unittest.main()

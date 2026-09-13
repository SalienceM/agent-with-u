"""Large repository discovery must not load/cache the whole ZIP or its assets."""
import asyncio
import gc
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import httpx

from src.backend.skill_market import SkillMarket
from src.backend.skill_runtime import SkillRuntime
from src.backend.skill_store import (
    SkillStore, standard_skills_from_zip_bytes, standard_skills_from_zip_file,
)


MARKDOWN = b"---\nname: large-repo-demo\ndescription: Test a complete Skill in a large repository.\n---\nRead references/guide.md and run scripts/check.py.\n"


def small_archive(asset: bytes = b"original") -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("repo-main/skills/large-repo-demo/SKILL.md", MARKDOWN)
        zf.writestr("repo-main/skills/large-repo-demo/scripts/check.py", b"raise RuntimeError('never execute')")
        zf.writestr("repo-main/skills/large-repo-demo/references/guide.md", asset)
        zf.writestr("repo-main/docs/unused.bin", b"not a Skill asset")
    return output.getvalue()


class FileStream(httpx.AsyncByteStream):
    def __init__(self, path: Path):
        self.path = path

    async def __aiter__(self):
        with self.path.open("rb") as stream:
            while chunk := stream.read(256 * 1024):
                yield chunk


class LargeRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patchers = [
            patch("src.backend.skill_store.LIBRARY_DIR", self.root / "library"),
            patch("src.backend.skill_store.INDEX_FILE", self.root / "library" / "index.json"),
            patch("src.backend.skill_store.SECRETS_DIR", self.root / "secrets"),
            patch("src.backend.skill_market.DEFAULT_SOURCES", []),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.store = SkillStore()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def market(self, handler):
        return SkillMarket(self.store, data_dir=self.root / "market", transport=httpx.MockTransport(handler))

    def test_real_over_64_mib_repository_lists_and_installs_complete_skill(self):
        package = self.root / "large.zip"
        package.write_bytes(small_archive())
        # Stored, not compressible padding: exercise an actual >64 MiB transfer.
        with zipfile.ZipFile(package, "a", zipfile.ZIP_STORED) as zf:
            with zf.open("repo-main/projects/demo-video.bin", "w") as output:
                for _ in range(65):
                    output.write(b"x" * (1024 * 1024))
        self.assertGreater(package.stat().st_size, 64 * 1024 * 1024)
        downloads = []

        def handler(request):
            if request.url.host == "api.github.com":
                return httpx.Response(403)
            downloads.append(str(request.url))
            return httpx.Response(200, headers={"content-length": str(package.stat().st_size)}, stream=FileStream(package))

        async def run():
            market = self.market(handler)
            source = market.add_source("example/skills", branch="main")
            catalog = await market.list_catalog()
            self.assertEqual(catalog["sources"][0]["error"], "")
            self.assertEqual(len(catalog["items"]), 1)
            item = catalog["items"][0]
            snapshot = market._archive_cache[source["id"]][1]
            self.assertIsInstance(snapshot.path, Path)
            self.assertEqual(snapshot.path.stat().st_size, package.stat().st_size)
            metadata = market._catalog_cache[source["id"]][1][0]
            self.assertNotIn("files", metadata)
            self.assertEqual(metadata["digest"], standard_skills_from_zip_bytes(small_archive(), repository_mode=True)[0]["digest"])
            result = await market.install(source["id"], item["path"], item["digest"])
            self.assertEqual(result["fileCount"], 3)
            self.assertEqual((self.root / "library/large-repo-demo/references/guide.md").read_bytes(), b"original")
            self.assertTrue((self.root / "library/large-repo-demo/scripts/check.py").exists())
            self.assertFalse((self.root / "library/large-repo-demo/projects").exists())
            self.assertEqual(len(downloads), 1)
            self.assertFalse((await market.list_catalog())["items"][0]["updateAvailable"])
            path = snapshot.path
            self.assertTrue(market.remove_source(source["id"]))
            # Readers keep an immutable snapshot alive across cache eviction.
            self.assertTrue(path.exists())
            del snapshot
            gc.collect()
            self.assertFalse(path.exists())

        asyncio.run(run())

    def test_unknown_content_length_download_is_supported(self):
        path = self.root / "small.zip"
        path.write_bytes(small_archive())
        market = self.market(lambda request: httpx.Response(200, stream=FileStream(path)))
        source = market.add_source("example/skills")
        items, ref, issues = asyncio.run(market._catalog_for_source(source))
        self.assertEqual(len(items), 1)
        self.assertEqual((ref, issues), ("main", []))

    def test_large_skill_with_thirteen_thousand_assets_is_fully_installed(self):
        package = self.root / "many-files.zip"
        package.write_bytes(small_archive())
        with zipfile.ZipFile(package, "a", zipfile.ZIP_DEFLATED) as zf:
            for index in range(13_000):
                zf.writestr(f"repo-main/skills/large-repo-demo/assets/{index}.svg", b"<svg/>" * 1024)
        market = self.market(lambda request: httpx.Response(200, stream=FileStream(package)))
        source = market.add_source("example/skills")

        async def run():
            items, _, issues = await market._catalog_for_source(source)
            self.assertEqual(issues, [])
            self.assertEqual(items[0]["fileCount"], 13_003)
            self.assertGreater(items[0]["size"], 64 * 1024 * 1024)
            installed = await market.install(source["id"], items[0]["path"], items[0]["digest"])
            self.assertEqual(installed["fileCount"], 13_003)
            self.assertEqual(installed["digest"], items[0]["digest"])
            self.assertTrue((self.root / "library/large-repo-demo/assets/12999.svg").exists())
            runtime = SkillRuntime(self.store, self.root / "runtime")
            plan = await asyncio.to_thread(runtime.inspect, "large-repo-demo")
            self.assertEqual(plan["fileCount"], 13_003)
            self.assertNotEqual(plan["status"], "ready")  # 导入不等于已执行依赖准备。

        asyncio.run(run())

    def test_limit_is_enforced_on_headers_and_stream_and_partial_files_are_cleaned(self):
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"x" * 300_000

        directories = []
        real_tempdir = tempfile.TemporaryDirectory

        def new_tempdir(**kwargs):
            directory = real_tempdir(dir=self.root, **kwargs)
            directories.append(Path(directory.name))
            return directory

        async def run():
            for headers in ({"content-length": "300000"}, {}):
                market = self.market(lambda request: httpx.Response(200, headers=headers, stream=Stream()))
                source = market.add_source("example/skills", branch="main")
                with self.assertRaisesRegex(ValueError, "1 GiB"):
                    await market._download_archive(source)
                self.assertEqual(market._archive_cache, {})

        with patch("src.backend.skill_market.MAX_REPOSITORY_ARCHIVE_BYTES", 1000), patch("src.backend.skill_market.tempfile.TemporaryDirectory", new_tempdir):
            asyncio.run(run())
        self.assertTrue(directories)
        self.assertTrue(all(not path.exists() for path in directories))

    def test_cancelled_download_removes_partial_archive(self):
        async def run():
            started = asyncio.Event()

            class Stream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield b"x" * (256 * 1024)
                    started.set()
                    await asyncio.Event().wait()

            directories = []
            real_tempdir = tempfile.TemporaryDirectory

            def new_tempdir(**kwargs):
                directory = real_tempdir(dir=self.root, **kwargs)
                directories.append(Path(directory.name))
                return directory

            market = self.market(lambda request: httpx.Response(200, stream=Stream()))
            source = market.add_source("example/skills", branch="main")
            with patch("src.backend.skill_market.tempfile.TemporaryDirectory", new_tempdir):
                task = asyncio.create_task(market._download_archive(source))
                await asyncio.wait_for(started.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(market._archive_cache, {})
            self.assertTrue(directories)
            self.assertTrue(all(not path.exists() for path in directories))

        asyncio.run(run())

    def test_concurrent_catalog_requests_reuse_one_download(self):
        calls = []

        async def handler(request):
            calls.append(request)
            await asyncio.sleep(0.01)
            return httpx.Response(200, content=small_archive())

        async def run():
            market = self.market(handler)
            source = market.add_source("example/skills")
            first, second = await asyncio.gather(market._catalog_for_source(source), market._catalog_for_source(source))
            self.assertEqual(first, second)
            self.assertEqual(len(calls), 1)

        asyncio.run(run())

    def test_branch_upgrade_during_download_cannot_repopulate_stale_cache(self):
        async def run():
            started, release = asyncio.Event(), asyncio.Event()

            async def handler(request):
                started.set()
                await release.wait()
                return httpx.Response(200, content=small_archive())

            market = self.market(handler)
            source = market.add_source("example/skills")
            task = asyncio.create_task(market._catalog_for_source(source))
            await started.wait()
            explicit = market.add_source("example/skills", branch="main")
            self.assertEqual(source["id"], explicit["id"])
            release.set()
            with self.assertRaisesRegex(ValueError, "来源配置已变更"):
                await task
            self.assertNotIn(source["id"], market._catalog_cache)
            self.assertNotIn(source["id"], market._archive_cache)

        asyncio.run(run())

    def test_evicted_archive_changed_remote_content_requires_new_review(self):
        payload = small_archive()
        market = self.market(lambda request: httpx.Response(200, content=payload))
        source = market.add_source("example/skills")

        async def run():
            nonlocal payload
            items, _, _ = await market._catalog_for_source(source)
            market._archive_cache.clear()
            payload = small_archive(b"changed after preview")
            with self.assertRaisesRegex(ValueError, "条目已变化"):
                await market.install(source["id"], items[0]["path"], items[0]["digest"])
            self.assertIsNone(self.store.get_skill("large-repo-demo"))

        asyncio.run(run())

    def test_file_inspection_retains_per_skill_limits_and_does_not_read_unrelated_assets(self):
        package = self.root / "repo.zip"
        package.write_bytes(small_archive())
        with zipfile.ZipFile(package, "a") as zf:
            zf.writestr("repo-main/docs/huge.bin", b"x" * 5000)
        with patch("src.backend.skill_store.MAX_STANDARD_FILE_BYTES", 1000):
            items = standard_skills_from_zip_file(package)
        self.assertEqual(len(items), 1)
        with zipfile.ZipFile(package, "a") as zf:
            zf.writestr("repo-main/skills/large-repo-demo/assets/huge.bin", b"x" * 5000)
        issues = []
        with patch("src.backend.skill_store.MAX_STANDARD_FILE_BYTES", 1000):
            items = standard_skills_from_zip_file(package, skip_invalid=True, issues=issues)
        self.assertEqual(items, [])
        self.assertIn("文件过大", issues[0]["message"])

    def test_install_selection_still_excludes_nested_skills(self):
        package = self.root / "nested.zip"
        package.write_bytes(small_archive())
        with zipfile.ZipFile(package, "a") as zf:
            zf.writestr("repo-main/skills/large-repo-demo/nested/SKILL.md", MARKDOWN.replace(b"large-repo-demo", b"nested"))
        candidates = standard_skills_from_zip_file(package, include_files=True, skill_path="skills/large-repo-demo")
        self.assertEqual(len(candidates), 1)
        self.assertNotIn("nested/SKILL.md", candidates[0]["files"])

    def test_expanded_size_and_file_count_still_fail_closed(self):
        package = self.root / "bounded.zip"
        package.write_bytes(small_archive())
        for limit in ("MAX_STANDARD_SKILL_BYTES", "MAX_STANDARD_FILES"):
            with patch(f"src.backend.skill_store.{limit}", 2):
                with self.assertRaises(ValueError):
                    standard_skills_from_zip_file(package)
                with self.assertRaises(ValueError):
                    self.store.install_standard_files({"SKILL.md": MARKDOWN, "a": b"a", "b": b"b"})

    def test_repository_entry_limit_is_enforced(self):
        package = self.root / "entries.zip"
        package.write_bytes(small_archive())
        with patch("src.backend.skill_store.MAX_REPOSITORY_ENTRIES", 2):
            with self.assertRaisesRegex(ValueError, "条目数"):
                standard_skills_from_zip_file(package)

    def test_disk_cache_eviction_preserves_only_bounded_snapshots(self):
        async def run():
            market = self.market(lambda request: httpx.Response(200, content=small_archive()))
            first = market.add_source("example/first")
            await market._catalog_for_source(first)
            first_path = market._archive_cache[first["id"]][1].path
            second = market.add_source("example/second")
            await market._catalog_for_source(second)
            gc.collect()
            self.assertEqual(len(market._archive_cache), 1)
            self.assertFalse(first_path.exists())

        with patch("src.backend.skill_market.MAX_CACHED_ARCHIVES", 1):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

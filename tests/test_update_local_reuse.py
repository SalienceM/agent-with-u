"""精确版本/内容匹配才复用本机包；测试安装器仅是惰性字节。"""
import copy
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tests import test_kit_standalone_update as fixture


class LocalReuseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.StandaloneUpdateTests.asyncSetUp
    asyncTearDown = fixture.StandaloneUpdateTests.asyncTearDown
    until = fixture.StandaloneUpdateTests.until
    run_update = fixture.StandaloneUpdateTests.run_update

    def register(self):
        self.original = self.document['artifacts'][0]['url']
        self.document['artifacts'][0]['url'] = 'https://fixture.invalid/installer.msi'
        center = self.bridge._release_center()
        candidate = {**self.document['release'], 'id': 'registered', 'status': 'published',
                     'projectRoot': str(self.root),
                     'artifacts': [{**self.document['artifacts'][0], 'path': self.original}]}
        with center._guard():
            state = center._load_state()
            state['candidates'] = [candidate]
            center._save_state(state)
        return center, candidate

    async def test_registered_build_then_staged_cache_never_download(self):
        self.register()
        download = AsyncMock(side_effect=AssertionError('匹配本机包不应下载'))
        with patch('src.backend.update_download.download_http', download):
            run, step, runtime = await self.run_update()
            self.assertEqual('waiting_approval', run.status, run.to_dict())
            self.assertEqual('registered_build', runtime['plan']['transferSource'])
            staged = Path(self.manager.status()['stagedPath'])
            self.assertEqual(Path(self.original).read_bytes(), staged.read_bytes())
            self.bridge._rpc_kitCancel(self.session.id, run.id)
            Path(self.original).unlink()
            run, step, runtime = await self.run_update()
            self.assertEqual('waiting_approval', run.status, run.to_dict())
            self.assertEqual('staged_cache', runtime['plan']['transferSource'])
            download.assert_not_awaited()

    async def test_mismatched_content_downloads_expected_manifest_artifact(self):
        self.register()
        expected = Path(self.original).read_bytes()
        Path(self.original).write_bytes(b'wrong' * 10)
        async def download(url, target, sha, size, *args):
            self.assertEqual(self.document['artifacts'][0]['url'], url)
            target.write_bytes(expected)
            return size, sha
        downloader = AsyncMock(side_effect=download)
        with patch('src.backend.update_download.download_http', downloader):
            run, step, runtime = await self.run_update()
        self.assertEqual('waiting_approval', run.status, run.to_dict())
        self.assertEqual('download', runtime['plan']['transferSource'])
        downloader.assert_awaited_once()
        self.assertEqual(expected, Path(self.manager.status()['stagedPath']).read_bytes())

    async def test_matching_filename_or_version_alone_is_not_enough(self):
        center, candidate = self.register()
        release = copy.deepcopy(self.document['release'])
        release['buildId'] = 'different-build'
        self.assertEqual('', center.local_update_artifact(release, self.document['artifacts'][0], center.state_path))
        artifact = copy.deepcopy(self.document['artifacts'][0])
        artifact['sha256'] = 'a' * 64
        self.assertEqual('', center.local_update_artifact(self.document['release'], artifact, center.state_path))

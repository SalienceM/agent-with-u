"""上传进度回归：仅使用临时账本、假进程和受控输出，不连接发布服务。"""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.backend.release_center import ReleaseCenterError, ReleaseCenterManager


class FakeUploadProcess:
    def __init__(self) -> None:
        self.pid = 0
        self.returncode: int | None = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.exited = asyncio.Event()

    async def wait(self) -> int:
        await self.exited.wait()
        return int(self.returncode or 0)

    def finish(self, code: int = 0) -> None:
        self.returncode = code
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.exited.set()


class ReleaseUploadProgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manager = ReleaseCenterManager(self.root / "release-center")
        self.path = self.root / "artifact.bin"
        self.path.write_bytes(b"x" * 1_000)
        with self.manager._guard():
            state = self.manager._load_state()
            state["jobs"] = [
                {"id": job_id, "status": "running", "progress": 0, "log": []}
                for job_id in ("job", "other-job")
            ]
            self.manager._save_state(state)
        self.updates: asyncio.Queue[dict] = asyncio.Queue()
        self.observed: list[dict] = []
        loop = asyncio.get_running_loop()
        update = self.manager._update_job

        def capture(job_id: str, patch: dict) -> dict:
            result = update(job_id, patch)
            self.observed.append(result)
            loop.call_soon_threadsafe(self.updates.put_nowait, result)
            return result

        patcher = mock.patch.object(self.manager, "_update_job", side_effect=capture)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def wait_for_bytes(self, amount: int, job_id: str = "job") -> dict:
        async def receive() -> dict:
            while True:
                job = await self.updates.get()
                if job["id"] == job_id and job.get("currentFileBytes") == amount:
                    return job

        return await asyncio.wait_for(receive(), 2)

    async def upload(
        self, process: FakeUploadProcess, *, job_id: str = "job", completed: int = 0,
    ) -> None:
        with mock.patch.object(
            asyncio, "create_subprocess_exec", new=mock.AsyncMock(return_value=process),
        ) as spawn:
            await self.manager._upload(
                job_id, "qshell", "bucket", "artifact.bin", self.path,
                completed_bytes=completed, total_bytes=2_000,
            )
            spawn.assert_awaited_once()

    async def test_late_stdout_stderr_percentages_cannot_rewind_progress(self) -> None:
        process = FakeUploadProcess()
        late_seen = asyncio.Event()
        report = self.manager._report_upload_progress

        async def observe(job_id: str, current: int, *args, **kwargs) -> None:
            await report(job_id, current, *args, **kwargs)
            if current == 310:
                late_seen.set()

        patcher = mock.patch.object(self.manager, "_report_upload_progress", side_effect=observe)
        patcher.start()
        self.addCleanup(patcher.stop)
        task = asyncio.create_task(self.upload(process))
        try:
            await self.wait_for_bytes(0)
            process.stdout.feed_data(b"upload 70%\r")
            await self.wait_for_bytes(700)
            process.stderr.feed_data(b"upload 31%\r")
            await asyncio.wait_for(late_seen.wait(), 2)
            process.stderr.feed_data(b"upload 80%\r")
            await self.wait_for_bytes(800)
            process.stdout.feed_data(b"upload 90")
            process.stdout.feed_data(b"%\r")
            await self.wait_for_bytes(900)
        finally:
            process.finish()
            await task
        observed = [item["uploadedBytes"] for item in self.observed]
        self.assertEqual(sorted(observed), observed)
        self.assertEqual(1_000, observed[-1])
        self.assertEqual(50, self.observed[-1]["progress"])

    async def test_no_percentage_keeps_last_known_bytes_until_success(self) -> None:
        process = FakeUploadProcess()
        task = asyncio.create_task(self.upload(process, completed=1_000))
        try:
            await self.wait_for_bytes(0)
            process.stdout.feed_data(b"preparing upload\n")
            await asyncio.sleep(0.02)
            job = self.manager.job_status("job")
            self.assertEqual(1_000, job["uploadedBytes"])
            self.assertEqual(0, job["currentFileBytes"])
        finally:
            process.finish()
            await task
        self.assertEqual(2_000, self.observed[-1]["uploadedBytes"])
        # 全部字节上传后仍须等待公开 manifest 校验，不能提前显示发布成功。
        self.assertEqual(99, self.observed[-1]["progress"])
        self.assertEqual("running", self.observed[-1]["status"])

    async def test_each_file_and_job_has_its_own_progress(self) -> None:
        for job_id, completed, percentage in (
            ("job", 0, 80), ("job", 1_000, 10), ("other-job", 0, 20),
        ):
            process = FakeUploadProcess()
            task = asyncio.create_task(self.upload(process, job_id=job_id, completed=completed))
            try:
                initial = await self.wait_for_bytes(0, job_id)
                self.assertEqual(completed, initial["uploadedBytes"])
                process.stdout.feed_data(f"{percentage}%\r".encode())
                current = await self.wait_for_bytes(percentage * 10, job_id)
                self.assertEqual(completed + percentage * 10, current["uploadedBytes"])
            finally:
                process.finish()
                await task

    async def test_failed_upload_does_not_claim_remaining_bytes(self) -> None:
        process = FakeUploadProcess()
        task = asyncio.create_task(self.upload(process))
        await self.wait_for_bytes(0)
        process.stdout.feed_data(b"31%\r")
        await self.wait_for_bytes(310)
        process.stderr.feed_data(b"upload failed")
        process.finish(1)
        with self.assertRaisesRegex(ReleaseCenterError, "upload failed"):
            await task
        self.assertEqual(310, self.manager.job_status("job")["uploadedBytes"])

    async def test_cancelled_upload_does_not_leave_progress_readers(self) -> None:
        process = FakeUploadProcess()
        task = asyncio.create_task(self.upload(process))
        await self.wait_for_bytes(0)
        process.stdout.feed_data(b"31%\r")
        await self.wait_for_bytes(310)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.manager._update_job("job", {"status": "cancelled"})
        count = len(self.observed)
        process.stdout.feed_data(b"90%\r")
        process.finish()
        await asyncio.sleep(0.02)
        self.assertEqual(count, len(self.observed))
        self.assertEqual(310, self.manager.job_status("job")["currentFileBytes"])


if __name__ == "__main__":
    unittest.main()

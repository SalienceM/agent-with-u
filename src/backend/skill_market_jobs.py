"""Short owner-scoped RPC receipts for slow market downloads/installations."""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Awaitable, Callable


class SkillMarketJobs:
    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def start(self, owner: str, key: tuple, work: Callable[[], Awaitable[dict]]) -> dict:
        now = time.time()
        for job_id, job in list(self._jobs.items()):
            if job["state"] != "running" and now - job["createdAt"] > 900:
                del self._jobs[job_id]
        for job in self._jobs.values():
            if job["owner"] == owner and job["key"] == key and job["state"] == "running":
                return self.get(owner, job["jobId"])
        if sum(job["state"] == "running" for job in self._jobs.values()) >= 8:
            raise ValueError("市场任务较多，请等待已有任务完成")
        if len(self._jobs) >= 64:
            oldest = next(job_id for job_id, job in self._jobs.items() if job["state"] != "running")
            del self._jobs[oldest]
        job_id = uuid.uuid4().hex
        job = {"owner": owner, "key": key, "jobId": job_id, "createdAt": now, "state": "running"}
        self._jobs[job_id] = job

        async def run() -> None:
            try:
                job["result"] = await asyncio.wait_for(work(), timeout=660)
                job["state"] = "done"
            except asyncio.CancelledError:
                job.update(state="error", message="市场任务已中断，请重试")
                raise
            except asyncio.TimeoutError:
                job.update(state="error", message="市场任务超时，请检查网络后重试")
            except Exception as exc:
                job.update(state="error", message=str(exc))
            finally:
                self._tasks.pop(job_id, None)

        self._tasks[job_id] = asyncio.create_task(run())
        return self.get(owner, job_id)

    def get(self, owner: str, job_id: str) -> dict:
        job = self._jobs.get(job_id)
        if not job or job["owner"] != owner:
            raise ValueError("市场任务不存在、已过期或无权查看")
        return {"status": "ok", **{key: value for key, value in job.items() if key not in {"owner", "key"}}}

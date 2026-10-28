"""单次 Harness worker；取消 asyncio 等待者不取消/释放实际运行归属。"""
from __future__ import annotations

import asyncio
import concurrent.futures
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Callable

from .deepseek_harness_sdk import SyncOwner
from .deepseek_harness_state import HarnessLayout, HarnessReservation, atomic_json, reject_links

_ACTIVE: dict[str, "HarnessWorker"] = {}
_REGISTRY_LOCK = threading.Lock()


class HarnessWorker:
    def __init__(self, layout: HarnessLayout, generation: str, *, activity_parent: str | None = None,
                 ephemeral: bool = False) -> None:
        if not re.fullmatch(r"[a-f0-9]{32}", generation):
            raise ValueError("Harness generation 必须是独立运行 UUID")
        self.layout, self.generation = layout, generation
        self.reservation = HarnessReservation(layout)
        self.owner = SyncOwner(generation=generation, receipt=layout.runs / generation / "exit.json")
        self.stop_requested = threading.Event()
        self.events: asyncio.Queue[Any] = asyncio.Queue(maxsize=128)
        self.task: asyncio.Task[Any] | None = None
        self.client: Any = None
        self.key = str(layout.guard_root)
        self.confirmed = False
        self.ephemeral = ephemeral
        self.failure: BaseException | None = None
        self.parent_marker: Path | None = None
        if activity_parent and activity_parent != layout.session:
            parent = HarnessLayout.for_session(owner=layout.owner, executor=layout.executor,
                backend=layout.backend, session=activity_parent)
            self.parent_marker = parent.guard_root / "children" / (generation + ".json")

    def start(self, work: Callable[["HarnessWorker", Callable[[Any], None]], Any]) -> None:
        loop = asyncio.get_running_loop()
        with _REGISTRY_LOCK:
            if self.key in _ACTIVE:
                raise RuntimeError("Harness Session 仍有运行或未确认退出，不可重入")
            _ACTIVE[self.key] = self

        def publish(event: Any) -> None:
            if self.stop_requested.is_set():
                raise RuntimeError("Harness 运行已停止")
            future = asyncio.run_coroutine_threadsafe(self.events.put(event), loop)
            try:
                future.result(timeout=2)
            except concurrent.futures.TimeoutError as exc:
                future.cancel()
                raise RuntimeError("Harness 异步消费背压超出限额") from exc

        def run() -> Any:
            try:
                self.reservation.acquire()
                run_dir = self.layout.runs / self.generation
                run_dir.mkdir(mode=0o700)
                self.reservation.mark_active(self.generation)
                if self.parent_marker:
                    reject_links(self.parent_marker)
                    self.parent_marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    atomic_json(self.parent_marker, {"generation": self.generation, "status": "running"})
                if self.stop_requested.is_set():
                    self.confirmed = True  # 尚未调用任何进程创建。
                    raise RuntimeError("Harness 启动前已取消")
                return work(self, publish)
            except BaseException as exc:
                self.failure = exc
                raise
            finally:
                if self.client is not None:
                    try:
                        self.client.close()
                    except BaseException:
                        pass
                self.confirmed = (self.confirmed or self.owner.confirmed
                                  or not self.owner.spawn_attempted)
                owned = self.reservation.acquired
                self.reservation.release(confirmed=self.confirmed)
                if self.confirmed and self.parent_marker:
                    self.parent_marker.unlink(missing_ok=True)
                if self.confirmed:
                    with _REGISTRY_LOCK:
                        if _ACTIVE.get(self.key) is self:
                            _ACTIVE.pop(self.key)
                    if self.ephemeral and owned:
                        # 只删除本次随机原生上下文；未知退出保留目录和活动证明。
                        reject_links(self.layout.root)
                        shutil.rmtree(self.layout.root)

        self.task = asyncio.create_task(asyncio.to_thread(run), name="awu-harness-owned-worker")
        # detached waiter 的异常仍被读取；失败不释放 unknown 的注册项。
        self.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())

    async def consume(self, on_event: Callable[[Any], Any]) -> Any:
        if self.task is None:
            raise RuntimeError("Harness worker 尚未启动")
        next_event: asyncio.Task[Any] | None = None
        try:
            while not self.task.done() or not self.events.empty():
                next_event = asyncio.create_task(self.events.get())
                await asyncio.wait({next_event, self.task}, return_when=asyncio.FIRST_COMPLETED)
                if next_event.done():
                    result = on_event(next_event.result())
                    if asyncio.iscoroutine(result):
                        await result
                    next_event = None
                elif self.task.done():
                    next_event.cancel()
                    await asyncio.gather(next_event, return_exceptions=True)
                    next_event = None
                    break
            result = await asyncio.shield(self.task)
            if not self.confirmed:
                raise RuntimeError("Harness 进程树退出未确认，活动保护保留")
            return result
        except BaseException:
            self.request_stop()
            raise
        finally:
            if next_event:
                next_event.cancel()
                await asyncio.gather(next_event, return_exceptions=True)

    def request_stop(self) -> None:
        self.stop_requested.set()
        # terminate 仅发送拥有的 Job/supervisor 信号，不等待或按进程名操作。
        self.owner.terminate()


def active_worker(layout: HarnessLayout) -> HarnessWorker | None:
    with _REGISTRY_LOCK:
        return _ACTIVE.get(str(layout.guard_root))


def session_has_activity(*, owner: str, session: str, executor: str = "local") -> bool:
    # 守卫与 Backend ID 无关：改配置、删除缓存实例或切换后端不能解锁同一 Session。
    layout = HarnessLayout.for_session(owner=owner, executor=executor, backend="activity-check", session=session)
    worker = active_worker(layout)
    children = layout.guard_root / "children"
    reject_links(children)
    return bool(worker and not worker.confirmed) or layout.activity_file.exists() or (children.exists() and any(children.glob("*.json")))


def stop_session(*, owner: str, session: str, executor: str = "local") -> None:
    layout = HarnessLayout.for_session(owner=owner, executor=executor, backend="activity-check", session=session)
    worker = active_worker(layout)
    if worker:
        worker.request_stop()

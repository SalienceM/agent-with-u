"""单次旁路的只读查询拥有权；取消等待不会遗忘尚未退出的磁盘操作。"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from .aside_files import ReadonlyFiles
from .aside_inspection import InspectionError, QueryBudget, QueryIdentity, ReadQuery, clean_inspection


class InspectionQueries:
    def __init__(self, identity: QueryIdentity, validate: Callable[[], None],
                 runtime: Callable[[], dict], *, budget: QueryBudget | None = None,
                 openspec: Callable[[ReadonlyFiles, dict], dict] | None = None) -> None:
        self.identity = identity
        self.validate = validate
        self.runtime = runtime
        self.budget = budget or QueryBudget()
        self.files = ReadonlyFiles(identity, self.budget)
        self.openspec = openspec
        self.pending: set[asyncio.Task] = set()
        self.sources: list[dict] = []

    def cancel(self) -> None:
        self.budget.cancelled.set()

    async def settled(self, seconds: float = 0.2) -> bool:
        if self.pending:
            await asyncio.wait(self.pending, timeout=seconds)
        return not any(not task.done() for task in self.pending)

    def _finished(self, task: asyncio.Task) -> None:
        self.pending.discard(task)
        if not task.cancelled():
            task.exception()  # 等待方已取消时也消费异常；不回填迟到结果。

    def _read(self, query: ReadQuery) -> dict:
        args = query.arguments
        if query.operation == 'list_directory':
            return self.files.directory(**args)
        if query.operation == 'read_text':
            return self.files.text(**args)
        if query.operation == 'search_text':
            return self.files.search(**args)
        if query.operation == 'openspec_tasks' and self.openspec:
            return self.openspec(self.files, args)
        raise InspectionError('unsupported', '此查询能力不可用。')

    async def execute(self, packet: Any) -> dict:
        query = ReadQuery.parse(packet)
        self.validate()
        self.budget.operation()
        try:
            if query.operation == 'runtime_status':
                result = self.runtime()
            else:
                self.identity.file_root()
                task = asyncio.create_task(asyncio.to_thread(self._read, query))
                self.pending.add(task)
                task.add_done_callback(self._finished)
                try:
                    result = await asyncio.wait_for(asyncio.shield(task), self.budget.remaining())
                except asyncio.TimeoutError:
                    self.cancel()
                    raise InspectionError('timeout', '读取超时，清理结果待确认。') from None
            self.validate()
            self.budget.check()
        except InspectionError as exc:
            result = exc.result()
        except FileNotFoundError:
            result = InspectionError('missing', '目标文件或目录不存在。').result()
        except PermissionError:
            result = InspectionError('denied', '访问被拒绝；未改权限或切换执行身份。').result()
        except OSError:
            result = InspectionError('unavailable', '文件系统查询失败，未把失败当作空结果。').result()
        result = self.budget.context(result)
        source = {**result, 'operation': query.operation}
        # 错误路径可能是越界/凭据，不从输入复制未核验路径到元数据。
        detail_sources = [{**item, 'operation': query.operation} for item in result.get('results', [])
                          if isinstance(item, dict)]
        sources = clean_inspection({'sources': detail_sources or [source]}).get('sources', [])
        self.sources.extend(sources)
        return result

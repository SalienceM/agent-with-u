"""退出证据只针对本次创建的 Windows 进程树，不按进程名称操作。"""
from __future__ import annotations

import asyncio
import os
import subprocess
from typing import Any


class OwnedProcessTree:
    def __init__(self, process: Any) -> None:
        self.process = process
        self.handles: dict[int, Any] = {}
        self.complete = True
        self.kernel: Any = None
        self.entry_type: Any = None
        self.job: Any = None
        self.accounting_type: Any = None
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes

            class Entry(ctypes.Structure):
                _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('pid', wintypes.DWORD), ('heap', ctypes.c_size_t), ('module', wintypes.DWORD),
                    ('threads', wintypes.DWORD), ('parent', wintypes.DWORD), ('priority', wintypes.LONG),
                    ('flags', wintypes.DWORD), ('exe', wintypes.WCHAR * 260)]

            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
            kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.kernel, self.entry_type = kernel, Entry
            # 在 initialize/命令之前绑定拥有的 root，Job 追踪短命父进程留下的
            # 后代，避免仅靠 Toolhelp 快照把已脱离父链的进程误判为退出。
            class Accounting(ctypes.Structure):
                _fields_ = [('user', ctypes.c_int64), ('kernel', ctypes.c_int64),
                    ('period_user', ctypes.c_int64), ('period_kernel', ctypes.c_int64),
                    ('faults', wintypes.DWORD), ('total', wintypes.DWORD),
                    ('active', wintypes.DWORD), ('terminated', wintypes.DWORD)]
            class Limits(ctypes.Structure):
                _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                    ('flags', wintypes.DWORD), ('min_working_set', ctypes.c_size_t),
                    ('max_working_set', ctypes.c_size_t), ('process_limit', wintypes.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
            class ExtendedLimits(ctypes.Structure):
                _fields_ = [('basic', Limits), ('io', ctypes.c_uint64 * 6),
                    ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                    ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
            kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
            job = kernel.CreateJobObjectW(None, None)
            root = kernel.OpenProcess(0x100101, False, process.pid)  # quota, terminate, synchronize
            limits = ExtendedLimits(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway
            if job and root and kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) and kernel.AssignProcessToJobObject(job, root):
                self.job, self.accounting_type = job, Accounting
            else:
                if job:
                    kernel.CloseHandle(job)
                self.complete = False
            if root:
                kernel.CloseHandle(root)
            self.capture()

    def capture(self) -> None:
        if not self.kernel:
            return
        import ctypes
        kernel = self.kernel
        snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot in (0, ctypes.c_void_p(-1).value):
            self.complete = False
            return
        entry = self.entry_type()
        entry.dwSize = ctypes.sizeof(entry)
        pairs: list[tuple[int, int]] = []
        try:
            more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                pairs.append((entry.pid, entry.parent))
                more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        # 持有句柄防 PID 重用；已退出的祖先不再用于认领新进程。
        roots = {pid for pid, handle in self.handles.items() if kernel.WaitForSingleObject(handle, 0) == 258}
        if not self.handles and self.process.returncode is None:
            roots.add(self.process.pid)
        found = set(roots)
        while True:
            more_pids = {pid for pid, parent in pairs if parent in found} - found
            if not more_pids:
                break
            found.update(more_pids)
        for pid in found - self.handles.keys():
            handle = kernel.OpenProcess(0x100001, False, pid)  # SYNCHRONIZE | TERMINATE
            if handle:
                self.handles[pid] = handle
            else:
                # 进程退出竞态也不能当成已取得完整退出证据。
                self.complete = False

    async def stop(self) -> bool:
        proc = self.process
        self.capture()
        if self.job:
            self.kernel.TerminateJobObject(self.job, 1)
        if self.kernel and proc.returncode is None and proc.pid in self.handles:
            killer = None
            try:
                killer = await asyncio.create_subprocess_exec('taskkill', '/F', '/T', '/PID', str(proc.pid),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                await asyncio.wait_for(killer.wait(), 3)
            except (OSError, asyncio.TimeoutError):
                if killer and killer.returncode is None:
                    killer.kill()
                    await killer.wait()
        if self.kernel:
            # 即便 npm 父进程已退出，仍只终止已持有的原子进程对象。
            for handle in self.handles.values():
                if self.kernel.WaitForSingleObject(handle, 0) == 258:
                    self.kernel.TerminateProcess(handle, 1)
        elif proc.returncode is None:
            proc.kill()
        transport = getattr(proc, '_transport', None)
        if transport is not None:
            # 超大帧可使 StreamReader 暂停管道；先关闭本次管道再等待，避免
            # 进程已被终止但 asyncio wait 仍等待未消费的 stdout EOF。
            transport.close()
        try:
            await asyncio.wait_for(proc.wait(), 3)
        except asyncio.TimeoutError:
            return False
        if not self.kernel:
            return True
        # 活动期内的有界收口，不是 Session 后台轮询。
        deadline = asyncio.get_running_loop().time() + 2
        while not self._job_empty() or any(self.kernel.WaitForSingleObject(h, 0) != 0 for h in self.handles.values()):
            if asyncio.get_running_loop().time() >= deadline:
                return False
            await asyncio.sleep(.05)
        return self.complete and bool(self.handles)

    def _job_empty(self) -> bool:
        if not self.job:
            return False
        import ctypes
        info = self.accounting_type()
        return bool(self.kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None)
                    and info.active == 0)

    def exit_confirmed(self) -> bool:
        """只读持有的原子句柄/Job；不按 PID 重开对象，也不终止进程。"""
        if self.process.returncode is None:
            return False
        if not self.kernel:
            return False  # 非 Windows 的进程组证明由拥有该组的调用方负责。
        return (self.complete and bool(self.handles) and self._job_empty()
                and all(self.kernel.WaitForSingleObject(handle, 0) == 0 for handle in self.handles.values()))

    def release(self) -> None:
        if self.kernel:
            for handle in self.handles.values():
                self.kernel.CloseHandle(handle)
        self.handles.clear()
        if self.job:
            self.kernel.CloseHandle(self.job)
            self.job = None

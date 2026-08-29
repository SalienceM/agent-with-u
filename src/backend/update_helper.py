"""Detached installer helper used after an AgentWithU node exits.

The running desktop/backend cannot safely replace its own binaries.  The update
manager therefore writes a small, checksum-bound installation plan and launches
this module (or a copied frozen executable) in a detached process.  The helper
waits for the owning processes to exit, runs the installer without a shell,
persists a machine-readable result, and optionally starts the new application.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _pid_alive(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    if os.name == "nt":
        try:
            import ctypes

            process = ctypes.windll.kernel32.OpenProcess(0x100000, False, pid)
            if not process:
                return False
            ctypes.windll.kernel32.CloseHandle(process)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _wait_for_processes(pids: list[int], timeout: float) -> None:
    deadline = time.monotonic() + max(1.0, timeout)
    pending = {int(pid) for pid in pids if int(pid or 0) > 0 and int(pid) != os.getpid()}
    while pending and time.monotonic() < deadline:
        pending = {pid for pid in pending if _pid_alive(pid)}
        if pending:
            time.sleep(0.25)
    if pending:
        raise RuntimeError(f"timed out waiting for processes: {sorted(pending)}")


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _write_result(plan: dict[str, Any], **payload: Any) -> None:
    result_path = Path(str(plan.get("resultPath") or "")).expanduser()
    if not str(result_path):
        return
    _atomic_json(result_path, {
        "schemaVersion": 1,
        "finishedAt": time.time(),
        "version": str(plan.get("version") or ""),
        "buildId": str(plan.get("buildId") or ""),
        **payload,
    })


def _spawn_restart(plan: dict[str, Any]) -> None:
    restart = plan.get("restart") if isinstance(plan.get("restart"), dict) else {}
    program = str(restart.get("program") or "").strip()
    if not program:
        return
    args = [str(item) for item in (restart.get("args") or [])]
    cwd = str(restart.get("cwd") or "").strip() or None
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([program, *args], **kwargs)


def run_update_helper(plan_path: str) -> int:
    """Apply one previously validated update plan and return a process code."""
    plan_file = Path(plan_path).expanduser().resolve()
    try:
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
        if plan.get("marker") != "agentwithu-update-plan-v1":
            raise RuntimeError("untrusted update plan marker")
        artifact = Path(str(plan.get("artifactPath") or "")).expanduser().resolve()
        if not artifact.is_file():
            raise RuntimeError(f"staged artifact is missing: {artifact}")
        expected = str(plan.get("artifactSha256") or "").lower()
        if len(expected) != 64 or _sha256(artifact).lower() != expected:
            raise RuntimeError("staged artifact SHA-256 mismatch")

        _wait_for_processes(
            [int(item) for item in (plan.get("waitPids") or [])],
            float(plan.get("waitTimeoutSeconds") or 90),
        )

        install = plan.get("install") if isinstance(plan.get("install"), dict) else {}
        program = str(install.get("program") or "").strip()
        if not program:
            raise RuntimeError("installation program is missing")
        args = [str(item) for item in (install.get("args") or [])]
        cwd = str(install.get("cwd") or "").strip() or None
        timeout = max(30, min(int(install.get("timeoutSeconds") or 1800), 6 * 3600))
        completed = subprocess.run(
            [program, *args], cwd=cwd, timeout=timeout, check=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        accepted = {int(value) for value in (install.get("successExitCodes") or [0])}
        if completed.returncode not in accepted:
            raise RuntimeError(f"installer exited with code {completed.returncode}")

        _write_result(plan, ok=True, exitCode=completed.returncode)
        time.sleep(max(0.0, min(float(plan.get("restartDelaySeconds") or 1.0), 30.0)))
        _spawn_restart(plan)
        return 0
    except Exception as error:
        try:
            failed_plan = locals().get("plan", {})
            _write_result(failed_plan, ok=False, error=str(error))
            # An installer failure must not strand a desktop node offline.  The
            # old installation normally remains runnable; restart it so the
            # failure is visible and a manual/rollback update can be attempted.
            _spawn_restart(failed_plan)
        except Exception:
            pass
        return 1


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    return run_update_helper(sys.argv[-1])


if __name__ == "__main__":
    raise SystemExit(main())

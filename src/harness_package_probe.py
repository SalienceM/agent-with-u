"""冻结包的受控 Harness 验收入口；仅在独立 probe home 内运行。"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse

from .package_readiness import probe_root


async def check() -> dict:
    root = probe_root()
    if root is None:
        raise RuntimeError("Harness probe requires an isolated package probe root")
    url = os.environ.get("AWU_HARNESS_PROBE_URL", "")
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password:
        raise RuntimeError("Harness probe accepts only a loopback fake provider")
    if shutil.which("node") or shutil.which("pnpm"):
        raise RuntimeError("Harness frozen acceptance must not use system Node/pnpm")
    scenario = os.environ.get("AWU_HARNESS_PROBE_CASE")
    if scenario not in {"tools", "allow", "deny", "resume", "stop"}:
        raise RuntimeError("Unknown Harness probe case")
    from .backend.deepseek_harness import DeepSeekHarnessBackend
    from .backend.deepseek_harness_distribution import verify_bundle
    from .types import BackendType, ModelBackendConfig
    inventory = verify_bundle(repair_executable=True)
    config = ModelBackendConfig(id="isolated-probe", type=BackendType.DEEPSEEK_HARNESS,
        label="package probe", model="smoke-model", api_key="local-fixture-not-a-credential", base_url=url,
        skip_permissions=False,
        harness_permission_mode="read-only" if scenario in {"allow", "deny"} else "workspace-write")
    backend = DeepSeekHarnessBackend(config)
    deltas, approvals, turns = [], [], []
    work = root / "work"
    (work / "probe.txt").write_text("before\n", encoding="utf-8")
    native = None
    async def decide(request) -> bool:
        if request.session_id != "probe" or request.tool_name != "write":
            raise RuntimeError("Unexpected probe approval")
        args = json.loads(request.tool_input)
        if Path(args["file_path"]).resolve() != work / "approved.txt":
            raise RuntimeError("Probe approval target mismatch")
        approvals.append(request.tool_id)
        return scenario == "allow"

    stop_started = asyncio.Event()
    def observe(delta) -> None:
        deltas.append(delta)
        if scenario == "stop" and delta.type == "tool_start":
            stop_started.set()

    for index in range(2 if scenario == "resume" else 1):
        call = asyncio.create_task(backend.send_message([], f"isolated-probe-{index}", None, "probe", str(index), observe,
            agent_session_id=native, working_dir=str(work), constraints="AWU-PROBE-LITERAL {{keep}}",
            on_permission_request=decide, owner_id="isolated-probe-user"))
        if scenario == "stop":
            await asyncio.wait_for(stop_started.wait(), 30)
            # Wait for the shell's own marker, not just the tool dispatch event.
            for _ in range(100):
                if (work / "shell-started.txt").is_file():
                    break
                await asyncio.sleep(.05)
            if not (work / "shell-started.txt").is_file():
                raise RuntimeError("Probe shell did not actually start")
            backend.abort("probe")
        result = await asyncio.wait_for(call, 90)
        turns.append(result)
        native = result.get("agentSessionId")
        if backend.has_unconfirmed_activity("probe"):
            raise RuntimeError("Harness probe native exit is unconfirmed")
        if bool(result.get("success")) != (scenario != "stop"):
            errors = [item.error for item in deltas if item.type == "error"]
            raise RuntimeError("Probe turn result mismatch: " + str(errors))
    tools = [delta.tool_call for delta in deltas if delta.type == "tool_result"]
    if scenario == "tools":
        if (work / "probe.txt").read_text(encoding="utf-8") != "after\n" or len(tools) != 3:
            raise RuntimeError("Frozen file read/edit/command evidence missing: " + str(tools))
        if any(tool.get("status") != "done" for tool in tools):
            raise RuntimeError("Frozen native tool failed: " + str(tools))
        if "AWU-COMMAND-OK" not in json.dumps(tools):
            raise RuntimeError("Frozen native command result missing")
    if scenario in {"allow", "deny"}:
        if len(approvals) != 1 or (work / "approved.txt").exists() != (scenario == "allow"):
            raise RuntimeError("Frozen native approval evidence mismatch")
    if scenario == "stop" and any(delta.type == "done" for delta in deltas):
        raise RuntimeError("Stopped probe emitted success")
    return {"ok": True, "case": scenario, "platform": sys.platform, "frozen": bool(getattr(sys, "frozen", False)),
            "resources": len(inventory), "turns": len(turns), "tools": len(tools), "approvals": len(approvals),
            "nativeId": native, "systemNode": False, "exitConfirmed": True}


def run() -> int:
    try:
        result = asyncio.run(check())
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result["ok"] else 1

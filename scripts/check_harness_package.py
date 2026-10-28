"""用 loopback 假模型验收实际冻结包；不连接生产端点或使用用户 home。"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.check_backend_package import ProbeProcess, digest, isolated_environment
from tests.fixtures.deepseek_harness_http import LocalModel


async def verify(binary: Path) -> dict:
    report = {"ok": False, "path": str(binary), "sha256": digest(binary), "platform": sys.platform, "cases": []}
    for scenario in ("tools", "allow", "deny", "resume", "stop"):
        with tempfile.TemporaryDirectory(prefix="awu-harness-frozen-", ignore_cleanup_errors=True) as temporary:
            root = Path(temporary).resolve()
            env = isolated_environment(root)
            if os.name == "nt":
                # 系统 Windows PowerShell 不是 Node；不继承用户 PATH。
                env["PATH"] += ";" + str(Path(env["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0")
            work = root / "work"
            shell = "pwsh" if os.name == "nt" else "bash"
            command = "Write-Output AWU-COMMAND-OK" if os.name == "nt" else "printf AWU-COMMAND-OK"
            args = {"file_path": str(work / "approved.txt"), "content": "approved fixture",
                    "sandbox_permissions": "workspace-write", "justification": "isolated probe file only"}
            replies = {
                "tools": [("read", {"file_path": str(work / "probe.txt")}),
                          ("edit", {"file_path": str(work / "probe.txt"), "old_string": "before", "new_string": "after"}),
                          (shell, {"command": command, "description": "Print isolated probe marker"}), "tools complete"],
                "allow": [("write", args), "approval complete"], "deny": [("write", args), "denial complete"],
                "resume": ["first response", "second response"],
                "stop": [(shell, {"command": "Set-Content shell-started.txt started; Start-Sleep 120" if os.name == "nt"
                                  else "printf started > shell-started.txt; sleep 120",
                                  "description": "Wait for isolated cancellation probe"})],
            }[scenario]
            probe = ProbeProcess()
            with LocalModel(replies) as model:
                env.update(AWU_HARNESS_PROBE_URL=model.url, AWU_HARNESS_PROBE_CASE=scenario)
                try:
                    await probe.start([str(binary), "--agentwithu-package-probe", "--agentwithu-harness-check"], env, work)
                    await asyncio.wait_for(probe.proc.wait(), 150)
                    await asyncio.wait_for(asyncio.gather(*probe.readers), 5)
                    try:
                        output = probe.tails[0].decode("utf-8")
                    except UnicodeDecodeError:
                        output = probe.tails[0].decode("mbcs" if os.name == "nt" else "utf-8", errors="replace")
                    response = json.loads(output.strip().splitlines()[-1])
                    response["returncode"] = probe.proc.returncode
                    if not response.get("ok") or not response.get("frozen") or probe.proc.returncode:
                        raise RuntimeError(str(response))
                    if not model.posts or "AWU-PROBE-LITERAL {{keep}}" not in json.dumps(model.posts[0]):
                        raise RuntimeError("Session constraints did not reach the actual provider")
                    if scenario == "resume":
                        body = json.dumps(model.posts[1])
                        if "isolated-probe-0" not in body or "isolated-probe-1" not in body:
                            raise RuntimeError("Native history was not restored")
                    response["modelRequests"] = len(model.posts)
                    response["providerPaths"] = model.paths
                    report["cases"].append(response)
                except Exception as exc:
                    report["failure"] = str(exc)
                    report["stderrTail"] = probe.tails[1].decode("utf-8", errors="replace")[-3000:]
                finally:
                    if not await probe.stop():
                        report["failure"] = "Frozen probe process cleanup unconfirmed"
                if "failure" in report:
                    return report
    report["ok"] = digest(binary) == report["sha256"]
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    value = asyncio.run(verify(args.binary.resolve()))
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(text + "\n", encoding="utf-8")
    print(json.dumps(value, ensure_ascii=True, indent=2))
    raise SystemExit(0 if value["ok"] else 1)

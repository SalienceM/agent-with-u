"""Generate isolated, deterministic dashboard acceptance data.

The generated tree is consumed through AGENT_WITH_U_DATA_ROOT.  It never reads
or writes the user's normal ~/.agent-with-u data.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


BASE_TS = 1_785_000_000.0
PROFILES = {
    "typical": {"sessions": 12, "loops": 4, "tasks_per_session": 3},
    "stress": {"sessions": 250, "loops": 60, "tasks_per_session": 12},
}


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def session_payload(index: int, is_loop: bool) -> dict:
    sid = f"qa-{'loop' if is_loop else 'chat'}-{index:03d}"
    updated = BASE_TS - index * 37
    title = (
        f"首页交付 Loop {index + 1}"
        if is_loop
        else f"客户工作会话 {index + 1}"
    )
    return {
        "id": sid,
        "title": title,
        "createdAt": updated - 7200,
        "updatedAt": updated,
        "messages": [
            {
                "id": f"{sid}-message",
                "role": "assistant",
                "content": "这是用于首页运行态验收的固定数据。",
                "timestamp": updated,
                "streaming": False,
            }
        ],
        "workingDir": f"C:/qa/workspaces/project-{index % 9}",
        "backendId": "qa-primary",
        "modelOverride": "gpt-5",
        "reasoningEffort": "medium",
        "agentSessionId": None,
        "codexConnectionMode": None,
        "codexRemoteHost": None,
        "codexThreadAttached": False,
        "autoContinue": True,
        "skipPermissions": True,
        "sandboxEnabled": False,
        "maxContinuations": 10,
        "constraints": None,
        "abilities": None,
        "sessionType": "loop" if is_loop else "normal",
        "autoCommit": False,
        "autoCommitPush": False,
        "autoCommitBackendId": None,
    }


def loop_payload(session: dict, index: int) -> dict:
    updated = session["updatedAt"]
    completed = index % 4 != 0
    score = 68 + (index * 7) % 27
    record = {
        "seq": index + 1,
        "kind": "agent",
        "subStage": "done" if completed else "execute",
        "round": 1,
        "goal": "交付可验证的响应式首页",
        "orchestration": [
            {
                "index": 1,
                "mode": "sequential",
                "desc": "复核真实运行态",
                "access": "read",
                "status": "done",
                "output": "已生成固定验收数据",
                "startedAt": updated - 120,
                "endedAt": updated - 80,
            },
            {
                "index": 2,
                "mode": "sequential",
                "desc": "执行浏览器回归",
                "access": "write",
                "status": "done" if completed else "pending",
                "output": "等待或已完成",
                "startedAt": updated - 75 if completed else 0,
                "endedAt": updated - 20 if completed else 0,
            },
        ],
        "completed": completed,
        "result": "首页验收产物已更新" if completed else "",
        "analysis": {
            "score": score,
            "notes": "固定夹具评分",
            "trend": "稳定",
            "optimizationPotential": 0.18,
            "challenges": "",
            "deliverable": score >= 70,
            "outputtable": score >= 85,
        } if completed else None,
        "error": "",
        "subStarted": {"prepare": updated - 180, "execute": updated - 120},
        "backends": {"execute": "qa-primary", "analysis": "qa-reviewer"},
        "runtimes": {
            "execute": {"model": "gpt-5", "reasoningEffort": "medium"},
            "analysis": {"model": "gpt-5", "reasoningEffort": "high"},
        },
        "createdAt": updated - 240,
        "updatedAt": updated,
    }
    return {
        "sessionId": session["id"],
        "stage": "loopexecute" if not completed else ("loopout" if index % 3 == 2 else "loopexecute"),
        "goal": "在桌面、网页、小屏和无障碍场景交付高效首页",
        "goalHistory": [],
        "ideas": [],
        "loops": [record],
        "riskCoefficient": round(0.2 + (index % 5) * 0.08, 2),
        "policy": {
            "deliverableScore": 70,
            "outputtableScore": 85,
            "maxLoops": 8,
            "riskThreshold": 0.85,
            "independentEval": True,
            "intentGuard": True,
            "backends": {"analysis": "qa-reviewer"},
            "runtimes": {},
            "strategy": "以可验证证据为准。",
        },
        "round": 1,
        "auto": index % 2 == 0,
        "status": "output" if completed and index % 3 == 2 else "active",
        "controlMode": "loop",
        "stopReason": "",
        "asides": [],
        "addons": [],
        "intentAlert": {},
        "bestSeq": index + 1 if completed else 0,
        "riskFactors": {},
        "createdAt": updated - 3600,
        "updatedAt": updated,
    }


def extras_payload(session: dict, count: int, index: int) -> dict:
    updated = session["updatedAt"]
    tasks = []
    for task_index in range(count):
        pending = task_index % 5 != 4
        tasks.append({
            "id": f"{session['id']}-task-{task_index:03d}",
            "text": f"验收任务 {index + 1}.{task_index + 1}：检查首页关键状态",
            "images": [],
            "imageCount": 0,
            "status": "pending" if pending else "sent",
            "createdAt": updated - task_index * 5,
            "updatedAt": updated - task_index * 5,
        })
    return {
        "sessionId": session["id"],
        "seqTasks": tasks,
        "seqAuto": False,
        "asides": [],
        "asideBackendId": "qa-reviewer",
        "createdAt": updated - 1800,
        "updatedAt": updated,
    }


def generate(root: Path, profile: str) -> dict:
    cfg = PROFILES[profile]
    root = root.resolve()
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    sessions = []
    loop_count = cfg["loops"]
    normal_count = cfg["sessions"] - loop_count
    for index in range(cfg["sessions"]):
        is_loop = index < loop_count
        session = session_payload(index, is_loop)
        sessions.append(session)
        write_json(root / "sessions" / f"{session['id']}.json", session)
        if is_loop:
            write_json(root / "loops" / f"{session['id']}.json", loop_payload(session, index))
        else:
            write_json(
                root / "chat-extras" / f"{session['id']}.json",
                extras_payload(session, cfg["tasks_per_session"], index - loop_count),
            )

    metas = []
    for session in sessions:
        metas.append({
            key: value
            for key, value in session.items()
            if key in {
                "id", "title", "createdAt", "updatedAt", "workingDir", "backendId",
                "modelOverride", "reasoningEffort", "codexConnectionMode",
                "codexRemoteHost", "codexThreadAttached", "abilities", "sessionType",
            }
        } | {"messageCount": len(session["messages"])})
    write_json(root / "sessions" / "index.json", metas)
    write_json(root / "backends" / "config.json", [
        {
            "id": "qa-primary",
            "type": "codex-office",
            "label": "QA 主执行模型",
            "enabled": True,
            "model": "gpt-5",
            "skipPermissions": True,
        },
        {
            "id": "qa-reviewer",
            "type": "openai-compatible",
            "label": "QA 独立评审模型",
            "enabled": True,
            "baseUrl": "http://127.0.0.1:9/v1",
            "model": "gpt-5",
            "apiKey": "qa-placeholder",
            "skipPermissions": True,
        },
        {
            "id": "qa-disabled",
            "type": "openai-compatible",
            "label": "QA 已停用模型",
            "enabled": False,
            "baseUrl": "http://127.0.0.1:9/v1",
            "model": "offline",
            "apiKey": "qa-placeholder",
            "skipPermissions": True,
        },
    ])
    manifest = {
        "profile": profile,
        "sessions": cfg["sessions"],
        "loops": loop_count,
        "normalSessions": normal_count,
        "tasksPerNormalSession": cfg["tasks_per_session"],
        # 首页把 pending/sent 都视为未完成，只有 done/completed/cancelled 会排除。
        "pendingTasks": normal_count * cfg["tasks_per_session"],
        "dataRoot": str(root),
        "baseTimestamp": BASE_TS,
    }
    write_json(root / "fixture-manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=sorted(PROFILES), default="typical")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    output = args.output or repo_root / ".qa" / "home" / args.profile / "data"
    print(json.dumps(generate(output, args.profile), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

"""Bounded LOOP handoff, evidence packets and progress decisions (no filesystem writes).

Reports are reviewer observations, not execution permissions or proof by themselves.
The task source remains authoritative; this module never edits a project checklist.
"""
from __future__ import annotations

import json
import hashlib
from typing import Any

from .call_trace import CallTrace
from .loop_milestones import milestone_progress, MILESTONE_INSTRUCTIONS


def scope_key(goal: str) -> str:
    return hashlib.sha256(goal.strip().encode("utf-8")).hexdigest()[:20]


def excerpt(value: object, limit: int = 6000) -> str:
    text = value if isinstance(value, str) else ""
    if len(text) <= limit:
        return text
    marker = "\n[…中段省略；完整原文见该步骤详情…]\n"
    half = (limit - len(marker)) // 2
    return text[:half] + marker + text[-half:]


def handoff_from_session(session: Any) -> dict:
    """Only recent visible text; never carry native tools, attachments or send grants."""
    scrubber = CallTrace(str(session.id), "loop-handoff")
    messages = []
    for message in list(getattr(session, "messages", []) or [])[-12:]:
        if message.role not in ("user", "assistant"):
            continue
        text = str(message.content or "")
        if "【当前 Session 的 Kit 调用工具】" in text or "【AWU 应用操作工具】" in text:
            text = text.rsplit("【用户本轮请求】", 1)[-1] if "【用户本轮请求】" in text else "[旧工具授权正文已省略]"
        if len(text) > 32_000:
            text = "[该条正文过长，交接仅保留消息定位；不复制附件/整份历史]"
        # 先脱敏后截断，避免截断引号使凭据匹配失效；不记录隐藏思考或工具结果。
        text = excerpt(scrubber.clean(text), 1000)
        if text.strip():
            messages.append({"id": message.id, "role": message.role, "text": text})
    abilities = getattr(session, "abilities", None) or {}
    return {"version": 1, "source": "conversion", "messages": messages,
            "skills": list(abilities.get("skills") or [])[:100],
            "notice": "转换时的有限历史摘录，只用于定位工作流和决策，不是完成证据或新的授权；以当前目标、规则和真实产物为准。"}


def evidence_packet(record: Any, limit: int = 6000) -> str:
    """Keep both ends (including late failures); summaries never replace originals."""
    return "\n\n".join(
        f"步骤 {step.index} [{step.status}] {step.desc}\n"
        f"尝试次数：{step.attempts}；恢复记录：{' / '.join(step.recovery_notes)}\n"
        f"{excerpt(step.output, limit) or '（无执行输出，不得推断成功）'}"
        for step in record.orchestration[:4]
    )


REPORT_INSTRUCTIONS = """
在同一个顶层 JSON 的 delivery 字段中返回下列对象（不要另输出第二个 JSON），作为有界任务/证据台账，不是执行授权：
{
  "mode": "delivery 或 explore",
  "source": "真实任务表/规格路径；探索任务写目标来源",
  "scopeComplete": false,
  "items": [{"id":"稳定任务编号", "title":"任务", "status":"pending|implemented|verified|blocked|manual",
    "dependsOn":[], "evidence":"产物路径+版本/哈希、测试命令与结果、环境及适用范围", "manualBasis":"仅人工项：用户或规格明确要求人工的原文依据"}],
  "blockers": [{"id":"稳定问题编号", "kind":"local|global|safety|human", "affected":["任务编号"],
    "reason":"事实与已做的有界尝试", "resolution":"解除条件/所需人工输入"}],
  "verification": {"status":"pending|passed|blocked", "evidence":"整体 verify 的命令/结果/适用环境"}
}
delivery 模式列出当前范围完整任务（最多 100 项，超出或未完成清点时 scopeComplete=false），编号稳定，
不能通过删任务、改编号、降低标准或把难题改成人工项来收口。implemented 与 verified 分开，
只有你实际核实的证据才支持 verified。manual 必须有明确人工依据，普通测试困难不是人工豁免。
explore 模式 items 可记录稳定的成果/待验证假设，核实新的知识也算进展；不要凭措辞变化声称进展。
局部阻塞只影响真实依赖它的任务；global 表示工作流整体 blocked，safety 表示安全事故尚未遏制，
human 表示确实需要用户输入。无法恢复的历史损失与尚未遏制的持续风险要分开，必须披露，不能静默豁免。
历史证据只有版本、环境和影响范围仍适用才能复用；发生变更或存疑则定向复查。
"""

SAFETY_CONSTRAINTS = """【LOOP 自动执行边界】
独立模型会话不是文件沙箱。项目快照不保护工作区外的用户数据。
运行可能写入用户目录/数据库的测试前，先使用独立测试数据目录并验证实际写入位置；
不能确认隔离时不要运行该测试，报告受影响任务与所需条件。禁止以清空真实数据来构造测试。
不扩大当前任务授权，不复用历史 Kit/跨 Session 写入授权，不自动发布或访问其他节点。
发生未遏制的数据损坏/安全事故，停止后续有副作用操作，在最终 JSON 中返回
"loopControl":{"pause":true,"reason":"具体事实与人工处理条件"}，不要自行尝试高风险恢复。
上述是执行约束，不代表底层具备操作系统级隔离。
"""


def call_scope_constraints(sub_stage: str, access: str, *, native_codex: bool) -> str:
    """Describe this call's restriction without turning it into a global blocker."""
    planning = sub_stage in ("prepare", "intent")
    role = "规划/方向检查" if planning else "执行/评审"
    boundary = (
        f"本次 Codex 调用请求原生沙箱 {access}，实际能力仍以 Backend 和工具返回为准。"
        if native_codex else
        f"本次调用的逻辑访问约束为 {access}；该 Backend 未接入同等原生沙箱，不能声称具备操作系统隔离。"
    )
    return (
        f"【本次 LOOP 调用范围：{role}】\n{boundary}\n"
        "访问约束只属于本次调用，不代表整个 Session 或后续步骤没有写权限。"
        "后续获准的 write 步骤由执行器单独调用；Codex 届时请求 workspace-write，"
        "实际可用范围仍受用户授权、会话约束和 Backend 能力限制，不能保证一定获准。\n"
        + ("当前只负责只读核实并产出计划，不在本次实施或运行会写文件的验证。"
           "可以将已获用户授权的实现/验证编排为 access=write、mode=sequential；"
           "不得仅因当前规划调用只读就返回全局 pause 或要求用户重新授予整个任务写权限。\n"
           if planning else
           "只在本步访问范围内操作；先前规划或读取步骤的只读模式不是本次写权限的结论。\n")
        + "一次真实数据文件读取被拒绝，只能说明该次读取不可用，不能据此认定整个项目无法交付。"
        "不能绕过拒绝；应列明受影响的检查，并核对是否存在安全、独立的就绪任务。\n"
        "历史事故尚未恢复与当前仍有持续风险必须分开；仅在有适用证据、明确用户处置范围时调整调度，"
        "不自动豁免历史损失或验收。旧记录的‘下一唯一焦点’不是永久优先级，"
        "有更新的用户处置决定时按其范围规划；真实全局、安全或授权阻塞仍需暂停。"
    )


def normalize_report(raw: object) -> dict:
    if not isinstance(raw, dict) or raw.get("mode") not in ("delivery", "explore"):
        return {}
    items, ids = [], set()
    valid = (isinstance(raw.get("items"), list) and len(raw["items"]) <= 100
             and isinstance(raw.get("blockers"), list) and len(raw["blockers"]) <= 50)
    for item in (raw.get("items") if isinstance(raw.get("items"), list) else [])[:100]:
        if not isinstance(item, dict):
            valid = False
            continue
        key = excerpt(item.get("id"), 120).strip()
        status = item.get("status")
        if not key or key in ids or status not in ("pending", "implemented", "verified", "blocked", "manual"):
            valid = False
            continue
        ids.add(key)
        evidence = excerpt(item.get("evidence"), 1800).strip()
        manual = excerpt(item.get("manualBasis"), 600).strip()
        if (status in ("implemented", "verified") and not evidence) or (status == "manual" and not manual):
            status, valid = "pending", False
        deps = item.get("dependsOn", [])
        if not isinstance(deps, list) or len(deps) > 100 or any(not isinstance(v, str) or len(v) > 120 for v in deps):
            deps, valid = [], False
        items.append({"id": key, "title": excerpt(item.get("title"), 240), "status": status,
                      "dependsOn": deps[:100], "evidence": evidence, "manualBasis": manual})
    # 缺失依赖或循环依赖不能成为完成依据。
    graph = {item["id"]: item["dependsOn"] for item in items}
    def cycle(key: str, visiting: set[str], visited: set[str]) -> bool:
        if key in visiting or key not in graph:
            return True
        if key in visited:
            return False
        visiting.add(key)
        found = any(cycle(dep, visiting, visited) for dep in graph[key])
        visiting.remove(key)
        visited.add(key)
        return found
    visited: set[str] = set()
    if any(cycle(key, set(), visited) for key in graph):
        valid = False
    blockers = []
    for item in (raw.get("blockers") if isinstance(raw.get("blockers"), list) else [])[:50]:
        if not isinstance(item, dict) or item.get("kind") not in ("local", "global", "safety", "authorization", "human"):
            valid = False
            blockers.append({'id': 'unclassified-blocker', 'kind': 'global', 'affected': [],
                             'reason': '阻塞记录无法归类，需核对原始评审；不能忽略未知授权/安全边界。', 'resolution': '核对阻塞依据后显式恢复。'})
            continue
        blockers.append({"id": excerpt(item.get("id"), 120), "kind": item["kind"],
                         "affected": [v[:120] for v in item.get("affected", [])[:100] if isinstance(v, str)] if isinstance(item.get("affected"), list) else [],
                         "reason": excerpt(item.get("reason"), 1200), "resolution": excerpt(item.get("resolution"), 800)})
    verification = raw.get("verification") if isinstance(raw.get("verification"), dict) else {}
    return {"mode": raw["mode"], "source": excerpt(raw.get("source"), 500),
            "scopeComplete": raw.get("scopeComplete") is True and valid and bool(items),
            "items": items, "blockers": blockers, "valid": valid,
            "verification": {"status": verification.get("status") if verification.get("status") in ("pending", "passed", "blocked") else "pending",
                             "evidence": excerpt(verification.get("evidence"), 2000)}}


def completion_ready(report: dict) -> bool:
    return bool(report and report.get("valid") and report.get("scopeComplete")
                and (not report.get('reconciliation') or report['reconciliation'].get('valid'))
                and (not report.get('milestoneReview') or (report['milestoneReview'].get('valid')
                     and all((m.get('status') == 'verified' and m.get('validity') == 'current') or any(
                         i['id'] == m.get('parentId') and i['status'] == 'manual' and i.get('manualBasis') for i in report['items'])
                         for m in report['milestoneReview'].get('milestones', []))))
                and report.get("source") and not report.get("blockers")
                and all(i["status"] in ("verified", "manual") for i in report["items"])
                and report["verification"]["status"] == "passed"
                and report["verification"]["evidence"])


def assess_progress(records: list, patience: int = 3) -> dict:
    """Count evidence-backed state advances, not score/token/tool activity.

    Model observations remain labelled as such. Baseline inventory is not new
    implementation. Legacy records are unknown, never retroactively declared stuck.
    """
    relevant = [r for r in records if r.completed and r.kind == "agent" and r.progress_version]
    if relevant:
        relevant = [r for r in relevant if r.progress_scope == relevant[-1].progress_scope]
    seen: dict[str, int] = {}
    idle = 0
    previous_ids: set[str] = set()
    rank = {"pending": 0, "blocked": 0, "manual": 0, "implemented": 1, "verified": 2}
    scope_lost = False
    source = ""
    mode = ""
    has_baseline = False
    verification_seen = False
    for index, rec in enumerate(relevant):
        report = rec.delivery
        items = report.get("items", [])
        ids = {i["id"] for i in items}
        if report.get("valid"):
            scope_lost = (bool(previous_ids - ids) or bool(source and source != report.get("source"))
                          or bool(mode and mode != report.get("mode")))
            source = source or report.get("source", "")
            mode = mode or report.get("mode", "")
        elif previous_ids:
            scope_lost = True
        advanced = False
        if report.get("valid"):
            for item in items:
                score = rank[item["status"]]
                if item.get("evidence") and score > seen.get(item["id"], 0):
                    advanced = True
                seen[item["id"]] = max(score, seen.get(item["id"], 0))
            verification = report.get("verification", {})
            passed = verification.get("status") == "passed" and bool(verification.get("evidence"))
            # 整体验证从待验到通过也是进展；仅改写证据或反复切换状态不重复计数。
            advanced = advanced or (passed and not verification_seen)
            verification_seen = verification_seen or passed
        # 第一份有效报告是基线，之后比较稳定任务状态；缺失报告也要触发诊断。
        child_advance = bool(milestone_progress(relevant[:index + 1])['credited']) if rec.progress_version >= 2 else False
        idle = 0 if report.get("valid") and (not has_baseline or advanced or child_advance) else idle + 1
        if report.get("valid"):
            has_baseline = True
            previous_ids |= ids
    latest = relevant[-1].delivery if relevant else {}
    hard = [b for b in latest.get("blockers", []) if b["kind"] in ("global", "safety", "authorization")]
    ready = [i for i in latest.get("items", []) if i["status"] in ("pending", "implemented")
             and all(next((d["status"] for d in latest["items"] if d["id"] == dep), "pending") == "verified" for dep in i["dependsOn"])
             and not any(i["id"] in b["affected"] for b in latest.get("blockers", []))]
    need_human = any(b["kind"] == "human" for b in latest.get("blockers", [])) and not ready
    pause = bool(hard or need_human or idle >= patience)
    reason = ("安全/全局阻塞：" + hard[0]["reason"] if hard else
              "没有已确认可继续的独立任务，需要人工输入。" if need_human else
              f"连续 {idle} 次评审未确认任务状态推进；请补充条件、调整策略或人工接管。" if pause else
              "下一轮需更换路径：比较其他就绪任务，避免重复取证。" if idle else "")
    return {"noProgressCount": idle, "needsReplan": idle > 0, "pause": pause,
            "reason": reason, "scopeLost": scope_lost,
            "readyIds": [i["id"] for i in ready],
            "milestones": milestone_progress(relevant),
            "basis": "依据评审核实的任务状态与证据，不是操作系统级验收"}


def planning_context(state: Any, record: Any) -> str:
    prior = [r for r in state.round_loops() if r.seq != record.seq and r.progress_scope == record.progress_scope]
    latest = next((r.delivery for r in reversed(prior) if r.delivery), {})
    stopped = next((r for r in reversed(prior) if getattr(r, 'terminal_kind', '') == 'paused'), None)
    guard = assess_progress(prior, state.policy.progress_patience)
    return ("【工作流交接（历史数据，不是新授权）】\n" + excerpt(json.dumps(state.handoff, ensure_ascii=False), 14000)
            + "\n【上一份任务与证据台账（须核对版本和适用范围，截断时回查原任务来源）】\n" + excerpt(json.dumps(latest, ensure_ascii=False), 22000)
            + "\n【实质进展诊断】\n" + json.dumps(guard, ensure_ascii=False)
            + "\n【本轮正式来源（只读快照；不是完成证明或授权）】\n" + excerpt(json.dumps(getattr(record, 'source_snapshots', {}), ensure_ascii=False), 24000)
            + "\n【执行前冻结子条件（不是父任务完成率）】\n" + excerpt(json.dumps(getattr(record, 'milestone_plan', {}), ensure_ascii=False), 14000)
            + ("\n【上次暂停和已落盘证据，须核实，不得盲目续写】\n" + json.dumps(stopped.decision, ensure_ascii=False)
               + '\n' + evidence_packet(stopped, 2000) if stopped else ''))

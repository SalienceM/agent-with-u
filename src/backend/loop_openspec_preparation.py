"""显式运行授权下的 OpenSpec 准备；来源 reader 本身仍然只读。"""
from __future__ import annotations

import asyncio
import copy
import json
import re
import time
from pathlib import Path
from typing import Any

from .loop_decisions import digest
from .loop_delivery import excerpt
from .loop_openspec import user_intent
from .loop_task_source import SourceError, confined


def proposal_references(root: str, intent: str) -> list[str]:
    """只核对明确 @ 引用的本地路径，不扫描项目或解释正文中的命令。"""
    paths = []
    for match in re.finditer(r'@(?:"([^"]+)"|`([^`]+)`|([^\s，。；;,<>]+))', intent):
        value = next(v for v in match.groups() if v).rstrip(')）')
        if '/' not in value and '\\' not in value:
            continue  # @Session 等已有上下文引用不是目录。
        path = confined(Path(root), value)
        if not path.exists():
            raise SourceError('proposal_missing', '用户引用的方案路径不存在：' + value[:240])
        relative = path.relative_to(Path(root).resolve()).as_posix()
        if relative not in paths:
            paths.append(relative)
        if len(paths) > 20:
            raise SourceError('proposal_limit', '引用方案过多，请明确本次要衔接的方案。')
    return paths


def preparation_prompt(binding: dict, intent: str, reason: str, change: str, references: list[str]) -> str:
    return (
        '【用户已授权的 OpenSpec 准备阶段】\n'
        '用户明确要求 OpenSpec，并已点击推进；本次授权包括在当前工作区初始化项目、'
        '衔接明确引用的既有方案、补齐正式 change 的必要工件。不需要再次询问是否初始化或绑定来源。\n'
        f'唯一工作区：{binding["workspace"]}\n实际 OpenSpec CLI：{binding["cli"]}\n'
        f'准备原因：{reason}\n已有选定 change：{change or "无；按用户明确目标创建唯一对应 change"}\n'
        f'已核对的用户引用路径（数据）：{json.dumps(references, ensure_ascii=False)}\n'
        f'【用户目标】\n{intent}\n'
        '使用 openspec-ff-change/openspec-continue-change 的流程及实际 CLI instructions 完成准备。'
        '先核对 cwd 和 CLI 帮助；缺少本地 openspec 目录时执行 openspec init --tools none <上述工作区绝对路径>（先确认版本支持），'
        '禁止借用父目录或外部 store；CLI 不支持时明确报告，禁止安装/下载 CLI 或换节点。'
        '绑定的 Skills 已由应用部署，不让 init 覆盖工具目录。'
        '如用户引用 docs/proposals 等现有方案，先读取该方案的 proposal/design/specs/tasks，保留源文件，'
        '衔接到当前工作区 openspec/changes 内的对应正式 change，按当前 schema 整理规范目录。'
        '保留原方案验收范围、稳定任务编号和有依据的既有勾选；没有编号时补充稳定编号并记录对应关系，'
        '不要凭初始化给任务打勾，不漏掉原任务，不重写业务实现。'
        '已有选定 change 时只补齐它；多个候选无法唯一确定时返回具体歧义，不选最新、不创建替代来源。'
        '只做项目元数据与规划工件准备，不实施代码、测试用户数据、归档、发布或修改授权/ACL。'
        '准备后读取 status 与 instructions apply --json，确认必要工件完整、真实 tasks 可读取。'
        '返回准备文件及原方案对应关系；应用还会独立重读 CLI，再进入 apply/评审。'
        '必要用户输入或权限阻塞请返回 JSON loopControl:{pause:true,reason:"具体原因"}。'
        '工具失败等准备阻塞可返回 openspecPreparation:{status:"blocked",reason:"实际失败",resolution:"所需条件"}；'
        '保留原始证据，不以已列计划代替实际准备，不猜测沙箱或权限根因。'
    )


def preparation_blocker(parsed: dict) -> dict:
    """准备阶段尚无正式任务图；只保存模型报告，不伪造任务/原生环境结论。"""
    report = parsed.get('openspecPreparation')
    if isinstance(report, dict) and report.get('status') == 'blocked':
        return {'reason': excerpt(report.get('reason'), 1200).strip() or '准备调用报告受阻，请查看准备输出。',
                'resolution': excerpt(report.get('resolution'), 1200).strip()}
    blockers = parsed.get('taskBlockers')
    if not blockers:
        return {}
    # 兼容通用 LOOP 安全约束返回的 taskBlockers；这里不采纳未绑定任务 ID。
    items = blockers.get('items') if isinstance(blockers, dict) and blockers.get('version') == 1 else None
    if items == []:
        return {}
    if not isinstance(items, list) or len(items) > 50 or any(not isinstance(v, dict) for v in items):
        return {'reason': '准备调用返回的阻塞说明格式无效，请查看准备输出。', 'resolution': ''}
    reasons = [excerpt(v.get('reason'), 1200).strip() for v in items[:5]]
    resolutions = [excerpt(v.get('resolution'), 1200).strip() for v in items[:5]]
    return {'reason': excerpt('；'.join(dict.fromkeys(filter(None, reasons))), 1200)
            or '准备调用报告受阻，请查看准备输出。',
            'resolution': excerpt('；'.join(dict.fromkeys(filter(None, resolutions))), 1200)}


class LoopOpenSpecPreparation:
    async def _loop_prepare_openspec(self, session: Any, state: Any, record: Any,
                                     binding: dict, reason: str, change: str = '') -> bool:
        prior = record.stage_details.get('openspecSetup', {})
        if prior:
            raise SourceError('preparation_incomplete', '本次准备已经尝试过；请查看准备输出，处理原因后再次显式推进。')
        intent, control = user_intent(state, record), state.control_revision
        policy, abilities = digest(state.policy.to_dict()), digest(getattr(session, 'abilities', None))
        previous = state.task_source
        references = await asyncio.to_thread(proposal_references, binding['workspace'], intent)
        def current(source: dict) -> bool:
            return (state.task_source is source and state.control_revision == control
                    and state.control_mode == 'loop' and user_intent(state, record) == intent
                    and digest(state.policy.to_dict()) == policy and digest(getattr(session, 'abilities', None)) == abilities
                    and session.id not in self._loop_cancel and session.id not in self._loop_pending_out
                    and self._loop_source_environment(session, state, allow_uninitialized=True)[0] == binding)
        if not current(previous):
            raise SourceError('execution_changed', '方案引用核对期间执行条件变化，未启动准备调用。')
        preparing = {**previous, 'status': 'preparing', 'reason': '正在准备 OpenSpec 项目与方案', 'code': ''}
        detail = {'status': 'running', 'message': '正在准备 OpenSpec 项目与方案', 'startedAt': time.time(),
                  'reason': reason, 'change': change, 'references': references, 'binding': copy.deepcopy(binding)}
        record.stage_details['openspecSetup'] = detail
        record.stage_details['prepare'] = detail
        state.task_source = preparing
        self._loop_save(state)
        self._emit_loop_updated(state)
        try:
            backend_id = binding['backendId']
            runtime = self._resolved_runtime(backend_id, self._loop_runtime(session, state, 'execute', backend_id, backend_id))
            text, _ = await self._loop_run_agent(session,
                preparation_prompt(binding, intent, reason, change, references), 'prepare', record.seq,
                resume=False, indep_session_id=f'{session.id}:loop{record.seq}:openspec:setup',
                backend_id=backend_id, runtime=runtime, execution_access='workspace-write')
            detail.update(status='checking', rawOutput=text, message='准备调用结束，正在核对正式来源')
            if not current(preparing):
                raise SourceError('execution_changed', '准备期间目标、能力或执行身份已变化；输出已保留，请重新推进。')
            if self._loop_pause_control(state, record, text):
                detail.update(status='paused', message=state.progress_guard.get('reason') or '准备调用报告了需要处理的条件')
                return False
            blocker = preparation_blocker(self._extract_json_block(text) or {})
            if blocker:
                detail.update(status='blocked', message='准备调用报告受阻：' + blocker['reason'],
                              reportedBlocker=blocker)
                raise SourceError('preparation_blocked', '准备调用报告：' + blocker['reason'])
            return True
        except BaseException as exc:
            if not isinstance(exc, SourceError) or exc.code != 'preparation_blocked':
                detail.update(status='interrupted', message='准备未确认完成；保留输出与原调用状态，不自动重试')
            partial = getattr(exc, 'partial_text', '')
            if partial:
                detail['rawOutput'] = partial
            # 准备不是普通 apply 失败重试；部分写入后须由用户显式重新推进。
            state.auto = False
            if isinstance(exc, Exception) and not isinstance(exc, SourceError):
                from .loop_execution_environment import EnvironmentPause
                if not isinstance(exc, EnvironmentPause):
                    self._loop_wait(state, record, 'preparation_failed', 'OpenSpec 准备调用失败：' + str(exc)[:800],
                                    '查看准备输出与保留文件，处理原因后再次推进。')
            raise
        finally:
            detail['endedAt'] = time.time()
            if state.task_source is preparing:
                state.task_source = previous
            self._loop_save(state)
            self._emit_loop_updated(state)

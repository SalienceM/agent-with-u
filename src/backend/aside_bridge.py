"""普通与 LOOP 俺寻思共用的独立只读问答生命周期。"""
from __future__ import annotations

import asyncio
import json
import time
import hashlib
from typing import Any

from .aside_inspection import InspectionError, QueryBudget, QueryIdentity, clean_inspection
from .aside_openspec import OpenSpecInspection
from .aside_queries import InspectionQueries
from .aside_runner import InspectionRunner
from .aside_runtime import runtime_evidence
from .loop_openspec import user_intent


class AsideInspectionBridge:
    def _inspection_config_revision(self, backend_id: str) -> str:
        config = next((item for item in getattr(self, '_backend_configs', []) if item.id == backend_id), None)
        # 仅内存比较；不把含凭据的配置、其摘要或原文持久化/发送给模型。
        return hashlib.sha256(json.dumps(config.to_dict() if config else {}, sort_keys=True,
                                        ensure_ascii=False).encode()).hexdigest()

    def _inspection_key(self, sid: str, loop: bool) -> str:
        return f'{sid}:aside' if loop else f'{sid}:chataside'

    def _inspection_backend_id(self, session: Any, loop: bool) -> str:
        if loop:
            state = self._loop_state(session.id)
            return (state.policy.backend_for('aside') if state and state.policy else '') or session.backend_id
        return self._chat_extras_get(session.id).aside_backend_id or session.backend_id

    def _reserve_inspection(self, sid: str, turn_id: str, loop: bool) -> dict:
        if not hasattr(self, '_inspection_jobs'):
            self._inspection_jobs = {}
        key = self._inspection_key(sid, loop)
        if key in self._inspection_jobs:
            raise InspectionError('busy', '上一条旁路仍在回答或确认清理结果。')
        session = self._active_sessions.get(sid) or self._session_store.load(sid)
        backend_id = self._inspection_backend_id(session, loop) if session else ''
        identity = QueryIdentity.capture(session, owner=self._current_owner_id(),
            executor=self._loop_environment_executor(), backend_id=backend_id, turn_id=turn_id)
        state = self._loop_state(sid) if loop else self._chat_extras_get(sid)
        if any(t.id != turn_id and t.status == 'answering' and t.inspection for t in state.asides):
            raise InspectionError('busy', '历史旁路尚未确认退出，不能重复启动；请核对原执行端。')
        # 元数据入口可能尚未水合 Session；首次加载后固定缓存，删除后不读盘复活。
        self._active_sessions.setdefault(sid, session)
        job = {'identity': identity, 'task': None, 'runner': None, 'cancelled': False, 'sequence': 0,
               'configRevision': self._inspection_config_revision(backend_id), 'taskCancelled': False,
               'started': time.monotonic()}
        self._inspection_jobs[key] = job
        (self._aside_running if loop else self._chat_aside_running).add(sid)
        return job

    def _launch_inspection(self, sid: str, turn_id: str, images: Any, attention: Any, loop: bool) -> None:
        job = self._inspection_jobs[self._inspection_key(sid, loop)]
        job['task'] = asyncio.create_task(self._run_inspection_turn(sid, turn_id, images, attention, loop))

    def _accept_inspection(self, state: Any, turn: Any, images: Any, attention: Any, loop: bool) -> str:
        sid = state.session_id
        try:
            job = self._reserve_inspection(sid, turn.id, loop)
        except Exception as exc:
            return json.dumps({'status': 'error', 'message': str(exc)}, ensure_ascii=False)
        turn.inspection = {'requestId': turn.id, 'phase': 'preparing',
                           'message': '正在准备只读项目答疑', 'sequence': 0}
        state.asides.append(turn)
        try:
            (self._loop_save if loop else self._chat_extras_save)(state)
            (self._emit_loop_updated if loop else self._emit_chat_aside_updated)(state)
            self._launch_inspection(sid, turn.id, images, attention, loop)
        except Exception:
            # 尚未发起模型/文件读取，失败无需占用请求；保留问题而不冒充已接收。
            turn.status = 'error'
            turn.inspection.update(phase='error', message='问题保存或提交失败，未开始只读查询', errorCode='submission_failed')
            self._release_inspection(sid, self._inspection_key(sid, loop), loop, job)
            return json.dumps({'status': 'error', 'message': turn.inspection['message']}, ensure_ascii=False)
        return json.dumps({'status': 'ok', 'turnId': turn.id}, ensure_ascii=False)

    def _cancel_inspection(self, sid: str, loop: bool) -> str:
        job = getattr(self, '_inspection_jobs', {}).get(self._inspection_key(sid, loop))
        if job:
            job['cancelled'] = True
            if job['runner']:
                job['runner'].cancel()
                task = job.get('task')
                if task and not task.done() and not job['taskCancelled']:
                    job['taskCancelled'] = True
                    task.cancel()
            # 尚未进入 coroutine 时不 cancel Task，确保其负责记录终态和释放预留。
        return json.dumps({'status': 'ok', 'aborting': bool(job)}, ensure_ascii=False)

    async def _run_inspection_turn(self, sid: str, turn_id: str, images: Any,
                                   attention: Any, loop: bool) -> None:
        key = self._inspection_key(sid, loop)
        state = self._loop_state(sid) if loop else self._chat_extras_get(sid)
        turn = next((t for t in state.asides if t.id == turn_id), None) if state else None
        if turn is None:
            job = getattr(self, '_inspection_jobs', {}).get(key)
            if job and job['identity'].turn_id == turn_id:
                self._release_inspection(sid, key, loop, job)
            return
        job = getattr(self, '_inspection_jobs', {}).get(key)
        runner = None
        terminal, terminal_message, error_code = 'done', '回答完成', ''

        def publish(phase: str, message: str) -> None:
            if job is None:
                return
            job['sequence'] += 1
            turn.inspection = clean_inspection({'requestId': turn_id, 'phase': phase, 'message': message,
                'sequence': job['sequence'], 'sampledAt': sampled_at, 'updatedAt': time.time(),
                'errorCode': error_code, 'sources': runner.queries.sources if runner else []})
            turn.updated_at = time.time()
            if loop:
                self._loop_save(state)
                self._emit_loop_updated(state)
            else:
                self._chat_extras_save(state)
                self._emit_chat_aside_updated(state)

        sampled_at = time.time()
        try:
            # 内部直接调用/旧测试同样必须经过身份预留，不存在无约束旧路径。
            if job is None:
                job = self._reserve_inspection(sid, turn_id, loop)
            if job['identity'].turn_id != turn_id:
                raise InspectionError('busy', '旁路请求身份不匹配。')
            job['task'] = asyncio.current_task()
            if job['cancelled']:
                raise asyncio.CancelledError()
            publish('preparing', '正在准备只读项目答疑')
            session = self._active_sessions.get(sid) or self._session_store.load(sid)
            identity = job['identity']
            def validate() -> None:
                current = self._active_sessions.get(sid)
                # session 被删除或迁移后不读盘重建旧身份。
                if current is None:
                    raise InspectionError('identity_changed', 'Session 已关闭或失效，请重新提问。')
                identity.validate(current, owner=self._current_owner_id(), executor=self._loop_environment_executor(),
                                  backend_id=self._inspection_backend_id(current, loop))
                if self._inspection_config_revision(identity.backend_id) != job['configRevision']:
                    raise InspectionError('identity_changed', 'Backend 配置已变化，请重新提问。')
            validate()
            from .text_only import TEXT_ONLY_BACKENDS, send_text_only
            def runtime_read() -> dict:
                return runtime_evidence(session, self._loop_state(sid) if loop else None,
                    running=sid in getattr(self, '_loop_running', set()) if loop else None)
            related = [t for t in state.asides if t.id != turn_id and t.context_key == turn.context_key
                       and t.status == 'done' and t.answer][-4:]
            query = InspectionQueries(identity, validate, runtime_read, budget=QueryBudget(started=job['started']),
                openspec=OpenSpecInspection(turn.question, binding=state.task_source.get('binding', {}) if loop else {},
                    intent=user_intent(state) + '\n' + str(getattr(state.policy, 'strategy', '') or '') if loop else ''))
            async def generate(content: str, rules: str, receive: Any) -> None:
                def on_delta(delta: Any) -> None:
                    if delta.type == 'error':
                        raise InspectionError('model_error', (delta.error or '模型调用失败')[:600])
                    if delta.type == 'text_delta' and delta.text:
                        receive(delta.text)
                await send_text_only(backend, content=content, constraints=rules, session_id=key,
                    message_id=turn_id, on_delta=on_delta, images=images,
                    model_override=(runtime or {}).get('model'), reasoning_effort=(runtime or {}).get('reasoningEffort'))
            def output(text: str) -> None:
                turn.answer = text
                (self._emit_aside_delta if loop else self._emit_chat_aside_delta)(sid, turn_id, text)
            runner = InspectionRunner(query, generate, publish, output)
            job['runner'] = runner
            if job['cancelled']:
                runner.cancel()
                raise asyncio.CancelledError()
            async def reference(awaitable: Any) -> str:
                # 参考资料读盘也归本请求拥有：取消等待不遗忘 to_thread 的真实结束。
                task = asyncio.create_task(awaitable)
                query.pending.add(task)
                task.add_done_callback(query._finished)
                try:
                    value = await asyncio.wait_for(asyncio.shield(task), query.budget.remaining())
                except asyncio.TimeoutError:
                    runner.cancel()
                    raise InspectionError('timeout', '读取参考资料超时，正在确认退出。') from None
                validate()
                query.budget.check()
                return value
            manual = await reference(self._skill_reference_content(turn.question, images))
            facts = await reference(self._skill_reference_snapshot(turn.question, session, inspect_project=False)) if manual else ''
            backend = self._new_backend_instance(identity.backend_id)  # 失败明确返回，不静默改用主 Backend。
            kind = getattr(backend.config.type, 'value', backend.config.type)
            if kind not in TEXT_ONLY_BACKENDS:
                raise InspectionError('unsupported', '当前 Backend 不支持隔离只读答疑，请选择文本模型。')
            runtime = self._loop_runtime(session, state, 'aside', identity.backend_id) if loop else self._session_runtime(session)
            context = {'runtime': runtime_read(), 'attention': attention or {
                'key': turn.context_key, 'label': turn.context_label, 'detail': turn.context_detail},
                'recentQuestions': [{'question': t.question[:4000], 'answer': t.answer[:4000]} for t in related],
                'skillReference': manual, 'registeredSkillFacts': facts,
                'sessionConstraints': str(session.constraints or '')[:12000]}
            await runner.run(context, turn.question)
        except asyncio.CancelledError:
            terminal, terminal_message = 'cancelled', '本次旁路已停止，主线不受影响'
            if runner:
                runner.cancel()
        except Exception as exc:
            terminal = 'error'
            error_code = exc.code if isinstance(exc, InspectionError) else 'model_error'
            terminal_message = str(exc)[:600] or '旁路查询失败'
            turn.answer = (turn.answer + '\n\n' if turn.answer else '') + '❌ ' + terminal_message
        finally:
            if job and job.get('identity').turn_id == turn_id:
                if runner and not await runner.settled():
                    turn.status = 'answering'
                    publish('unknown', '结果待确认：旁路调用或读取尚未确认退出，主线不受影响')
                    # 仅等拥有的任务结束，无查询轮询/重放；预留保留至确认。
                    job['cleanup'] = asyncio.create_task(self._finish_inspection(
                        sid, key, loop, job, turn, publish, terminal, terminal_message, runner))
                else:
                    turn.status = terminal
                    try:
                        publish(terminal, terminal_message)
                    finally:
                        self._release_inspection(sid, key, loop, job)
            elif not job:
                turn.status = 'error'
                if loop:
                    self._loop_save(state)
                    self._emit_loop_updated(state)
                else:
                    self._chat_extras_save(state)
                    self._emit_chat_aside_updated(state)

    async def _finish_inspection(self, sid: str, key: str, loop: bool, job: dict, turn: Any,
                                 publish: Any, terminal: str, message: str, runner: InspectionRunner) -> None:
        await asyncio.gather(*(runner.pending | runner.queries.pending), return_exceptions=True)
        if getattr(self, '_inspection_jobs', {}).get(key) is not job:
            return
        turn.status = terminal
        try:
            publish(terminal, message)
        finally:
            self._release_inspection(sid, key, loop, job)

    def _release_inspection(self, sid: str, key: str, loop: bool, job: dict) -> None:
        if self._inspection_jobs.get(key) is job:
            self._inspection_jobs.pop(key, None)
            (self._aside_running if loop else self._chat_aside_running).discard(sid)

"""执行端语言服务实例、冻结启用计划与版本化缓冲区；不接收任意 LSP 命令。"""
from __future__ import annotations

import asyncio
import copy
from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse
import uuid
from xml.sax.saxutils import escape

from .engine_workbench import EngineeringActivity, WorkbenchError, WorkspaceIdentity
from .language_providers import ProviderPlan, provider_plan
from .language_protocol import LspChannel, LspError
from .language_tools import asset, clean_environment, full_text_edit, run_tool
from . import paths
from .workspace_documents import safe_document_path
from .workbench_windows import identifier

MAX_TEXT = 2 * 1024 * 1024
METHODS = {'completion': 'textDocument/completion', 'definition': 'textDocument/definition',
           'references': 'textDocument/references', 'rename': 'textDocument/rename', 'format': 'textDocument/formatting'}
CAPABILITIES = {'completion': 'completionProvider', 'definition': 'definitionProvider', 'references': 'referencesProvider',
                'rename': 'renameProvider', 'format': 'documentFormattingProvider'}


def file_relative(workspace: WorkspaceIdentity, uri: Any) -> str:
    if not isinstance(uri, str) or len(uri) > 8192:
        raise WorkbenchError('language_location_invalid')
    parsed = urlparse(uri)
    if parsed.scheme != 'file' or parsed.netloc not in ('', 'localhost') or parsed.query or parsed.fragment:
        raise WorkbenchError('language_location_outside_workspace')
    path = unquote(parsed.path)
    if os.name == 'nt' and len(path) > 2 and path[0] == '/' and path[2] == ':':
        path = path[1:]
    try:
        relative = Path(os.path.normcase(str(Path(path).resolve()))).relative_to(Path(workspace.workingDir)).as_posix()
    except ValueError as error:
        raise WorkbenchError('language_location_outside_workspace') from error
    safe_document_path(workspace.workingDir, relative)
    return relative


@dataclass
class LanguageDocument:
    path: str
    uri: str
    revision: int
    text: str
    version: int


@dataclass
class LanguageService:
    plan: ProviderPlan
    lease: EngineeringActivity
    resource_id: str
    generation: str
    request_id: str
    cache: Path
    status: str = 'initializing'
    reason: str = ''
    revision: int = 1
    channel: Any = None
    task: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    capabilities: dict[str, Any] = field(default_factory=dict)
    documents: dict[str, LanguageDocument] = field(default_factory=dict)
    diagnostics: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict)
    document_sequence: int = 0
    request_tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    sync_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tool_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    helpers: set[Any] = field(default_factory=set)
    lease_released: bool = False
    provider_ready: asyncio.Event = field(default_factory=asyncio.Event)
    provider_error: bool = False
    settings: dict[str, Any] = field(default_factory=dict)
    notice: asyncio.TimerHandle | None = None
    notice_task: asyncio.Task | None = None

    def snapshot(self) -> dict[str, Any]:
        return {'workspace': self.plan.workspace.to_dict(), 'resourceId': self.resource_id, 'generation': self.generation,
                'requestId': self.request_id, 'provider': self.plan.config['provider'], 'status': self.status,
                'reasonCode': self.reason, 'revision': self.revision, 'planFingerprint': self.plan.fingerprint,
                'config': self.plan.config, 'dependencies': self.plan.dependencies, 'activityId': self.lease.activity_id,
                'exitConfirmed': self.status == 'stopped', 'capabilities': {
                    action: bool(self.capabilities.get(capability)) for action, capability in CAPABILITIES.items()},
                'diagnosticCount': sum(len(row['items']) for row in self.diagnostics.values()),
                'documents': [{'relativePath': doc.path, 'revision': doc.revision, 'protocolVersion': doc.version}
                              for doc in self.documents.values()]}


class LanguageManager:
    def __init__(self, bridge: Any, channel_factory: Callable[..., Any] = LspChannel) -> None:
        self.bridge, self.channel_factory = bridge, channel_factory
        self.plans: OrderedDict[tuple[str, str], ProviderPlan] = OrderedDict()
        self.rows: OrderedDict[str, LanguageService] = OrderedDict()

    def plan(self, workspace: WorkspaceIdentity, config: Any) -> ProviderPlan:
        plan = provider_plan(workspace, config)
        self.plans[workspace.workspaceRevision, plan.fingerprint] = plan
        while len(self.plans) > 64:
            self.plans.popitem(last=False)
        return plan

    def require(self, workspace: WorkspaceIdentity, resource: str, generation: str) -> LanguageService:
        row = self.rows.get(identifier(resource))
        if row is None or row.generation != identifier(generation):
            raise WorkbenchError('language_instance_unavailable')
        row.plan.workspace.require_match(workspace.to_dict())
        return row

    def changed(self, row: LanguageService) -> None:
        row.revision += 1
        if row.notice or row.notice_task and not row.notice_task.done():
            return
        async def notify() -> None:
            version = row.revision
            try:
                await self.bridge._send_for_session(row.plan.workspace.sessionId, {'event': 'languageServiceUpdated',
                    'data': json.dumps({'sessionId': row.plan.workspace.sessionId, **row.snapshot()}, ensure_ascii=False)},
                    owner_id=row.plan.workspace.ownerId)
            except (RuntimeError, OSError):
                pass
            finally:
                row.notice_task = None
                if row.revision != version:
                    self.changed(row)
        def send() -> None:
            row.notice = None; row.notice_task = asyncio.create_task(notify())
        row.notice = asyncio.get_running_loop().call_later(.15, send)

    def start(self, workspace: WorkspaceIdentity, p: dict[str, Any]) -> LanguageService:
        request = identifier(p.get('requestId'))
        plan = self.plans.get((workspace.workspaceRevision, p.get('planFingerprint')))
        if not plan:
            raise WorkbenchError('language_plan_unavailable')
        if p.get('allowProjectCode') is not True or p.get('allowWorkspaceWrite') is not True:
            raise WorkbenchError('language_project_trust_required')
        if (plan.config.get('mavenImport') or plan.config.get('gradleImport')) and p.get('allowBuildImport') is not True:
            raise WorkbenchError('language_build_import_trust_required')
        if provider_plan(workspace, plan.config).fingerprint != plan.fingerprint:
            raise WorkbenchError('language_plan_changed')
        for row in self.rows.values():
            if row.plan.workspace == workspace and row.request_id == request:
                if row.plan.fingerprint != plan.fingerprint:
                    raise WorkbenchError('language_request_conflict')
                return row
            if row.plan.workspace == workspace and row.plan.config['provider'] == plan.config['provider'] and row.status != 'stopped':
                raise WorkbenchError('language_provider_already_running')
        if sum(row.status != 'stopped' for row in self.rows.values()) >= 8 or len(self.rows) >= 64:
            raise WorkbenchError('language_instance_limit')
        lease = self.bridge._engineering_admit(workspace.sessionId, workspace.to_dict(), p.get('controlRevision'), 'language-write')
        resource = uuid.uuid4().hex
        cache = paths.sub('engineering', hashlib.sha256(workspace.ownerId.encode()).hexdigest(), resource)
        row = LanguageService(plan, lease, resource, uuid.uuid4().hex, request, cache)
        self.rows[resource] = row; row.task = asyncio.create_task(self._start(row))
        return row

    def _configuration(self, row: LanguageService, items: list) -> list:
        result = []
        for item in items:
            value: Any = row.settings or row.plan.settings
            for key in str(item.get('section', '')).split('.') if item.get('section') else []:
                value = value.get(key) if isinstance(value, dict) else None
            result.append(value)
        return result

    def _notification(self, row: LanguageService, method: str, params: Any) -> None:
        if row.plan.config['provider'] == 'java' and method == 'language/status' and isinstance(params, dict):
            if params.get('type') == 'ServiceReady':
                row.provider_ready.set()
            elif params.get('type') == 'Error':
                row.provider_error = True; row.provider_ready.set()
                self._failed(row, 'java_project_import_failed_check_offline_dependencies')
            return
        if method != 'textDocument/publishDiagnostics' or not isinstance(params, dict):
            return
        try:
            path = file_relative(row.plan.workspace, params.get('uri'))
        except WorkbenchError:
            return  # 不把工作区外诊断变成自动读取入口。
        doc = row.documents.get(path)
        if not doc:
            return
        version = params.get('version')
        if version is not None and version != doc.version:
            return
        if version is None and row.diagnostics.get(path, {}).get('freshness') == 'current':
            return  # 无版本推送不能降级已核验的诊断。
        items = params.get('diagnostics')
        if not isinstance(items, list):
            return
        bounded = []
        for item in items[:500]:
            if not isinstance(item, dict) or not isinstance(item.get('message'), str):
                continue
            bounded.append({'range': item.get('range'), 'severity': item.get('severity', 3), 'message': item['message'][:4096],
                            'source': str(item.get('source', row.plan.config['provider']))[:128]})
        row.diagnostics[path] = {'relativePath': path, 'revision': doc.revision if version is not None else None,
            'protocolVersion': version, 'freshness': 'current' if version is not None else 'unversioned',
            'items': bounded, 'truncated': len(items) > 500}
        row.diagnostics.move_to_end(path)
        while len(row.diagnostics) > 32 or len(json.dumps(list(row.diagnostics.values()), ensure_ascii=False)) > 2 * 1024 * 1024:
            row.diagnostics.popitem(last=False)
        self.changed(row)

    def _failed(self, row: LanguageService, reason: str) -> None:
        if row.status in ('stopping', 'stopped'):
            return
        row.status = 'failed'; row.reason = reason; self.changed(row)
        if row.task and row.task.done() and (not row.stop_task or row.stop_task.done()):
            row.stop_task = asyncio.create_task(self._stop(row))

    async def _start(self, row: LanguageService) -> None:
        try:
            self.bridge._engineering_recheck(row.lease)
            row.cache.mkdir(parents=True, exist_ok=False)
            argv = list(row.plan.argv)
            row.settings = copy.deepcopy(row.plan.settings)
            options = copy.deepcopy(row.plan.options)
            if row.plan.config['provider'] == 'java':
                argv[1:1] = ['-Duser.home=' + str(row.cache), '-Djava.io.tmpdir=' + str(row.cache)]
                argv += ['-configuration', str(row.cache / 'configuration'), '-data', str(row.cache / 'jdt-data')]
                # m2e 不保证采用 JVM maven.repo.local。显式隔离 settings，不继承用户镜像/凭据。
                repository = row.plan.config.get('mavenRepository', str(row.cache / 'maven-repository'))
                settings_file = row.cache / 'maven-settings.xml'
                settings_file.write_text('<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">'
                    '<offline>true</offline><localRepository>' + escape(repository) +
                    '</localRepository></settings>', encoding='utf-8')
                row.settings.setdefault('java', {}).setdefault('configuration', {})['maven'] = {
                    'userSettings': str(settings_file), 'globalSettings': str(settings_file)}
                options['settings'] = row.settings
            env = clean_environment(row.cache)
            if row.plan.formatter.get('kind') == 'ruff':
                version = await run_tool(row, [row.plan.config['ruffPath'], '--version'], timeout=10, limit=1024)
                if version.strip() != 'ruff 0.11.13':
                    raise LspError('ruff_version_mismatch')
            folders = [{'uri': Path(row.plan.workspace.workingDir).as_uri(), 'name': Path(row.plan.workspace.workingDir).name}]
            row.channel = self.channel_factory(lambda m, p: self._notification(row, m, p),
                lambda items: self._configuration(row, items), folders, lambda reason: self._failed(row, reason))
            await row.channel.start(argv, row.plan.workspace.workingDir, env)
            initialized = await row.channel.request('initialize', {'processId': None, 'rootUri': folders[0]['uri'], 'workspaceFolders': folders,
                'clientInfo': {'name': 'AgentWithU', 'version': '1'}, 'capabilities': {
                    'general': {'positionEncodings': ['utf-16']}, 'workspace': {'configuration': True, 'workspaceFolders': True,
                        'applyEdit': False, 'workspaceEdit': {'documentChanges': True, 'resourceOperations': []}},
                    'textDocument': {'synchronization': {'didSave': False}, 'publishDiagnostics': {'versionSupport': True},
                        'completion': {'completionItem': {'snippetSupport': False, 'resolveSupport': {'properties': []}}},
                        'definition': {'linkSupport': True}, 'references': {}, 'rename': {'prepareSupport': True}, 'formatting': {}}},
                'initializationOptions': options}, timeout=90)
            if not isinstance(initialized, dict) or not isinstance(initialized.get('capabilities'), dict):
                raise LspError('language_initialization_invalid')
            row.capabilities = initialized['capabilities']
            if row.plan.formatter.get('kind') in ('ruff', 'prettier'):
                row.capabilities['documentFormattingProvider'] = True
            if row.capabilities.get('positionEncoding', 'utf-16') != 'utf-16':
                raise LspError('language_position_encoding_unsupported')
            await row.channel.notify('initialized', {})
            await row.channel.notify('workspace/didChangeConfiguration', {'settings': row.settings})
            if row.plan.config['provider'] == 'java':
                await asyncio.wait_for(row.provider_ready.wait(), 90)
                if row.provider_error:
                    raise LspError('java_project_import_failed_check_offline_dependencies')
            row.status = 'ready'; self.changed(row)
        except (OSError, ValueError, RuntimeError, asyncio.TimeoutError) as error:
            row.status = 'failed'; row.reason = str(error) if isinstance(error, LspError) else 'language_start_failed'; self.changed(row)
            await self._stop(row)

    async def sync(self, row: LanguageService, p: dict[str, Any]) -> LanguageDocument:
        if row.status != 'ready':
            raise WorkbenchError('language_not_ready')
        self.bridge._engineering_recheck(row.lease)
        path = safe_document_path(row.plan.workspace.workingDir, p.get('relativePath'), preserve_case=True)
        relative = Path(os.path.normcase(str(path))).relative_to(Path(row.plan.workspace.workingDir)).as_posix()
        text, revision = p.get('text'), p.get('revision')
        if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_TEXT or type(revision) is not int or not 0 <= revision < 2**53:
            raise WorkbenchError('language_document_limit')
        async with row.sync_lock:
            old = row.documents.get(relative)
            if old and revision < old.revision or old and revision == old.revision and text != old.text:
                raise WorkbenchError('language_document_stale')
            if old and old.revision == revision:
                return old
            if not old and len(row.documents) >= 32 or sum(len(doc.text) for key, doc in row.documents.items() if key != relative) + len(text) > 16 * 1024 * 1024:
                raise WorkbenchError('language_document_limit')
            row.document_sequence += 1
            doc = LanguageDocument(relative, path.as_uri(), revision, text, row.document_sequence)
            row.documents[relative] = doc; row.diagnostics.pop(relative, None)
            if old:
                await row.channel.notify('textDocument/didChange', {'textDocument': {'uri': doc.uri, 'version': doc.version},
                                                                  'contentChanges': [{'text': text}]})
            else:
                extension = path.suffix.lower()
                language = {'.java': 'java', '.py': 'python', '.pyi': 'python', '.jsx': 'javascriptreact', '.tsx': 'typescriptreact',
                            '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript',
                            '.mts': 'typescript', '.cts': 'typescript', '.vue': 'vue'}.get(extension)
                if not language:
                    row.documents.pop(relative, None)
                    raise WorkbenchError('language_document_unsupported')
                await row.channel.notify('textDocument/didOpen', {'textDocument': {'uri': doc.uri, 'languageId': language,
                                                                 'version': doc.version, 'text': text}})
            self.changed(row)
            return doc

    async def request(self, row: LanguageService, p: dict[str, Any]) -> dict[str, Any]:
        action, request = p.get('action'), identifier(p.get('requestId'))
        if action not in (*METHODS, 'sync', 'close', 'diagnostics', 'cancel'):
            raise WorkbenchError('language_operation_unsupported')
        if action == 'cancel':
            original = row.request_tasks.get(identifier(p.get('originalRequestId')))
            if original:
                original.cancel()
            return {'status': 'cancel_requested', 'requestId': request}
        if action == 'close':
            self.bridge._engineering_recheck(row.lease)
            path = safe_document_path(row.plan.workspace.workingDir, p.get('relativePath'))
            relative = path.relative_to(Path(row.plan.workspace.workingDir)).as_posix()
            async with row.sync_lock:
                doc = row.documents.get(relative)
                if doc:
                    if p.get('protocolVersion') != doc.version or p.get('revision') != doc.revision:
                        raise WorkbenchError('language_document_stale')
                    if row.status != 'ready':
                        raise WorkbenchError('language_not_ready')
                    await row.channel.notify('textDocument/didClose', {'textDocument': {'uri': doc.uri}})
                    row.documents.pop(relative, None); row.diagnostics.pop(relative, None)
                    self.changed(row)
            return {'status': 'ok', 'service': row.snapshot()}
        if len(row.request_tasks) >= 16 or request in row.request_tasks:
            raise WorkbenchError('language_request_limit')
        row.request_tasks[request] = asyncio.current_task()
        try:
            if action == 'diagnostics':
                await asyncio.wait_for(self._diagnostics(row), 25)
                return {'status': 'ok', 'service': row.snapshot(), 'diagnostics': list(row.diagnostics.values())}
            doc = await self.sync(row, p)
            if action == 'sync':
                return {'status': 'ok', 'service': row.snapshot(), 'revision': doc.revision}
            if not row.capabilities.get(CAPABILITIES[action]):
                raise WorkbenchError('language_operation_unsupported')
            params: dict[str, Any] = {'textDocument': {'uri': doc.uri}}
            if action in ('completion', 'definition', 'references', 'rename'):
                position = p.get('position')
                if not isinstance(position, dict) or any(type(position.get(k)) is not int or not 0 <= position[k] <= MAX_TEXT for k in ('line', 'character')):
                    raise WorkbenchError('language_position_invalid')
                params['position'] = position
            if action == 'references':
                params['context'] = {'includeDeclaration': True}
            elif action == 'rename':
                name = p.get('newName')
                if not isinstance(name, str) or not name or len(name) > 256 or any(c in name for c in '\r\n\0'):
                    raise WorkbenchError('language_name_invalid')
                params['newName'] = name
            elif action == 'format':
                params['options'] = {'tabSize': 4 if row.plan.config['provider'] in ('java', 'python') else 2, 'insertSpaces': True}
            if action == 'format' and row.plan.formatter.get('kind') in ('ruff', 'prettier'):
                async with row.tool_lock:
                    argv = list(row.plan.formatter['argv'])
                    if row.plan.formatter['kind'] == 'ruff':
                        argv += [doc.path, '-']
                    else:
                        # 默认禁用项目 JS 配置和 EditorConfig，不允许项目声明加载格式化插件。
                        argv += ['--no-config', '--no-editorconfig', '--ignore-path', os.devnull, '--stdin-filepath', doc.path]
                    result = full_text_edit(doc.text, await run_tool(row, argv, doc.text.encode('utf-8')))
            else:
                result = await row.channel.request(METHODS[action], params)
            if row.documents.get(doc.path) is not doc or row.status != 'ready':
                raise WorkbenchError('language_document_stale')
            return {'status': 'ok', 'service': row.snapshot(), 'requestId': request, 'relativePath': doc.path,
                    'revision': doc.revision, 'protocolVersion': doc.version, 'result': result}
        finally:
            row.request_tasks.pop(request, None)
            if row.status == 'unknown':
                self.changed(row)

    async def _diagnostics(self, row: LanguageService) -> None:
        if row.status != 'ready':
            raise WorkbenchError('language_not_ready')
        self.bridge._engineering_recheck(row.lease)
        async with row.tool_lock:
            docs = list(row.documents.values())
            if row.plan.config['provider'] == 'java':
                results = []
                for doc in docs:
                    result = await row.channel.request('workspace/executeCommand', {'command': 'awu.java.versionedDiagnostics',
                        'arguments': [{'uri': doc.uri, 'text': doc.text, 'revision': doc.revision}]}, timeout=15)
                    results.append({**result, 'path': doc.path})
            elif row.plan.config['provider'] == 'react':
                config = row.plan.config
                output = await run_tool(row, [config['nodePath'], '--max-old-space-size=768',
                    str(asset('typescript-diagnostics.cjs')), config['typescriptHome'], row.plan.workspace.workingDir],
                    json.dumps({'documents': [{'path': doc.path, 'uri': doc.uri, 'text': doc.text, 'revision': doc.revision} for doc in docs]},
                               ensure_ascii=False).encode('utf-8'))
                results = json.loads(output)
            else:
                return
            if (row.status != 'ready' or any(row.documents.get(doc.path) is not doc for doc in docs)
                    or not isinstance(results, list) or len(results) != len(docs)):
                raise WorkbenchError('language_document_stale')
            for doc, result in zip(docs, results):
                if not isinstance(result, dict) or result.get('path') != doc.path or result.get('revision') != doc.revision:
                    raise WorkbenchError('language_document_stale')
                self._notification(row, 'textDocument/publishDiagnostics', {'uri': doc.uri, 'version': doc.version,
                    'diagnostics': result.get('diagnostics')})

    async def stop(self, row: LanguageService) -> dict[str, Any]:
        if row.status == 'stopped':
            return row.snapshot()
        if not row.stop_task or row.stop_task.done():
            row.status = 'stopping'; self.changed(row)
            row.stop_task = asyncio.create_task(self._stop(row))
        await asyncio.shield(row.stop_task)
        return row.snapshot()

    async def _stop(self, row: LanguageService) -> None:
        requests = {task for task in row.request_tasks.values() if task is not asyncio.current_task()}
        for task in requests:
            task.cancel()
        if row.task and not row.task.done() and row.task is not asyncio.current_task():
            # 初始化等待可取消协议请求，但拥有的进程 stop 不依赖其成功。
            row.task.cancel()
            await asyncio.gather(row.task, return_exceptions=True)
        pending = (await asyncio.wait(requests, timeout=12))[1] if requests else set()
        helpers_confirmed = not pending
        for helper in list(row.helpers):
            if await helper.stop():
                row.helpers.discard(helper)
            else:
                helpers_confirmed = False
        if (not row.channel or await row.channel.stop()) and helpers_confirmed:
            if not row.lease_released:
                self.bridge._engineering_confirm_finished(row.lease); row.lease_released = True
            row.status = 'stopped'
        else:
            row.status = 'unknown'; row.reason = 'language_exit_unconfirmed'
        self.changed(row)


class LanguageBridge:
    def _languages(self) -> LanguageManager:
        if not hasattr(self, '_language_manager'):
            self._language_manager = LanguageManager(self)
        return self._language_manager

    def _rpc_languageServicePlan(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        return json.dumps(self._languages().plan(workspace, p.get('config')).public(), ensure_ascii=False)

    def _rpc_languageServiceList(self, session_id: str, identity_json: str) -> str:
        workspace, _ = self._terminal_args(session_id, identity_json)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        control = self._loop_state(session_id).control_revision if session.session_type == 'loop' else 0
        return json.dumps({'status': 'ok', 'workspace': workspace.to_dict(), 'controlRevision': control,
            'services': [row.snapshot() for row in self._languages().rows.values() if row.plan.workspace == workspace]}, ensure_ascii=False)

    def _rpc_languageServiceStart(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        return json.dumps(self._languages().start(workspace, p).snapshot(), ensure_ascii=False)

    def _rpc_languageServiceDiagnostics(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        row = self._languages().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps({'status': 'ok', 'service': row.snapshot(), 'diagnostics': list(row.diagnostics.values())}, ensure_ascii=False)

    async def _rpc_languageServiceRequest(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload, payload_limit=4 * 1024 * 1024)
        self._window_guard(session_id)
        row = self._languages().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(await self._languages().request(row, p), ensure_ascii=False)

    async def _rpc_languageServiceStop(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        row = self._languages().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(await self._languages().stop(row), ensure_ascii=False)

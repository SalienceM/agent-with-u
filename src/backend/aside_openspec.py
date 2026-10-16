"""按文件事实回答 OpenSpec 进度；不绑定来源、不运行 CLI 或调度主线。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from .aside_files import ReadonlyFiles
from .aside_inspection import InspectionError
from .loop_openspec import manual_policy, task_progress


NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,127}\Z')
CHECKBOX = re.compile(r'^\s*[-*+]\s+\[([^\]]*)\]\s*(.*)$')


def parse_tasks(text: str, path: str) -> list[dict]:
    rows = []
    fence = ''
    for number, line in enumerate(text.splitlines(), 1):
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if marker:
            if not fence:
                fence = marker[1]
            elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = ''
            continue
        if fence or line.startswith(('    ', '\t')):
            continue
        match = CHECKBOX.match(line)
        if match:
            description = match[2].strip()
            if not description:
                continue
            rows.append({'id': f'line:{number}', 'description': description[:2000],
                         'done': match[1].strip().lower() == 'x', 'sourcePath': path, 'line': number})
            if len(rows) > 2000:
                raise InspectionError('limit', '任务超过本次可核对数量，未给出全量完成率。')
    return rows


class OpenSpecInspection:
    def __init__(self, question: str, *, binding: dict | None = None, intent: str = '') -> None:
        self.question = question
        self.binding = dict(binding or {})
        self.skip_manual = manual_policy(intent + '\n' + question)

    @staticmethod
    def _config(files: ReadonlyFiles, path: str) -> dict | None:
        try:
            result = files.text(path, whole=True)
        except FileNotFoundError:
            return None
        try:
            parsed = yaml.safe_load(result['content'])
        except yaml.YAMLError:
            raise InspectionError('unsupported', 'OpenSpec 配置无法解析，未猜测任务布局。') from None
        if parsed is not None and not isinstance(parsed, dict):
            raise InspectionError('unsupported', 'OpenSpec 配置不是对象。')
        return parsed or {}

    def __call__(self, files: ReadonlyFiles, args: dict) -> dict:
        config = self._config(files, 'openspec/config.yaml')
        if config is None:
            config = self._config(files, 'openspec/config.yml') or {}
        if config.get('store'):
            raise InspectionError('unsupported', '项目使用外部 OpenSpec store；未读取其他工作区。')
        page = files.directory('openspec/changes')
        if not page['complete']:
            raise InspectionError('limit', '候选目录未完整读取，不能假定只有一个 change。')
        names = sorted(item['name'] for item in page['entries']
                       if item['directory'] and NAME.fullmatch(item['name']) and item['name'] != 'archive')
        explicit = re.findall(r'(?:openspec[/\\]changes[/\\]|(?:change|变更)\s*[:：]?\s+|'
                              r'(?:openspec-(?:apply-change|verify-change)|opsx[: -](?:apply|verify))\s+)'
                              r'([a-z0-9][a-z0-9-]*)', self.question, re.I)
        mentioned = [name for name in names if re.search(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])', self.question)]
        selected = args.get('change', '')
        if selected and not NAME.fullmatch(selected):
            raise InspectionError('invalid_query', 'change 必须是当前项目中的真实名称，不能是命令或路径。')
        if explicit:
            if any(name not in names for name in explicit):
                raise InspectionError('missing', '明确指定的 change 不存在，未改查其他来源。')
            mentioned = list(dict.fromkeys(explicit))
        all_requested = args.get('all', False)
        if all_requested and not re.search(r'全部|所有|汇总|\ball\b', self.question, re.I):
            raise InspectionError('invalid_query', '用户未请求全部汇总，请先确定查阅目标。')
        if mentioned:
            if selected and selected not in mentioned:
                raise InspectionError('invalid_query', '查询不能替换用户明确指定的目标。')
            selected_names = mentioned
        elif all_requested:
            selected_names = names
        elif selected:
            # 模型只能选择用户问题中的名称或已关联/唯一目标，不能猜“最新”。
            permitted = self._bound_change(files) or (names[0] if len(names) == 1 else '')
            if selected != permitted:
                return {'status': 'ambiguous', 'candidates': names, 'complete': True,
                        'message': '请明确要查阅的 change；此选择不会修改主线绑定。'}
            selected_names = [selected]
        elif self.binding.get('change'):
            selected_names = [self._bound_change(files)]
        elif len(names) == 1:
            selected_names = names
        else:
            return {'status': 'ambiguous' if names else 'missing', 'candidates': names,
                    'complete': True, 'message': '请选择要查阅的 change。' if names else '未发现活动 change；不代表项目已完成。'}
        if any(name not in names for name in selected_names):
            raise InspectionError('missing', '原查阅来源已消失或归档，未自动切换 change。')
        if len(selected_names) > 12:
            raise InspectionError('limit', '汇总范围超过 12 个 change，请缩小范围。')
        results = []
        for name in selected_names:
            files.budget.check()
            change_config = self._config(files, f'openspec/changes/{name}/.openspec.yaml') or {}
            if change_config.get('schema', config.get('schema', 'spec-driven')) != 'spec-driven':
                raise InspectionError('unsupported', '当前 change 使用自定义 schema，未把未知任务布局当作零任务。')
            path = f'openspec/changes/{name}/tasks.md'
            for attempt in range(2):
                try:
                    document = files.text(path, whole=True)
                    rows = parse_tasks(document['content'], path)
                    # 统计后再次核对实际同一文件；变化只重读一次。
                    files.text(path, limit=1, revision=document['revision'])
                    break
                except InspectionError as exc:
                    if exc.code != 'changed' or attempt:
                        raise
            progress = task_progress({'tasks': rows}, self.skip_manual)
            total, checked = progress['total'], progress['checked']
            manual = len(progress['manualIds'])
            results.append({key: value for key, value in document.items() if key != 'content'} | {
                'change': name, 'total': total, 'checked': checked, 'unchecked': total - checked,
                'percent': round(100 * checked / total, 2) if total else None,
                'manualExcluded': manual, 'manualExclusionExplicit': self.skip_manual,
                'automatic': {'checked': checked, 'total': total - manual} if self.skip_manual else None,
                'tasks': rows[:100], 'taskDetailsLimited': len(rows) > 100,
                'workflowState': 'not_checked', 'acceptance': 'not_inferred'})
        return {'status': 'ok', 'results': results, 'complete': True,
                'message': '任务文件勾选统计；不是 CLI 就绪、模型 verify 或人工验收结论。'}

    def _bound_change(self, files: ReadonlyFiles) -> str:
        if not self.binding.get('change'):
            return ''
        workspace = self.binding.get('workspace')
        if workspace and Path(workspace) != Path(files.identity.root):
            raise InspectionError('identity_changed', '关联来源不属于当前工作区。')
        for key, expected in (('executor', files.identity.executor), ('sessionId', files.identity.session_id)):
            if self.binding.get(key) and self.binding[key] != expected:
                raise InspectionError('identity_changed', '关联来源不属于当前执行节点或 Session。')
        return self.binding['change']

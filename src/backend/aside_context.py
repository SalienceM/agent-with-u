"""Read-only Session anchors for aside Q&A; references never replace attention."""
from __future__ import annotations

import os
import stat
from itertools import islice
from pathlib import Path
from typing import Any


def migrate_reference_attention(data: dict) -> dict:
    """旧版把 @SKILL 单独分流；只迁回所属 Session，保留真正的资源库面板线程。"""
    if str(data.get('contextKey') or '').startswith('skills:'):
        return {**data, 'contextKey': 'session', 'contextKind': 'session',
                'contextLabel': '', 'contextDetail': ''}
    return data


def project_reference_snapshot(session: Any) -> dict:
    """按提问读取当前执行端的有限项目资料，不启动进程、不扫描整仓库、不读凭据。"""
    result: dict[str, Any] = {
        'sessionId': session.id, 'title': session.title,
        'workingDirectory': session.working_dir, 'backendId': session.backend_id,
        'inspection': 'not_inspected',
        'limits': '仅工作目录浅层清单及指定项目文档片段；不代表已通读代码、验证 CLI 或完成初始化。',
    }
    if getattr(session, 'codex_connection_mode', '') == 'ssh' or getattr(session, 'codex_remote_host', None):
        result['reason'] = 'SSH 项目不在本执行节点，未读取本机同名目录；需要远端项目资料。'
        return result
    try:
        candidate = Path(session.working_dir or '')
        if not candidate.is_absolute():
            result['reason'] = 'Session 未设置绝对工作目录，不能用服务进程目录代替。'
            return result
        root = candidate.resolve(strict=True)
        if not root.is_dir():
            result['reason'] = 'Session 工作目录不是目录。'
            return result

        def confined(relative: str) -> Path:
            path = (root / relative).resolve()
            if not path.is_relative_to(root):
                raise ValueError('outside workspace')
            return path

        def directory_names(relative: str) -> dict:
            try:
                path = confined(relative)
                with os.scandir(path) as iterator:
                    # 大仓库也不遍历全部目录项；不进入子目录、不跟随目录链接。
                    candidates = list(islice(iterator, 161))
                names = sorted(entry.name + ('/' if entry.is_dir(follow_symlinks=False) else '')
                               for entry in candidates[:160] if not entry.name.startswith('.')
                               and entry.name not in {'node_modules', '__pycache__', 'archive', 'dist', 'target'})
                return {'status': 'present', 'entries': names[:40],
                        'truncated': len(candidates) > 160 or len(names) > 40}
            except FileNotFoundError:
                return {'status': 'missing'}
            except (OSError, ValueError):
                return {'status': 'unavailable'}

        result['inspection'] = 'bounded_read_only'
        result['root'] = directory_names('.')
        result['openspecSpecs'] = directory_names('openspec/specs')
        result['openspecChanges'] = directory_names('openspec/changes')
        documents = []
        remaining = 10_000
        for relative in ('README.md', 'package.json', 'pyproject.toml', 'openspec/config.yaml'):
            item: dict[str, Any] = {'path': relative}
            try:
                path = confined(relative)
                if not stat.S_ISREG(path.stat().st_mode):
                    raise ValueError('not a regular file')
                with path.open('rb') as source:
                    raw = source.read(16_001)
                if b'\0' in raw:
                    raise ValueError('binary data')
                content = raw[:16_000].decode('utf-8', errors='replace')
                limit = min(2500, remaining)
                item.update(status='present', content=content[:limit],
                            truncated=len(raw) > 16_000 or len(content) > limit)
                remaining -= len(item['content'])
            except FileNotFoundError:
                item['status'] = 'missing'
            except (OSError, ValueError):
                item['status'] = 'unavailable'
            documents.append(item)
        result['documents'] = documents
    except (OSError, ValueError):
        result['reason'] = 'Session 工作目录不可读取，不能据此猜测项目结构。'
    return result

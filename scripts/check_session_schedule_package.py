"""只读检查定时功能的实际 sidecar 归档与前端构建输入；不启动或安装程序。"""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.package_readiness import SCHEDULE_MODULES, SCHEDULE_TIMEZONES

FRONTEND_MARKERS = {
    'entry': 'Session 定时指令',
    'protocol': 'sessionScheduleSave',
    'manual': 'Session 定时任务',
    'guide': '# Session 定时指令',
    'releaseNotes': '# 定时任务发布说明（待发布）',
}


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(data)
    return result.hexdigest()


def check_backend(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {'path': str(path.resolve()), 'ok': False, 'failures': []}
    if not path.is_file():
        result['failures'] = ['artifact_missing']
        return result
    result['sha256'] = sha256(path)
    try:
        from PyInstaller.archive.readers import CArchiveReader
        from io import BytesIO
        from zoneinfo import ZoneInfo
        archive = CArchiveReader(str(path))
        pyz = next(name for name in archive.toc if name.endswith('.pyz'))
        modules = archive.open_embedded_archive(pyz).toc
        result['failures'] += ['module:' + name for name in SCHEDULE_MODULES if name not in modules]
        names = {name.replace('\\', '/'): name for name in archive.toc}
        for zone in SCHEDULE_TIMEZONES:
            name = 'tzdata/zoneinfo/' + zone
            try:
                ZoneInfo.from_file(BytesIO(archive.extract(names[name])), key=zone)
            except (KeyError, OSError, ValueError, TypeError):
                result['failures'].append('resource:' + name)
    except (ImportError, OSError, ValueError, StopIteration) as exc:
        result['failures'].append('archive_unreadable:' + type(exc).__name__)
    result['ok'] = not result['failures']
    return result


def check_frontend(directory: Path) -> dict[str, Any]:
    result: dict[str, Any] = {'path': str(directory.resolve()), 'ok': False, 'failures': [], 'files': []}
    index = directory / 'index.html'
    if not index.is_file():
        result['failures'].append('index_missing')
        return result
    class EntryScripts(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.sources: list[str] = []

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            values = dict(attrs)
            if tag == 'script' and values.get('src') and values.get('type', '') in {'module', 'text/javascript', 'application/javascript', ''}:
                self.sources.append(values['src'])
    parser = EntryScripts()
    parser.feed(index.read_text(encoding='utf-8'))
    found: set[str] = set()
    for source in parser.sources:
        path = (directory / source.removeprefix('/')).resolve()
        if not path.is_relative_to(directory.resolve()) or not path.is_file() or path.suffix != '.js':
            result['failures'].append('invalid_entry_script:' + source)
            continue
        content = path.read_text(encoding='utf-8')
        matches = [key for key, value in FRONTEND_MARKERS.items() if value in content]
        if matches:
            found.update(matches)
            result['files'].append({'path': str(path.relative_to(directory.resolve())), 'sha256': sha256(path), 'contains': matches})
    result['failures'] += ['frontend:' + key for key in FRONTEND_MARKERS if key not in found]
    result['ok'] = not result['failures']
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', type=Path, default=ROOT / 'dist/agent-with-u-backend.exe')
    parser.add_argument('--frontend', type=Path, default=ROOT / 'frontend/dist')
    args = parser.parse_args()
    backend, frontend = check_backend(args.backend), check_frontend(args.frontend)
    result = {'scope': 'sidecar-and-frontend-inputs', 'ok': backend['ok'] and frontend['ok'],
              'backend': backend, 'frontend': frontend,
              'installer': 'not_checked', 'notice': '不证明 MSI/NSIS 已重建、嵌入同次前端或安装成功；没有启动、发布或安装。'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

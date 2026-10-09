"""显式隔离 Git 读取探针，不接触真实仓库/Session：--run-native。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

from src.backend.engine_workbench import WorkspaceIdentity
from src.backend.workspace_search import git_comparison, search_workspace
from .probe_engine_providers import isolated_env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    args = parser.parse_args()
    if not args.run_native:
        parser.error('Requires explicit --run-native')
    git = shutil.which('git')
    if not git:
        parser.error('Git is not installed; no automatic installation')
    with tempfile.TemporaryDirectory(prefix='awu-engine-git-') as temporary:
        root = Path(temporary).resolve()
        if root.parent != Path(tempfile.gettempdir()).resolve():
            raise RuntimeError('Not an isolated test directory')
        home, project = root / 'home', root / 'project'
        home.mkdir(); project.mkdir()
        environment = isolated_env(home)
        environment.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_AUTHOR_NAME': 'AWU fixture', 'GIT_AUTHOR_EMAIL': 'fixture@invalid',
            'GIT_COMMITTER_NAME': 'AWU fixture', 'GIT_COMMITTER_EMAIL': 'fixture@invalid'})
        def setup(*arguments: str) -> None:
            # 写命令仅建立本次独占测试仓库；产品读取调用在下方独立取证。
            subprocess.run([git, *arguments], cwd=project, env=environment, check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, timeout=10)
        setup('init', '--quiet')
        (project / 'a.py').write_bytes(b'old\r\n')
        (project / '.gitignore').write_text('*.hidden\n', encoding='utf-8')
        setup('add', '--', 'a.py', '.gitignore')
        setup('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated fixture')
        (project / 'a.py').write_bytes(b'new\r\n')
        (project / 'private.hidden').write_text('needle', encoding='utf-8')
        setup('config', 'diff.external', 'must-not-execute-awu-fixture')
        setup('config', 'core.fsmonitor', 'must-not-execute-awu-fixture')
        def snapshot() -> dict[str, str]:
            return {path.relative_to(project).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in project.rglob('*') if path.is_file()}
        before = snapshot()
        identity = WorkspaceIdentity('isolated-user', 'isolated-executor', 'isolated-session',
                                     os.path.normcase(str(project)), 'a' * 64)
        result = git_comparison(identity, 'a.py', threading.Event())
        assert result['baseline']['text'] == 'old\n'
        assert result['disk']['text'] == 'new\n'
        matches = search_workspace(identity, 'files', '', 200, (), threading.Event())
        assert {row['relativePath'] for row in matches['results']} == {'a.py', '.gitignore'}
        assert before == snapshot(), 'Read-only comparison/search modified files'
        print(json.dumps({'status': 'passed', 'checks': ['HEAD byte baseline', 'disk byte version',
            'external diff/fsmonitor disabled', 'gitignore', 'all file hashes unchanged'],
            'platform': os.name, 'isolated': True}))


if __name__ == '__main__':
    main()

"""Run merge/workspace regressions without the production user's data or Git config."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    original_cwd = Path.cwd()
    # 短路径避免 Windows worktree + Git 元数据路径超长；TemporaryDirectory 只清理自建根。
    base = Path(project.anchor) if os.name == 'nt' else Path('/tmp')
    with tempfile.TemporaryDirectory(prefix='awu-merge-', dir=base) as folder:
        root = Path(folder).resolve()
        assert root.parent == base.resolve() and root.name.startswith('awu-merge-')
        saved = dict(os.environ)
        try:
            for key, child in [('TEMP', 't'), ('TMP', 't'), ('APPDATA', 'a'), ('LOCALAPPDATA', 'l'), ('AGENT_WITH_U_DATA_ROOT', 'd')]:
                path = root / child; path.mkdir(exist_ok=True); os.environ[key] = str(path)
            os.environ['GIT_CONFIG_GLOBAL'] = os.devnull
            os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
            tempfile.tempdir = str(root / 't')
            os.chdir(project); sys.path.insert(0, str(project))
            names = sys.argv[1:] or ['tests.test_task_workspaces.TaskWorkspaceTests', 'tests.test_project_merges.ProjectMergeTests']
            suite = unittest.defaultTestLoader.loadTestsFromNames(names)
            return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
        finally:
            os.chdir(original_cwd)
            os.environ.clear(); os.environ.update(saved); tempfile.tempdir = None


if __name__ == '__main__':
    raise SystemExit(main())

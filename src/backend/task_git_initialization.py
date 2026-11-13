"""显式创建副本时准备首次 Git 基线；预览仅使用临时元数据，不改源目录。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile
import uuid

from .deepseek_harness_state import reject_links
from .session_collaboration_store import CollaborationError, fingerprint
from .task_git import TaskGit, canonical_path, snapshot_path


def _index_fingerprint(repo: dict) -> str:
    index = Path(repo['gitDir']) / 'index'
    reject_links(index)
    return hashlib.sha256(index.read_bytes()).hexdigest() if index.exists() else ''


def inspect_initial(git: TaskGit, reason: str) -> dict:
    if reason == 'not_git':
        # 损坏的 .git 不能当作普通目录重新初始化，也不能借用父仓库。
        root = Path(git.root)
        if os.path.lexists(root / '.git'):
            raise CollaborationError('项目已有 Git 元数据但无法读取，请先检查；未重新初始化')
        info = root.stat()
        if not root.is_dir():
            raise CollaborationError('项目路径不是目录')
        repo = {'root': git.root, 'commonDir': canonical_path(root / '.git'),
                'gitDir': canonical_path(root / '.git'), 'head': '', 'branch': 'main',
                'repositoryId': fingerprint(['uninitialized', git.root, info.st_dev, info.st_ino])}
        # 使用 Git 自己的 ignore 语义（含嵌套规则），临时仓库从不落入用户项目。
        with tempfile.TemporaryDirectory(prefix='awu-copy-inspect-') as directory:
            git.run('init', '--bare', '--template=', '--initial-branch=main', directory)
            reader = TaskGit(git.root)
            reader.environment = {'GIT_DIR': directory, 'GIT_WORK_TREE': git.root}
            dirty, skills = reader.dirty(), reader.skill_files()
        index_hash = ''
    else:
        repo = git.repository(allow_unborn=True)
        if repo['head'] or not repo['branch'] or repo['gitDir'] != repo['commonDir']:
            raise CollaborationError('首次提交状态已变化或不是主工作区，请重新检查')
        git.disable_filters()
        dirty, skills = git.dirty(), git.skill_files()
        index_hash = _index_fingerprint(repo)
    view = {**repo, 'dirty': dirty, 'initialSkillFiles': skills,
            'initialization': {'kind': 'init' if reason == 'not_git' else 'initial_commit',
                               'branch': repo['branch'], 'indexFingerprint': index_hash}}
    view['fingerprint'] = fingerprint(view)
    return view


def initialize_for_copy(git: TaskGit, expected: dict, selected: list[str], scratch: Path,
                        skill_files: list[dict] | None) -> dict:
    if git.inspect_for_copy()['fingerprint'] != expected['fingerprint']:
        raise CollaborationError('项目或初始化范围已变化，请重新预览')
    if len(selected) > 500 or len(set(selected)) != len(selected):
        raise CollaborationError('快照最多500条不同路径')
    rows = {row['path']: row for row in expected['dirty']}
    # 初始化前完成路径和内容核对；不能先 init 再发现冻结清单不可复制。
    bodies: dict[str, bytes] = {}
    for name in selected:
        snapshot_path(name)
        if name not in rows or rows[name]['blocked']:
            raise CollaborationError('所选路径不可快照：' + name)
        path = Path(git.root) / name
        reject_links(path)
        if path.exists():
            body = path.read_bytes()
            if hashlib.sha256(body).hexdigest() != rows[name]['sha256']:
                raise CollaborationError('快照文件已变化：' + name)
            bodies[name] = body
    if skill_files is not None and expected['initialSkillFiles'] != skill_files:
        raise CollaborationError('项目 Skills 已变化，请重新预览')
    scratch.mkdir(parents=True, exist_ok=True)
    reject_links(scratch)
    if expected['initialization']['kind'] == 'init':
        # mkdir 是初始化所有权边界。另一个操作先创建 .git 时绝不 re-init。
        metadata = Path(git.root) / '.git'
        metadata.mkdir()
        git.run('init', '--initial-branch=main', '--template=')
    repo = git.repository(allow_unborn=True)
    if repo['head'] or repo['branch'] != expected['branch']:
        raise CollaborationError('主分支已有提交或已切换，未覆盖；请重新检查')
    git.disable_filters()
    index = Path(repo['gitDir']) / 'index'
    lock = index.with_name('index.lock')
    reject_links(lock)
    # 标准 Git 索引锁保护已有暂存内容；只改所选文件，未选择的暂存项保留。
    with lock.open('xb'):
        pass
    private = scratch / ('initial-index-' + uuid.uuid4().hex)
    merged = scratch / ('initial-source-index-' + uuid.uuid4().hex)
    try:
        if _index_fingerprint(repo) != expected['initialization']['indexFingerprint']:
            raise CollaborationError('项目暂存区已变化，请重新预览')
        entries: dict[str, tuple[str, str]] = {}
        for token in git.run('ls-files', '--stage', '-z').split(b'\0'):
            if not token:
                continue
            header, name = token.split(b'\t', 1)
            mode, oid, stage = header.decode('ascii').split()
            if stage != '0' or mode not in {'100644', '100755'}:
                raise CollaborationError('首次提交不支持冲突、链接或子模块暂存项')
            entries[name.decode('utf-8')] = (mode, oid)
        initial_entries = []
        for name in selected:
            if name in entries:
                # 沿用用户已暂存版本；工作区修改继续保留，副本再按所选当前内容快照。
                mode, oid = entries[name]
            elif name in bodies:
                mode = '100755' if os.name != 'nt' and (Path(git.root) / name).stat().st_mode & 0o111 else '100644'
                oid = git.run('hash-object', '-w', '--stdin', data=bodies[name]).decode().strip()
            else:
                continue
            initial_entries.append(f'{mode} {oid}\t{name}'.encode('utf-8') + b'\0')
        env = {'GIT_INDEX_FILE': str(private)}
        git.run('read-tree', '--empty', env=env)
        git.run('update-index', '-z', '--index-info', data=b''.join(initial_entries), env=env)
        tree = git.run('write-tree', env=env).decode().strip()
        baseline = git.run('commit-tree', tree, data=b'AWU initial project baseline\n').decode().strip()
        # 建立主索引但不 checkout：源文件字节不变，未选择的暂存文件也不丢失。
        if index.exists():
            merged.write_bytes(index.read_bytes())
        else:
            git.run('read-tree', '--empty', env={'GIT_INDEX_FILE': str(merged)})
        git.run('update-index', '-z', '--index-info', data=b''.join(initial_entries), env={'GIT_INDEX_FILE': str(merged)})
        check = git.inspect_for_copy()
        if (check['dirty'] != expected['dirty'] or check['initialSkillFiles'] != expected['initialSkillFiles']
                or check['branch'] != expected['branch'] or _index_fingerprint(repo) != expected['initialization']['indexFingerprint']):
            raise CollaborationError('首次提交期间项目已变化，未更新主分支；请重新检查')
        git.run('update-ref', 'refs/heads/' + repo['branch'], baseline, '0' * len(baseline))
        os.replace(merged, lock)
        os.replace(lock, index)
        return git.inspect()
    finally:
        private.unlink(missing_ok=True)
        merged.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)

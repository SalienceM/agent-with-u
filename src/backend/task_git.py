"""托管任务的 Git 边界。所有命令是固定 argv，快照只使用私有索引。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import uuid
from typing import Any

from .deepseek_harness_state import reject_links
from .session_collaboration_store import CollaborationError, fingerprint
from .workspace_tools import relative_path

MAX_BYTES = 100 * 1024 * 1024
MAX_GIT_METADATA_ENTRIES = 20000
GIT_METADATA_TIMEOUT_SECONDS = 8
OID = re.compile(r'[0-9a-f]{40,64}')
SKILL_ROOTS = ('.agents/skills', '.claude/skills', '.qwen/skills')


def snapshot_path(name: str) -> None:
    relative_path(name)
    if Path(name).suffix.lower() in {'.pem', '.key', '.pfx', '.p12'} or any(part.lower() in {
            'credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519', 'id_ecdsa'} for part in Path(name).parts):
        raise CollaborationError('凭据路径不能进入副本')


def canonical_path(path: str | Path) -> str:
    target = Path(path)
    if not target.is_absolute():
        raise CollaborationError('项目目录必须是绝对路径')
    reject_links(target)
    return os.path.normcase(str(target.resolve()))


def _check_git_metadata(*roots: str) -> None:
    """目录边界逐层复核，条目只读不跟随链接的属性；不对每个对象重复遍历全部祖先。"""
    deadline = time.monotonic() + GIT_METADATA_TIMEOUT_SECONDS
    count = 0
    pending = list(reversed(dict.fromkeys(roots)))
    visited: set[str] = set()

    def check_deadline() -> None:
        if time.monotonic() > deadline:
            raise CollaborationError(
                f'Git 元数据检查超时（{GIT_METADATA_TIMEOUT_SECONDS} 秒，已检查 {count} 项）；'
                '请在磁盘负载降低后重新检查')

    while pending:
        check_deadline()
        folder = pending.pop()
        key = os.path.normcase(os.path.abspath(folder))
        # linked worktree 的 git-dir 通常已包含在 common-dir 中，不重复扫描/计数。
        if key in visited:
            continue
        try:
            try:
                reject_links(Path(folder))
            except ValueError as error:
                raise CollaborationError('Git 元数据包含符号链接或重解析点，不支持此仓库') from error
            with os.scandir(folder) as entries:
                for entry in entries:
                    check_deadline()
                    count += 1
                    if count > MAX_GIT_METADATA_ENTRIES:
                        raise CollaborationError(
                            f'Git 元数据条目超过检查上限（{MAX_GIT_METADATA_ENTRIES} 项）；'
                            '请检查仓库对象与 worktree 数量')
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                        raise CollaborationError('Git 元数据包含符号链接或重解析点，不支持此仓库')
                    if Path(folder).name == 'info' and entry.name in {'alternates', 'http-alternates'}:
                        raise CollaborationError('不支持外部 Git 对象库')
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(entry.path)
            visited.add(key)
        except OSError as error:
            raise CollaborationError('Git 元数据无法读取，请检查仓库目录权限后重新预览') from error
    check_deadline()


class TaskRepositoryUnavailable(CollaborationError):
    def __init__(self, reason: str, notice: str, preparation: str) -> None:
        super().__init__(notice)
        self.reason = reason
        self.preparation = preparation


class TaskGit:
    def __init__(self, root: str) -> None:
        self.root = canonical_path(root)
        self.executable = shutil.which('git')
        if not self.executable:
            raise TaskRepositoryUnavailable('git_missing', '执行设备尚未安装 Git', '安装 Git 后，可重新检查。')
        binary = Path(self.executable).resolve()
        if Path(self.root) in binary.parents or os.name == 'nt' and binary.suffix.lower() != '.exe':
            raise CollaborationError('Git 启动程序不可信')
        self.overrides: list[str] = []

    def run(self, *args: str, data: bytes | None = None, env: dict[str, str] | None = None,
            allowed: tuple[int, ...] = (0,), timeout: float = 30, lifecycle: Any = None) -> bytes:
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'}}
        environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
            GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1', GIT_LITERAL_PATHSPECS='1', GIT_OPTIONAL_LOCKS='0',
            GIT_AUTHOR_NAME='AWU Task', GIT_AUTHOR_EMAIL='task@agentwithu.local',
            GIT_COMMITTER_NAME='AWU Task', GIT_COMMITTER_EMAIL='task@agentwithu.local', LC_ALL='C')
        environment.update(env or {})
        argv = [self.executable, '--no-pager', '-c', 'core.fsmonitor=false', '-c', f'core.hooksPath={os.devnull}',
            '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
            '-c', 'submodule.recurse=false', '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false',
            *self.overrides, *args]
        try:
            with subprocess.Popen(argv, cwd=self.root, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
                try:
                    if lifecycle: lifecycle(process.pid, False)
                    stdout, stderr = process.communicate(input=data, timeout=timeout)
                except BaseException:
                    process.kill(); process.communicate()
                    raise
                finally:
                    if lifecycle and process.returncode is not None: lifecycle(process.pid, True)
                result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired as error:
            raise CollaborationError('Git 操作超时，保留登记与目录；请核对原请求') from error
        if len(result.stdout) > MAX_BYTES:
            raise CollaborationError('Git 输出超过范围')
        if result.returncode not in allowed:
            raise CollaborationError(result.stderr.decode('utf-8', errors='replace')[:2000] or 'Git 操作失败')
        return result.stdout

    def merge(self, head: str, *, fast_forward: bool = False, lifecycle: Any = None) -> None:
        if not OID.fullmatch(head): raise CollaborationError('候选提交无效')
        self.disable_filters()
        drivers = self.run('config', '--get-regexp', '^merge[.].*[.]driver$', allowed=(0, 1))
        if drivers: raise CollaborationError('仓库配置了外部 merge driver，请先显式处理；未执行仓库脚本')
        self.run('merge', '--ff-only' if fast_forward else '--no-ff', '--no-edit', '--no-stat', '--no-overwrite-ignore', head,
                 allowed=(0,) if fast_forward else (0, 1), timeout=60, lifecycle=lifecycle)

    def disable_filters(self) -> None:
        # worktree checkout 不能运行源仓库配置中的 smudge/process 脚本。
        keys = self.run('config', '--local', '--name-only', '--get-regexp', '^filter[.]', allowed=(0, 1)).decode().splitlines()
        names = {key.rsplit('.', 1)[0] for key in keys}
        if len(names) > 100:
            raise CollaborationError('Git 过滤器配置超过范围')
        self.overrides = [value for name in names for prop in ('smudge=', 'clean=', 'process=', 'required=false')
                          for value in ('-c', name + '.' + prop)]

    def repository(self) -> dict[str, Any]:
        try:
            root = canonical_path(self.run('rev-parse', '--show-toplevel').decode('utf-8').strip())
        except CollaborationError as error:
            if 'not a git repository' in str(error).lower():
                raise TaskRepositoryUnavailable('not_git', '当前项目尚未启用 Git',
                    '分支副本需要 Git。启用 Git 并完成首次提交后，即可创建。') from error
            raise
        if root != self.root:
            raise CollaborationError('请选择 Git 仓库根目录：' + root)
        common_value = Path(self.run('rev-parse', '--git-common-dir').decode('utf-8').strip())
        common = canonical_path(common_value if common_value.is_absolute() else Path(self.root) / common_value)
        git_dir = canonical_path(self.run('rev-parse', '--absolute-git-dir').decode('utf-8').strip())
        _check_git_metadata(common, git_dir)
        head = self.run('rev-parse', '--verify', '--quiet', 'HEAD^{commit}', allowed=(0, 1)).decode().strip()
        if not head and not self.run('rev-parse', '--verify', '--quiet', 'HEAD', allowed=(0, 1)).strip():
            raise TaskRepositoryUnavailable('no_commits', '当前项目还没有 Git 提交', '完成首次提交后，即可创建分支副本。')
        if not OID.fullmatch(head):
            raise CollaborationError('没有可用基线提交，请先明确准备仓库')
        branch = self.run('symbolic-ref', '--quiet', '--short', 'HEAD', allowed=(0, 1)).decode('utf-8').strip()
        stat = Path(common).stat()
        return {'root': root, 'commonDir': common, 'gitDir': git_dir, 'head': head, 'branch': branch,
                'repositoryId': fingerprint([common, stat.st_dev, stat.st_ino])}

    def dirty(self) -> list[dict]:
        tokens = self.run('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none').split(b'\0')
        names: dict[str, str] = {}; index = 0
        while index < len(tokens) and tokens[index]:
            token = tokens[index]; index += 1
            status = token[:2].decode('ascii'); name = token[3:].decode('utf-8', errors='strict')
            names[name] = status
            if 'R' in status or 'C' in status:
                names[tokens[index].decode('utf-8')] = 'D'; index += 1
            if len(names) > 500:
                raise CollaborationError('未提交路径超过500项，请缩小项目范围或先提交')
        rows = []; total = 0
        for name, status in sorted(names.items()):
            blocked = ''; digest = ''; size = 0
            try:
                snapshot_path(name)
                path = Path(self.root) / name; reject_links(path)
                if path.is_dir(): raise CollaborationError('目录或子模块不能进入文件快照')
                if path.exists():
                    size = path.stat().st_size; total += size
                    if size > 20 * 1024 * 1024 or total > MAX_BYTES: raise CollaborationError('文件超过快照大小限制')
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except (ValueError, OSError) as error:
                blocked = str(error)[:200]
            rows.append({'path': name, 'status': status, 'sha256': digest, 'bytes': size, 'blocked': blocked})
        return rows

    def inspect(self) -> dict:
        repo = self.repository()
        self.disable_filters()
        dirty = self.dirty()
        self.run('worktree', 'list', '--porcelain')
        view = {**repo, 'dirty': dirty}
        view['fingerprint'] = fingerprint(view)
        return view

    def skill_files(self) -> list[dict]:
        """忽略的项目 Skill 另行复制，不强制提交到分支或借用父目录。"""
        for name in SKILL_ROOTS:
            reject_links(Path(self.root) / name)
        names = self.run('ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', *SKILL_ROOTS).split(b'\0')
        rows = []; total = 0
        for raw in sorted(item for item in names if item):
            name = raw.decode('utf-8'); snapshot_path(name)
            if not any(name.startswith(root + '/') for root in SKILL_ROOTS):
                raise CollaborationError('Skill 路径越界')
            path = Path(self.root) / name; reject_links(path)
            if not path.is_file(): raise CollaborationError('Skill 副本只支持普通文件：' + name)
            size = path.stat().st_size; total += size
            if len(rows) >= 10000 or size > 20 * 1024 * 1024 or total > MAX_BYTES:
                raise CollaborationError('项目 Skills 超过副本范围（10000文件/100MiB/单文件20MiB）')
            rows.append({'path': name, 'bytes': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        return rows

    def copy_skills(self, expected: list[dict], root: Path) -> None:
        if self.skill_files() != expected:
            raise CollaborationError('项目 Skills 已变化，请重新预览；保留已创建目录')
        for row in expected:
            name = row['path']; snapshot_path(name)
            source, target = Path(self.root) / name, root / name
            reject_links(source); reject_links(target)
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != row['sha256']:
                raise CollaborationError('Skill 文件已变化：' + name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(data)
            shutil.copymode(source, target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != row['sha256']:
                raise CollaborationError('Skill 副本校验失败：' + name)
        if self.skill_files() != expected:
            raise CollaborationError('复制期间项目 Skills 变化；保留目录待核对')

    def snapshot(self, expected: dict, selected: list[str], scratch: Path) -> str:
        if self.inspect()['fingerprint'] != expected['fingerprint']:
            raise CollaborationError('源目录或提交已变化，请重新预览')
        if not selected: return expected['head']
        if len(selected) > 500 or len(set(selected)) != len(selected):
            raise CollaborationError('快照最多500条不同路径')
        rows = {row['path']: row for row in expected['dirty']}
        for name in selected:
            relative_path(name)
            if name not in rows or rows[name]['blocked']:
                raise CollaborationError('所选路径不可快照：' + name)
            if self.run('check-ignore', '--', name, allowed=(0, 1), env={'GIT_LITERAL_PATHSPECS': '0'}):
                raise CollaborationError('忽略路径不能进入任务快照：' + name)
        scratch.mkdir(parents=True, exist_ok=True); reject_links(scratch)
        private_index = scratch / ('index-' + uuid.uuid4().hex)
        environment = {'GIT_INDEX_FILE': str(private_index)}
        try:
            self.run('read-tree', expected['head'], env=environment)
            for name in selected:
                path = Path(self.root) / name; reject_links(path)
                if not path.exists():
                    self.run('update-index', '--force-remove', '--', name, env=environment); continue
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != rows[name]['sha256']:
                    raise CollaborationError('快照文件已变化：' + name)
                blob = self.run('hash-object', '-w', '--stdin', data=data).decode().strip()
                entry = self.run('ls-files', '-s', '--', name).decode()
                mode = entry[:6] if entry else '100644'
                if mode not in {'100644', '100755'}:
                    raise CollaborationError('只支持普通文件快照')
                self.run('update-index', '--add', '--cacheinfo', mode, blob, name, env=environment)
            tree = self.run('write-tree', env=environment).decode().strip()
            if self.inspect()['fingerprint'] != expected['fingerprint']:
                raise CollaborationError('快照期间源目录变化，未创建任务')
            return self.run('commit-tree', tree, '-p', expected['head'], data=b'AWU selected-path task baseline\n').decode().strip()
        finally:
            # 只删除本次生成的私有索引；绝不触碰主索引。
            private_index.unlink(missing_ok=True)

    def create(self, expected: dict, root: Path, branch: str, selected: list[str], scratch: Path,
               skill_files: list[dict] | None = None) -> dict:
        if root.exists(): raise CollaborationError('任务目录已存在，保留原输出；未认领或覆盖')
        reject_links(root)
        self.run('check-ref-format', '--branch', branch)
        if self.run('show-ref', '--verify', '--hash', 'refs/heads/' + branch, allowed=(0, 1, 128)):
            raise CollaborationError('任务分支已存在，未覆盖')
        if skill_files is not None and self.skill_files() != skill_files:
            raise CollaborationError('项目 Skills 已变化，请重新预览')
        baseline = self.snapshot(expected, selected, scratch)
        root.parent.mkdir(parents=True, exist_ok=True)
        self.run('worktree', 'add', '-b', branch, str(root), baseline, timeout=60)
        if skill_files is not None:
            self.copy_skills(skill_files, root)
        actual = TaskGit(str(root)).inspect()
        if actual['head'] != baseline or actual['commonDir'] != expected['commonDir'] or actual['branch'] != branch or actual['dirty']:
            raise CollaborationError('任务 worktree 核验未通过；保留目录等待核对')
        return {**actual, 'baseline': baseline, 'copiedSkillFiles': len(skill_files or [])}

"""将已捕获的本机构建转为安装输入，不读取发布源或扫描最新安装包。"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def local_build_manifest(receipt: dict[str, Any], project: Path) -> dict[str, Any]:
    candidate = receipt.get('candidate') or {}
    if receipt.get('schemaVersion') != 1 or not receipt.get('runId') or not receipt.get('stepId'):
        raise ValueError('缺少本次构建回执')
    root = Path(str(candidate.get('projectRoot') or ''))
    if not root.is_absolute() or str(root).startswith(('\\\\', '//')) or root.resolve() != project.resolve():
        raise ValueError('本机构建项目必须是执行设备上的真实本地目录')
    artifacts = candidate.get('artifacts')
    if not isinstance(artifacts, list) or not artifacts or len(artifacts) > 100:
        raise ValueError('本次构建制品清单无效')
    release = {key: candidate.get(key) for key in ('version', 'packageVersion', 'buildId', 'sequence', 'kitUpdateProtocol')}
    if (not all(isinstance(release[key], str) and release[key].strip() for key in ('version', 'packageVersion', 'buildId'))
            or type(release['sequence']) is not int or release['sequence'] <= 0):
        raise ValueError('本次构建缺少完整版本标识')
    result = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ValueError('本次构建制品记录无效')
        path = Path(str(artifact.get('path') or ''))
        if not path.is_absolute() or str(path).startswith(('\\\\', '//')) or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('本机构建安装包路径越界或不是本地文件')
        if not path.is_file():
            raise ValueError('本次构建安装包不存在')
        # 在读取字节前拒绝符号链接/junction，不能借本机构建把输入换到其他位置。
        for part in (path, *path.parents):
            if part.is_symlink() or getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
                raise ValueError('本机构建安装包路径不能包含链接或重解析点')
        result.append({key: artifact[key] for key in
                       ('id', 'platform', 'arch', 'target', 'kind', 'fileName', 'size', 'sha256', 'install') if key in artifact})
        result[-1]['url'] = str(path.resolve())
    return {'schemaVersion': 1, 'channel': 'local', 'release': release, 'artifacts': result}

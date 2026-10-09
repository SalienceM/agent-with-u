"""固定提供器配置。只读规划，不自动安装、执行版本命令或发现其他节点运行时。"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from .engine_workbench import WorkbenchError, WorkspaceIdentity
from .language_tools import asset

VERSIONS = {'pyright': '1.1.400', 'typescript-language-server': '4.3.3', 'typescript': '5.7.3',
            '@vue/language-server': '2.2.12', '@vue/typescript-plugin': '2.2.12', 'prettier': '3.5.3'}
FIELDS = {'provider', 'nodePath', 'toolsHome', 'typescriptHome', 'pythonPath', 'ruffPath',
          'javaPath', 'projectJdk', 'jdtHome', 'gradleHome', 'mavenRepository', 'mavenImport', 'gradleImport'}


def location(value: Any, *, directory: bool = False) -> Path:
    if not isinstance(value, str) or len(value) > 4096 or '\0' in value or not Path(value).is_absolute():
        raise WorkbenchError('language_runtime_path_required')
    try:
        path = Path(value).resolve(strict=True)
    except OSError as error:
        raise WorkbenchError('language_dependency_missing') from error
    if not (path.is_dir() if directory else path.is_file()):
        raise WorkbenchError('language_dependency_missing')
    return path


def package(root: Path, name: str) -> Path:
    path = root / name
    manifest = path / 'package.json'
    if not manifest.is_file() or manifest.stat().st_size > 256 * 1024:
        raise WorkbenchError('language_dependency_missing')
    value = json.loads(manifest.read_text(encoding='utf-8'))
    if value.get('version') != VERSIONS[name]:
        raise WorkbenchError('language_dependency_version_mismatch')
    return path.resolve()


@dataclass(frozen=True)
class ProviderPlan:
    workspace: WorkspaceIdentity
    config: dict[str, Any]
    argv: list[str]
    options: dict[str, Any]
    settings: dict[str, Any]
    formatter: dict[str, Any]
    fingerprint: str
    dependencies: dict[str, Any]

    def public(self) -> dict[str, Any]:
        return {'status': 'planned', 'workspace': self.workspace.to_dict(), 'provider': self.config['provider'],
                'planFingerprint': self.fingerprint, 'config': self.config, 'dependencies': self.dependencies,
                'effects': {'projectCode': True, 'workspaceWrite': True, 'automaticDownloads': False,
                    'buildImport': bool(self.config.get('mavenImport') or self.config.get('gradleImport'))},
                'notice': '使用执行节点当前账户权限；提供器/解释器可能读取项目配置及写入项目或缓存。不是操作系统沙箱。'
                          '仅当前所选工作区和版本；禁止自动安装/提权/切换节点。Java 构建导入另需确认，配置为离线且禁用 wrapper。'}


def provider_plan(workspace: WorkspaceIdentity, config: Any) -> ProviderPlan:
    if not isinstance(config, dict) or set(config) - FIELDS or config.get('provider') not in ('java', 'python', 'react', 'vue'):
        raise WorkbenchError('language_config_invalid')
    name = config['provider']
    clean: dict[str, Any] = {'provider': name}
    options: dict[str, Any] = {}
    settings: dict[str, Any] = {}
    formatter: dict[str, Any] = {}
    dependencies: dict[str, Any] = {}
    def selected(key: str, directory: bool = False) -> Path:
        path = location(config.get(key), directory=directory)
        clean[key] = str(path)
        return path
    if name == 'java':
        java, jdk, jdt = selected('javaPath'), selected('projectJdk', True), selected('jdtHome', True)
        runtime_release = java.parent.parent / 'release'
        if not runtime_release.is_file() or runtime_release.stat().st_size > 65536 or not re.search(
                r'JAVA_VERSION="21(?:[.\-"]|$)', runtime_release.read_text(encoding='utf-8')):
            raise WorkbenchError('java_runtime_requires_jdk21')
        release = jdk / 'release'
        if not release.is_file() or release.stat().st_size > 65536:
            raise WorkbenchError('java_project_jdk_unverified')
        launchers = list((jdt / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))
        cores = list((jdt / 'plugins').glob('org.eclipse.jdt.ls.core_1.42.0.*.jar'))
        if len(launchers) != 1 or len(cores) != 1:
            raise WorkbenchError('language_dependency_version_mismatch')
        shared = jdt / ('config_win' if os.name == 'nt' else 'config_linux')
        if not shared.is_dir():
            raise WorkbenchError('language_platform_unsupported')
        for field in ('mavenImport', 'gradleImport'):
            if type(config.get(field, False)) is not bool:
                raise WorkbenchError('language_config_invalid')
            clean[field] = config.get(field, False)
        gradle = str(selected('gradleHome', True)) if clean['gradleImport'] else None
        maven_repository = str(selected('mavenRepository', True)) if clean['mavenImport'] else None
        settings = {'java': {'home': str(jdk), 'autobuild': {'enabled': False},
            'configuration': {'updateBuildConfiguration': 'automatic' if clean['mavenImport'] or clean['gradleImport'] else 'disabled'},
            'import': {'maven': {'enabled': clean['mavenImport'], 'offline': {'enabled': True}},
                'gradle': {'enabled': clean['gradleImport'], 'home': gradle, 'java': {'home': str(jdk)},
                    'offline': {'enabled': True}, 'wrapper': {'enabled': False}}},
            'maven': {'downloadSources': False}, 'references': {'includeDecompiledSources': False}}}
        bundle = asset('awu-jdt-diagnostics.jar')
        if not bundle.is_file() or bundle.stat().st_size > 1024 * 1024:
            raise WorkbenchError('java_versioned_diagnostics_bundle_missing')
        dependencies['awuJavaDiagnostics'] = hashlib.sha256(bundle.read_bytes()).hexdigest()
        options = {'settings': settings, 'bundles': [str(bundle)]}
        # 数据目录/配置目录在明确启动后由管理器追加，规划本身不写磁盘。
        argv = [str(java), '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
            '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dosgi.checkConfiguration=true',
            '-Dosgi.configuration.cascaded=true', '-Dosgi.sharedConfiguration.area=' + str(shared),
            '-Dosgi.sharedConfiguration.area.readOnly=true', '-Xmx1G', '--add-modules=ALL-SYSTEM',
            '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
            '-jar', str(launchers[0])]
        if maven_repository:
            argv.insert(1, '-Dmaven.repo.local=' + maven_repository)
        formatter = {'kind': 'lsp'}
        dependencies['jdtls'] = '1.42.0'
    else:
        node, root = selected('nodePath'), selected('toolsHome', True)
        if name == 'python':
            pyright = package(root, 'pyright')
            python, ruff = selected('pythonPath'), selected('ruffPath')
            argv = [str(node), '--max-old-space-size=768', str(pyright / 'langserver.index.js'), '--stdio']
            settings = {'python': {'pythonPath': str(python), 'analysis': {'typeCheckingMode': 'basic',
                        'autoSearchPaths': True, 'diagnosticMode': 'openFilesOnly', 'autoImportCompletions': True}}}
            formatter = {'kind': 'ruff', 'argv': [str(ruff), 'format', '--isolated', '--stdin-filename']}
            dependencies.update(pyright=VERSIONS['pyright'], ruff='0.11.13 (启动时核对)')
        else:
            ts = selected('typescriptHome', True)
            # TypeScript 来自用户所选项目环境，不自动回退控制端或提供器附带版本。
            verified_ts = package(ts.parent, 'typescript')
            if verified_ts != ts or not (ts / 'lib/tsserver.js').is_file():
                raise WorkbenchError('project_typescript_unavailable')
            prettier = package(root, 'prettier')
            formatter = {'kind': 'prettier', 'argv': [str(node), str(prettier / 'bin/prettier.cjs')]}
            if name == 'react':
                provider = package(root, 'typescript-language-server')
                argv = [str(node), '--max-old-space-size=768', str(provider / 'lib/cli.mjs'), '--stdio']
                options = {'tsserver': {'path': str(ts / 'lib/tsserver.js')}, 'disableAutomaticTypingAcquisition': True,
                           'plugins': [], 'preferences': {'includeCompletionsForModuleExports': True}}
                dependencies['typescript-language-server'] = VERSIONS['typescript-language-server']
                adapter = asset('typescript-diagnostics.cjs')
                if not adapter.is_file() or adapter.stat().st_size > 65536:
                    raise WorkbenchError('typescript_diagnostics_adapter_missing')
                dependencies['awuTypeScriptDiagnostics'] = hashlib.sha256(adapter.read_bytes()).hexdigest()
            else:
                provider = package(root, '@vue/language-server'); package(root, '@vue/typescript-plugin')
                argv = [str(node), '--max-old-space-size=768', str(provider / 'bin/vue-language-server.js'), '--stdio']
                options = {'typescript': {'tsdk': str(ts / 'lib')}, 'vue': {'hybridMode': False}}
                dependencies['vue'] = VERSIONS['@vue/language-server']
            dependencies.update(typescript=VERSIONS['typescript'], prettier=VERSIONS['prettier'])
    # 重新预检会捕获所选运行时/入口文件被替换；不把凭模型提供的指纹当授权。
    stamps = []
    runtime_files = argv + formatter.get('argv', []) + [str(v) for k, v in clean.items() if k.endswith('Path')]
    for argument in runtime_files:
        path = Path(argument)
        if path.is_absolute() and path.is_file():
            stat = path.stat(); stamps.append([str(path), stat.st_size, stat.st_mtime_ns, stat.st_ino])
    fingerprint = hashlib.sha256(json.dumps([workspace.to_dict(), clean, dependencies, stamps], sort_keys=True).encode()).hexdigest()
    return ProviderPlan(workspace, clean, argv, options, settings, formatter, fingerprint, dependencies)

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files
from PyInstaller.utils.hooks import collect_all
import sys
from pathlib import Path
sys.path.insert(0, str(Path(SPECPATH)))
from scripts.harness_pyinstaller import collect as collect_harness
from scripts.package_policy import FROZEN_EXCLUDES, validate_analysis
from src.package_readiness import SCHEDULE_MODULES

datas = [('tools/engine-providers/awu-jdt-diagnostics.jar', 'engine-providers'), ('tools/engine-providers/typescript-diagnostics.cjs', 'engine-providers')]
binaries = []
hiddenimports = ['websockets', 'PIL.Image', 'httpx', 'claude_agent_sdk', 'qwen_code_sdk', 'anthropic', 'dashscope', 'edge_tts', 'yaml', 'pydantic_core', 'mcp', 'pathspec', 'tomli']
_hdata, _hbinary, _himports = collect_harness()
datas += _hdata; binaries += _hbinary; hiddenimports += _himports
datas += collect_data_files('certifi')
datas += collect_data_files('tzdata')
hiddenimports += ['tzdata', 'zoneinfo']
hiddenimports += list(SCHEDULE_MODULES)
tmp_ret = collect_all('pydantic_core')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('dashscope')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('edge_tts')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('pathspec')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
if sys.platform == 'win32':
    tmp_ret = collect_all('winpty')
    datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['ws_main_entry.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=list(FROZEN_EXCLUDES),
    noarchive=False,
    optimize=0,
)
validate_analysis(a)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='agent-with-u-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

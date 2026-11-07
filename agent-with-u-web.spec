# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_data_files
import sys
from pathlib import Path
sys.path.insert(0, str(Path(SPECPATH)))
from src.package_readiness import MODULES, RESOURCES, SCHEDULE_MODULES
from scripts.harness_pyinstaller import collect as collect_harness
from scripts.package_policy import FROZEN_EXCLUDES, validate_analysis

datas = [("frontend/dist", "frontend_dist")]
datas += [("tools/engine-providers/" + name, "engine-providers") for name in RESOURCES]
binaries = []
_hdata, _hbinary, _himports = collect_harness()
datas += _hdata
binaries += _hbinary
hiddenimports = [
    "websockets", "PIL", "claude_agent_sdk", "certifi", "pydantic", "mcp", "dashscope", "edge_tts",
]
datas += collect_data_files("certifi")
datas += collect_data_files('tzdata')
hiddenimports += ['tzdata', 'zoneinfo']
hiddenimports += list(MODULES)
hiddenimports += list(SCHEDULE_MODULES)
hiddenimports += _himports
if sys.version_info < (3, 11):
    hiddenimports += ['tomli']
_data, _binary, _imports = collect_all('pathspec')
datas += _data; binaries += _binary; hiddenimports += _imports
tmp_ret = collect_all("pydantic_core")
if sys.platform == 'win32':
    _data, _binary, _imports = collect_all('winpty')
    datas += _data; binaries += _binary; hiddenimports += _imports
elif sys.platform.startswith('linux'):
    hiddenimports += ['fcntl', 'termios', '_ctypes', '_posixsubprocess']
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all("dashscope")
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all("edge_tts")
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

a = Analysis(
    ["web_main_entry.py"],
    pathex=[], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=list(FROZEN_EXCLUDES), noarchive=False, optimize=0,
)
validate_analysis(a)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="agent-with-u-web", debug=False, bootloader_ignore_signals=False,
    strip=False, upx=True, upx_exclude=[], runtime_tmpdir=None, console=True,
    disable_windowed_traceback=False, argv_emulation=False, target_arch=None,
    codesign_identity=None, entitlements_file=None,
)

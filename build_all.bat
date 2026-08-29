@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Build All - AgentWithU
cd /d "%~dp0"
echo.
echo  ============================================
echo   AgentWithU -- Full Build Script
echo  ============================================
echo.
::  Python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ and add to PATH.
    pause & exit /b 1
)
for /f "tokens=*" %%V in ('python --version 2^>^&1') do echo [OK] %%V
::  pip dependencies
echo.
echo [CHECK] Python dependencies...
python -c "import websockets, PIL, httpx, edge_tts; from dashscope.audio.tts_v2 import SpeechSynthesizer; from importlib.metadata import version; assert tuple(int(x) for x in version('dashscope').split('.')[:3]) >= (1,26,3)" >nul 2>&1
if not errorlevel 1 goto deps_ok
echo [INSTALL] Installing Python deps (Tsinghua mirror)...
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
if errorlevel 1 ( echo [ERROR] pip install failed & pause & exit /b 1 )
:deps_ok
echo [OK] Python deps ready
::  PyInstaller
echo.
echo [CHECK] PyInstaller...
python -m PyInstaller --version >nul 2>&1
if not errorlevel 1 goto pyinst_ok
echo [INSTALL] Installing PyInstaller...
python -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
if errorlevel 1 ( echo [ERROR] PyInstaller install failed & pause & exit /b 1 )
:pyinst_ok
echo [OK] PyInstaller ready
::  Node / npm
echo.
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js / npm not found. Install Node.js 18+ from https://nodejs.org/
    pause & exit /b 1
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo [OK] Node %%V
::  Root node_modules (includes @tauri-apps/cli)
:: Re-install when package.json is newer than node_modules — otherwise newly
:: added deps stay missing on machines where node_modules pre-dated the change.
:: NOTE: the powershell check must live outside an `if (...)` block — cmd
:: counts the `)` chars inside the PS command and prematurely closes the block.
set "ROOT_NEEDS_INSTALL=0"
if not exist "node_modules\.bin\tauri.cmd" set "ROOT_NEEDS_INSTALL=1"
if not exist "node_modules\.package-lock.json" set "ROOT_NEEDS_INSTALL=1"
if "!ROOT_NEEDS_INSTALL!"=="1" goto root_check_done
for /f %%i in ('powershell -NoProfile -Command "$pkg=(Get-Item 'package.json').LastWriteTime; $lock=if(Test-Path 'package-lock.json'){(Get-Item 'package-lock.json').LastWriteTime}else{$pkg}; $marker=(Get-Item 'node_modules/.package-lock.json').LastWriteTime; if($pkg -gt $marker -or $lock -gt $marker){'1'}else{'0'}"') do set "ROOT_NEEDS_INSTALL=%%i"
:root_check_done
if "!ROOT_NEEDS_INSTALL!"=="0" goto root_install_done
echo [INSTALL] Installing root dependencies (npmmirror)...
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )
:root_install_done
echo [OK] Tauri CLI ready
::  Frontend node_modules
set "FRONTEND_NEEDS_INSTALL=0"
if not exist "frontend\node_modules" set "FRONTEND_NEEDS_INSTALL=1"
if not exist "frontend\node_modules\.package-lock.json" set "FRONTEND_NEEDS_INSTALL=1"
if "!FRONTEND_NEEDS_INSTALL!"=="1" goto frontend_check_done
for /f %%i in ('powershell -NoProfile -Command "$pkg=(Get-Item 'frontend/package.json').LastWriteTime; $lock=if(Test-Path 'frontend/package-lock.json'){(Get-Item 'frontend/package-lock.json').LastWriteTime}else{$pkg}; $marker=(Get-Item 'frontend/node_modules/.package-lock.json').LastWriteTime; if($pkg -gt $marker -or $lock -gt $marker){'1'}else{'0'}"') do set "FRONTEND_NEEDS_INSTALL=%%i"
:frontend_check_done
if "!FRONTEND_NEEDS_INSTALL!"=="0" goto frontend_install_done
echo [INSTALL] Installing frontend dependencies (npmmirror)...
pushd frontend
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 ( popd & echo [ERROR] npm install failed & pause & exit /b 1 )
popd
:frontend_install_done
echo [OK] Frontend deps ready
::  Rust / rustc
echo.
where rustc >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Rust toolchain not found. Install from https://rustup.rs
    pause & exit /b 1
)
for /f "tokens=*" %%V in ('rustc --version 2^>^&1') do echo [OK] %%V
echo.
echo  -- Environment OK, starting build --
echo.
:: Same-day builds need distinct versions.  The stamper keeps Tauri/MSI's
:: three numeric fields while exposing YY.M.D.HHMMSS to users and manifests.
for /f "delims=" %%a in ('python scripts\stamp_version.py --field displayVersion') do set "DISPLAY_VERSION=%%a"
if errorlevel 1 ( echo [ERROR] Version stamping failed & pause & exit /b 1 )
for /f "delims=" %%a in ('python -c "import json; print(json.load(open('src-tauri/tauri.conf.json',encoding='utf-8-sig')).get('version','unknown'))"') do set "PACKAGE_VERSION=%%a"
echo [OK] Build version !DISPLAY_VERSION! ^(package !PACKAGE_VERSION!^)
:: ============================================================
:: Step 1: PyInstaller - package Python sidecar
:: ============================================================
echo [1/3] Building Python sidecar...
echo.
:: Clean dist directory to force rebuild
echo [CLEAN] Removing old dist folder...
rmdir /s /q "dist" 2>nul
echo [CLEAN] Removing old build folder...
rmdir /s /q "build" 2>nul
python -m PyInstaller --name "agent-with-u-backend" --onefile --console --hidden-import websockets --hidden-import PIL --hidden-import claude_agent_sdk --hidden-import certifi --collect-data certifi --collect-all pydantic_core --hidden-import pydantic --hidden-import mcp --hidden-import dashscope --collect-all dashscope --collect-all edge_tts --noconfirm ws_main_entry.py
if errorlevel 1 ( echo [FAILED] PyInstaller build failed & pause & exit /b 1 )
:: ============================================================
:: Step 2: Copy sidecar to src-tauri/binaries/
:: ============================================================
echo.
echo [2/3] Copying sidecar to src-tauri\binaries\...
echo.
for /f "tokens=2" %%T in ('rustc -Vv ^| findstr /i "host"') do set TARGET_TRIPLE=%%T
if "%TARGET_TRIPLE%"=="" set TARGET_TRIPLE=x86_64-pc-windows-msvc
echo Target: %TARGET_TRIPLE%
if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"
copy /y "dist\agent-with-u-backend.exe" "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe"
if errorlevel 1 ( echo [FAILED] Copy sidecar failed & pause & exit /b 1 )
:: ============================================================
:: Step 3: Pre-download WiX to Tauri v2 cache path
:: ============================================================
set "WIX_CACHE=%LOCALAPPDATA%\tauri\WixTools314"
set "WIX_ZIP=%TEMP%\wix314-binaries.zip"
set "WIX_M1=https://mirror.ghproxy.com/https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
set "WIX_M2=https://ghproxy.net/https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
set "WIX_SRC=https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
if exist "%WIX_CACHE%\candle.exe" goto wix_ok
echo [WiX] Downloading to %WIX_CACHE% ...
if not exist "%WIX_CACHE%" mkdir "%WIX_CACHE%"
certutil -urlcache -split -f "%WIX_M1%" "%WIX_ZIP%" >nul 2>&1
if not exist "%WIX_ZIP%" ( echo [WiX] mirror1 failed, trying mirror2... & certutil -urlcache -split -f "%WIX_M2%" "%WIX_ZIP%" >nul 2>&1 )
if not exist "%WIX_ZIP%" ( echo [WiX] trying GitHub directly... & certutil -urlcache -split -f "%WIX_SRC%" "%WIX_ZIP%" >nul 2>&1 )
if exist "%WIX_ZIP%" ( powershell -NoProfile -Command "Expand-Archive -Path '%WIX_ZIP%' -DestinationPath '%WIX_CACHE%' -Force" & del "%WIX_ZIP%" >nul 2>&1 )
if exist "%WIX_CACHE%\candle.exe" ( echo [OK] WiX ready ) else ( echo [WARN] WiX pre-download failed - Tauri will try GitHub )
:wix_ok
:: ============================================================
:: Step 4: Tauri build
:: ============================================================
echo.
echo [3/3] Tauri build (includes frontend build)...
echo.
:: 限制 Rust 并行编译数，防止内存不足导致 OOM
if not defined CARGO_BUILD_JOBS (
    set "CARGO_BUILD_JOBS=2"
    echo [INFO] Set CARGO_BUILD_JOBS=2 to reduce memory usage
)
:: Clean previous Tauri build artifacts to ensure fresh build
echo [CLEAN] Removing old Tauri build artifacts...
rmdir /s /q "src-tauri\target\release\bundle" 2>nul
echo [CLEAN] Removing old target/release build...
del /q "src-tauri\target\release\agent-with-u.exe" 2>nul
del /q "src-tauri\target\release\agent-with-u-backend.exe" 2>nul
if defined LOCAL_PROXY ( set "HTTPS_PROXY=%LOCAL_PROXY%" & echo [Proxy] %LOCAL_PROXY% )
call npm run build
if errorlevel 1 ( echo [FAILED] Tauri build failed & pause & exit /b 1 )
:: When Docker Desktop is available, produce the Linux Docker image bundle in
:: the same version group.  Set AGENT_WITH_U_SKIP_DOCKER_RELEASE=1 to skip it.
if "%AGENT_WITH_U_SKIP_DOCKER_RELEASE%"=="1" goto docker_release_done
where docker >nul 2>&1
if errorlevel 1 goto docker_release_unavailable
docker info >nul 2>&1
if errorlevel 1 goto docker_release_unavailable
call deploy\build-docker-release.bat --reuse-version
if errorlevel 1 echo [WARN] Windows package succeeded, but Docker release bundle failed.
goto docker_release_done
:docker_release_unavailable
echo [INFO] Docker engine unavailable; skipped optional Docker online-update bundle.
:docker_release_done
python scripts\register_release_candidate.py --project-root "%CD%" --source build_all
if errorlevel 1 echo [WARN] Build succeeded, but release candidate registration failed. You can rescan in Release Center.
echo.
echo  ============================================
echo   Done! Installer is at:
echo   src-tauri\target\release\bundle\
echo  ============================================
pause

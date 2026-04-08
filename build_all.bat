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
python -c "import websockets, PIL, httpx" >nul 2>&1
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
if exist "node_modules\.bin\tauri.cmd" goto tauri_ok
echo [INSTALL] Installing root dependencies (npmmirror)...
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )
:tauri_ok
echo [OK] Tauri CLI ready
::  Frontend node_modules
if exist "frontend\node_modules" goto frontend_deps_ok
echo [INSTALL] Installing frontend dependencies (npmmirror)...
pushd frontend
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 ( popd & echo [ERROR] npm install failed & pause & exit /b 1 )
popd
:frontend_deps_ok
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
:: Auto-increment version based on date (format: 0.1.YYYYMMDD)
for /f "tokens=2 delims=:" %%a in ('findstr /i "^  \"version\"" "src-tauri\tauri.conf.json"') do (
    set "CURRENT_VERSION=%%a"
)
set "CURRENT_VERSION=!CURRENT_VERSION:"=!"
set "CURRENT_VERSION=!CURRENT_VERSION: =!"
set "CURRENT_VERSION=!CURRENT_VERSION:,=!"
echo [INFO] Current version in config: !CURRENT_VERSION!
:: Use YY.MM.DD format: MSI requires MAJOR<=255, MINOR<=255, PATCH<=65535
:: e.g. 2026-03-23 → 26.3.23 (all components fit)
for /f %%a in ('powershell -NoProfile -Command "[int](Get-Date -Format yy)"') do set VER_YY=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).Month"') do set VER_MM=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).Day"') do set VER_DD=%%a
set "NEW_VERSION=!VER_YY!.!VER_MM!.!VER_DD!"
echo [INFO] New version will be: !NEW_VERSION!
:: Update version in tauri.conf.json using Python (avoids cmd pipe/quoting issues with PowerShell)
python -c "import json; f='src-tauri/tauri.conf.json'; d=json.load(open(f,encoding='utf-8')); d['version']='!NEW_VERSION!'; open(f,'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')"
if errorlevel 1 ( echo [WARN] Version update failed, continuing with current version )
echo [OK] Updated tauri.conf.json version to !NEW_VERSION!
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
python -m PyInstaller --name "agent-with-u-backend" --onefile --console --hidden-import websockets --hidden-import PIL --hidden-import claude_agent_sdk --noconfirm ws_main_entry.py
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
:: Clean previous Tauri build artifacts to ensure fresh build
echo [CLEAN] Removing old Tauri build artifacts...
rmdir /s /q "src-tauri\target\release\bundle" 2>nul
echo [CLEAN] Removing old target/release build...
del /q "src-tauri\target\release\agent-with-u.exe" 2>nul
del /q "src-tauri\target\release\agent-with-u-backend.exe" 2>nul
if defined LOCAL_PROXY ( set "HTTPS_PROXY=%LOCAL_PROXY%" & echo [Proxy] %LOCAL_PROXY% )
call npm run build
if errorlevel 1 ( echo [FAILED] Tauri build failed & pause & exit /b 1 )
echo.
echo  ============================================
echo   Done! Installer is at:
echo   src-tauri\target\release\bundle\
echo  ============================================
pause

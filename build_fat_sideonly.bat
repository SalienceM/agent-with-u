@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Build Fat Installer (Sidecar Only) - AgentWithU
cd /d "%~dp0"

echo.
echo  =============================================
echo   AgentWithU -- Fat Installer Build
echo   Sidecar Only - 只重新打包 Python 后端
echo   跳过 Tauri 前端编译，节省时间和内存
echo  =============================================
echo.

:: ── 版本号：sidecar-only 也是一次可识别发布 ────────────────────
for /f "delims=" %%a in ('python scripts\stamp_version.py --field displayVersion') do set "VERSION=%%a"
if errorlevel 1 ( echo [ERROR] Version stamping failed & pause & exit /b 1 )
echo [INFO] Version: !VERSION!

:: ============================================================
::  Step 0: 检查 Tauri 前端 exe 是否已存在
:: ============================================================
set "TAURI_EXE=src-tauri\target\release\agent-with-u.exe"
if not exist "!TAURI_EXE!" (
    echo [ERROR] Tauri 前端尚未构建: !TAURI_EXE!
    echo         请先运行 build_all.bat 完成至少一次完整构建。
    pause & exit /b 1
)
for %%F in ("!TAURI_EXE!") do echo [OK] Tauri exe exists (%%~tF, %%~zF bytes)

:: ============================================================
::  Step 1: 重新打包 Python sidecar (PyInstaller)
:: ============================================================
echo.
echo [STEP 1] Rebuilding Python sidecar ...

:: 检查 PyInstaller
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo [INSTALL] Installing PyInstaller...
    python -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
    if errorlevel 1 (
        echo [ERROR] PyInstaller install failed
        pause & exit /b 1
    )
)

:: 清理旧的 build 产物，确保干净重建
echo [CLEAN] Cleaning old build artifacts...
rmdir /s /q "build" 2>nul
rmdir /s /q "dist" 2>nul

echo [BUILD] Running PyInstaller ...
python -m PyInstaller --name "agent-with-u-backend" --onefile --console ^
    --hidden-import websockets ^
    --hidden-import PIL ^
    --hidden-import claude_agent_sdk ^
    --hidden-import certifi --collect-data certifi ^
    --collect-all pydantic_core ^
    --hidden-import pydantic --hidden-import mcp ^
    --hidden-import dashscope --collect-all dashscope ^
    --collect-all edge_tts ^
    --noconfirm ws_main_entry.py
if errorlevel 1 (
    echo [FAILED] PyInstaller build failed
    pause & exit /b 1
)

if not exist "dist\agent-with-u-backend.exe" (
    echo [ERROR] dist\agent-with-u-backend.exe not found after build
    pause & exit /b 1
)
for %%F in ("dist\agent-with-u-backend.exe") do echo [OK] Sidecar built: %%~zF bytes

:: 同步到 src-tauri\binaries（供后续 Tauri 构建使用）
for /f "tokens=2" %%T in ('rustc -Vv ^| findstr /i "host"') do set TARGET_TRIPLE=%%T
if "%TARGET_TRIPLE%"=="" set TARGET_TRIPLE=x86_64-pc-windows-msvc
if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"
copy /y "dist\agent-with-u-backend.exe" "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe" >nul
echo [OK] Sidecar synced to src-tauri\binaries\

:: ============================================================
::  Step 2: 准备 claude-env（与 build_fat.bat 相同）
:: ============================================================
set "CLAUDE_ENV=installer\claude-env"
echo.
echo [STEP 2] Preparing claude-env ...

:: ── 2a: Portable Node.js ──────────────────────
set "NODE_VER=v22.15.0"
set "NODE_ARCH=win-x64"
set "NODE_DIR=node-%NODE_VER%-%NODE_ARCH%"
set "NODE_ZIP=%TEMP%\%NODE_DIR%.zip"
set "NODE_URL=https://npmmirror.com/mirrors/node/%NODE_VER%/%NODE_DIR%.zip"
set "NODE_URL_OFFICIAL=https://nodejs.org/dist/%NODE_VER%/%NODE_DIR%.zip"

if exist "%CLAUDE_ENV%\node\node.exe" (
    echo [OK] Portable Node.js already exists, skipping download
    goto node_ready
)

if not exist "%CLAUDE_ENV%" mkdir "%CLAUDE_ENV%"
if not exist "%CLAUDE_ENV%\node" mkdir "%CLAUDE_ENV%\node"

echo [DOWNLOAD] Node.js %NODE_VER% ...
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { Invoke-WebRequest -Uri '%NODE_URL_OFFICIAL%' -OutFile '%NODE_ZIP%' -UseBasicParsing }"
if not exist "%NODE_ZIP%" (
    echo [ERROR] Node.js download failed
    pause & exit /b 1
)

echo [EXTRACT] Extracting Node.js ...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%TEMP%\node-extract' -Force"
xcopy /s /e /y /q "%TEMP%\node-extract\%NODE_DIR%\*" "%CLAUDE_ENV%\node\" >nul
rmdir /s /q "%TEMP%\node-extract" 2>nul
del "%NODE_ZIP%" 2>nul
echo [OK] Node.js %NODE_VER% ready

:node_ready

:: ── 2b: Claude Code ──────────────────────
set "NPM_PREFIX=%cd%\%CLAUDE_ENV%\npm-global"
set "NODE_EXE=%cd%\%CLAUDE_ENV%\node\node.exe"
set "NPM_CMD=%cd%\%CLAUDE_ENV%\node\npm.cmd"

if exist "%NPM_PREFIX%\node_modules\@anthropic-ai\claude-code" (
    echo [OK] Claude Code already installed, skipping
    goto claude_ready
)

echo [INSTALL] Installing @anthropic-ai/claude-code ...
if not exist "%NPM_PREFIX%" mkdir "%NPM_PREFIX%"
call "%NPM_CMD%" install -g @anthropic-ai/claude-code ^
    --prefix "%NPM_PREFIX%" ^
    --registry https://registry.npmmirror.com ^
    --no-optional
if errorlevel 1 (
    echo [WARN] npmmirror install failed, trying official registry...
    call "%NPM_CMD%" install -g @anthropic-ai/claude-code ^
        --prefix "%NPM_PREFIX%" ^
        --no-optional
)
if not exist "%NPM_PREFIX%\node_modules\@anthropic-ai\claude-code" (
    echo [ERROR] Claude Code install failed
    pause & exit /b 1
)
echo [OK] Claude Code installed

:claude_ready

:: ── 2c: 检测 CLI 入口并生成 claude.cmd ──────────────────────
set "CLAUDE_PKG=%cd%\%CLAUDE_ENV%\npm-global\node_modules\@anthropic-ai\claude-code"
set "CLAUDE_ENTRY="

:: ★ 优先选 JS 入口 —— 我们用 node 启动，绝不能选 .exe / 无后缀脚本
if exist "%CLAUDE_PKG%\cli.js" ( set "CLAUDE_ENTRY=cli.js"
) else if exist "%CLAUDE_PKG%\cli.cjs" ( set "CLAUDE_ENTRY=cli.cjs"
) else if exist "%CLAUDE_PKG%\cli-wrapper.cjs" ( set "CLAUDE_ENTRY=cli-wrapper.cjs"
)

if "!CLAUDE_ENTRY!"=="" (
    for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "try { $p=(Get-Content '%CLAUDE_PKG%\package.json' -Raw | ConvertFrom-Json).bin.claude; if($p){$p -replace '^\./',''}else{''}  } catch {''}"`) do (
        set "_CAND=%%a"
        echo !_CAND! | findstr /i /e ".js .cjs .mjs" >nul && set "CLAUDE_ENTRY=!_CAND!"
    )
)

set "CLAUDE_ENTRY_EXE="
if "!CLAUDE_ENTRY!"=="" (
    if exist "%CLAUDE_PKG%\bin\claude.exe" ( set "CLAUDE_ENTRY_EXE=bin\claude.exe"
    ) else if exist "%CLAUDE_PKG%\claude.exe" ( set "CLAUDE_ENTRY_EXE=claude.exe"
    )
)

if "!CLAUDE_ENTRY!"=="" if "!CLAUDE_ENTRY_EXE!"=="" (
    echo [ERROR] Cannot detect a JS or .exe entry point for claude-code in:
    echo         %CLAUDE_PKG%
    dir /b "%CLAUDE_PKG%" 2>nul
    pause & exit /b 1
)

if not "!CLAUDE_ENTRY!"=="" (
    echo [OK] Detected JS entry: !CLAUDE_ENTRY!
    echo [GEN] Creating claude.cmd wrapper ^(node + JS^) ...
    (
        echo @echo off
        echo setlocal
        echo set "SCRIPT_DIR=%%~dp0"
        echo set "NODE_EXE=%%SCRIPT_DIR%%node\node.exe"
        echo set "CLAUDE_MAIN=%%SCRIPT_DIR%%npm-global\node_modules\@anthropic-ai\claude-code\!CLAUDE_ENTRY!"
        echo "%%NODE_EXE%%" "%%CLAUDE_MAIN%%" %%*
    ) > "%CLAUDE_ENV%\claude.cmd"
) else (
    echo [OK] Detected SEA entry: !CLAUDE_ENTRY_EXE!
    echo [GEN] Creating claude.cmd wrapper ^(direct exec^) ...
    (
        echo @echo off
        echo setlocal
        echo set "SCRIPT_DIR=%%~dp0"
        echo set "CLAUDE_BIN=%%SCRIPT_DIR%%npm-global\node_modules\@anthropic-ai\claude-code\!CLAUDE_ENTRY_EXE!"
        echo "%%CLAUDE_BIN%%" %%*
    ) > "%CLAUDE_ENV%\claude.cmd"
)
echo [OK] claude.cmd created

:: ============================================================
::  Step 3: 收集产物到 staging
:: ============================================================
echo.
echo [STEP 3] Collecting build artifacts ...

set "STAGING=installer\_staging"
if exist "%STAGING%" rmdir /s /q "%STAGING%"
mkdir "%STAGING%"

:: Tauri 主程序（使用已有的，不重新编译）
copy /y "!TAURI_EXE!" "%STAGING%\AgentWithU.exe"
if errorlevel 1 (
    echo [ERROR] Failed to copy Tauri exe
    pause & exit /b 1
)

:: Python sidecar（刚重新打包的）
copy /y "dist\agent-with-u-backend.exe" "%STAGING%\agent-with-u-backend.exe"
if errorlevel 1 (
    echo [ERROR] Failed to copy sidecar
    pause & exit /b 1
)

:: WebView2Loader
copy /y "src-tauri\target\release\WebView2Loader.dll" "%STAGING%\" >nul 2>nul
echo [OK] Artifacts staged

:: ============================================================
::  Step 4: 验证 claude-env
:: ============================================================
echo.
echo [STEP 4] Verifying claude-env contents ...

set "CE_OK=1"
if not exist "%CLAUDE_ENV%\node\node.exe" (
    echo [ERROR] node.exe not found
    set "CE_OK=0"
)
if not exist "%CLAUDE_ENV%\npm-global\node_modules\@anthropic-ai\claude-code" (
    echo [ERROR] claude-code package not found
    set "CE_OK=0"
)
if not exist "%CLAUDE_ENV%\claude.cmd" (
    echo [ERROR] claude.cmd not found
    set "CE_OK=0"
)
if "!CE_OK!"=="0" (
    echo [FAILED] claude-env is incomplete
    pause & exit /b 1
)

for /f %%s in ('powershell -NoProfile -Command "(Get-ChildItem -Recurse '%CLAUDE_ENV%' | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do set CE_SIZE_MB=%%s
echo [OK] claude-env verified (approx !CE_SIZE_MB! MB)

:: ============================================================
::  Step 5: 编译 NSIS 安装包
:: ============================================================
echo.
echo [STEP 5] Compiling NSIS installer ...

set "MAKENSIS="
where makensis >nul 2>&1 && set "MAKENSIS=makensis"
if "!MAKENSIS!"=="" (
    for /f "delims=" %%F in ('dir /s /b "%LOCALAPPDATA%\tauri\makensis.exe" 2^>nul') do if "!MAKENSIS!"=="" set "MAKENSIS=%%F"
)
if "!MAKENSIS!"=="" if exist "C:\Program Files (x86)\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
if "!MAKENSIS!"=="" if exist "C:\Program Files\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files\NSIS\makensis.exe"
if "!MAKENSIS!"=="" (
    echo [ERROR] NSIS makensis.exe not found!
    pause & exit /b 1
)
echo [OK] Found NSIS: !MAKENSIS!

if not exist "dist" mkdir "dist"

set "NSIS_LOG=dist\nsis-build.log"
echo [INFO] NSIS log: !NSIS_LOG!

"!MAKENSIS!" /V4 ^
    /DVERSION=!VERSION! ^
    /DTAURI_BUNDLE_DIR=_staging ^
    /DFAT_MODE=1 ^
    /DCLAUDE_ENV_DIR=claude-env ^
    installer\installer.nsi > "!NSIS_LOG!" 2>&1

if errorlevel 1 (
    echo [FAILED] NSIS compile failed. Check log: !NSIS_LOG!
    echo.
    echo === Last 30 lines of NSIS log ===
    powershell -NoProfile -Command "Get-Content '!NSIS_LOG!' -Tail 30"
    pause & exit /b 1
)
echo [OK] NSIS compile succeeded

:: 清理 staging
rmdir /s /q "%STAGING%" 2>nul

:: ============================================================
::  Step 6: 验证输出
:: ============================================================
set "OUTPUT_EXE=dist\AgentWithU-!VERSION!-setup.exe"
if exist "!OUTPUT_EXE!" (
    for /f %%s in ('powershell -NoProfile -Command "(Get-Item '!OUTPUT_EXE!').Length / 1MB"') do set OUT_SIZE_MB=%%s
    echo.
    echo [INFO] Installer size: !OUT_SIZE_MB! MB
    for /f %%c in ('powershell -NoProfile -Command "if ([double]'!OUT_SIZE_MB!' -lt 50) { 'SMALL' } else { 'OK' }"') do set SIZE_CHECK=%%c
    if "!SIZE_CHECK!"=="SMALL" (
        echo [WARN] Installer seems too small for a fat build!
    )
)

python scripts\register_release_candidate.py --project-root "%CD%" --source build_fat_sideonly
if errorlevel 1 echo [WARN] Build succeeded, but release candidate registration failed. You can rescan in Release Center.

echo.
echo  =============================================
echo   Done! Fat installer:
echo   dist\AgentWithU-!VERSION!-setup.exe
echo   Size: !OUT_SIZE_MB! MB
echo.
echo   * Tauri exe: reused existing build
echo   * Sidecar:   freshly rebuilt
echo  =============================================
echo.
pause

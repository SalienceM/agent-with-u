@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Build Fat Installer - AgentWithU
cd /d "%~dp0"

echo.
echo  =============================================
echo   AgentWithU -- Fat Installer Build
echo   (含 Claude Code CLI + Node.js 运行时)
echo  =============================================
echo.

:: ── 版本号（与 build_all.bat 保持一致）──────────────────
for /f %%a in ('powershell -NoProfile -Command "[int](Get-Date -Format yy)"') do set VER_YY=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).Month"') do set VER_MM=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).Day"') do set VER_DD=%%a
set "VERSION=!VER_YY!.!VER_MM!.!VER_DD!"
echo [INFO] Version: !VERSION!

:: ============================================================
::  Step 0: 先执行常规构建（如果还没构建过）
:: ============================================================
for /f "tokens=2" %%T in ('rustc -Vv ^| findstr /i "host"') do set TARGET_TRIPLE=%%T
if "%TARGET_TRIPLE%"=="" set TARGET_TRIPLE=x86_64-pc-windows-msvc

set "TAURI_EXE=src-tauri\target\release\AgentWithU.exe"
if not exist "!TAURI_EXE!" (
    echo [STEP 0] Tauri 尚未构建，先运行 build_all.bat ...
    call build_all.bat
    if errorlevel 1 ( echo [FAILED] build_all.bat failed & pause & exit /b 1 )
)
echo [OK] Tauri build exists

:: ============================================================
::  Step 1: 准备 claude-env 目录
:: ============================================================
set "CLAUDE_ENV=installer\claude-env"
echo.
echo [STEP 1] Preparing claude-env ...

:: ── 1a: 下载 portable Node.js ──────────────────────
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
:: 优先用 npmmirror，失败则用官方
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { Invoke-WebRequest -Uri '%NODE_URL_OFFICIAL%' -OutFile '%NODE_ZIP%' -UseBasicParsing }"
if not exist "%NODE_ZIP%" (
    echo [ERROR] Node.js download failed
    pause & exit /b 1
)

echo [EXTRACT] Extracting Node.js ...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%TEMP%\node-extract' -Force"
:: Node.js zip 内有一层目录名
xcopy /s /e /y /q "%TEMP%\node-extract\%NODE_DIR%\*" "%CLAUDE_ENV%\node\" >nul
rmdir /s /q "%TEMP%\node-extract" 2>nul
del "%NODE_ZIP%" 2>nul
echo [OK] Node.js %NODE_VER% ready

:node_ready

:: ── 1b: 用 portable Node 安装 claude-code ──────────────────
set "NPM_PREFIX=%cd%\%CLAUDE_ENV%\npm-global"
set "NODE_EXE=%cd%\%CLAUDE_ENV%\node\node.exe"
set "NPM_CMD=%cd%\%CLAUDE_ENV%\node\npm.cmd"

if exist "%NPM_PREFIX%\node_modules\@anthropic-ai\claude-code" (
    echo [OK] Claude Code already installed, skipping
    goto claude_ready
)

echo [INSTALL] Installing @anthropic-ai/claude-code ...
if not exist "%NPM_PREFIX%" mkdir "%NPM_PREFIX%"

:: 使用 portable node 和 npmmirror
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

:: ── 1c: 生成 claude.cmd 启动器 ──────────────────────
echo [GEN] Creating claude.cmd wrapper ...
(
echo @echo off
echo setlocal
echo set "SCRIPT_DIR=%%~dp0"
echo set "NODE_EXE=%%SCRIPT_DIR%%node\node.exe"
echo set "CLAUDE_MAIN=%%SCRIPT_DIR%%npm-global\node_modules\@anthropic-ai\claude-code\cli.js"
echo "%%NODE_EXE%%" "%%CLAUDE_MAIN%%" %%*
) > "%CLAUDE_ENV%\claude.cmd"
echo [OK] claude.cmd created

:: ============================================================
::  Step 2: 收集 Tauri 产物到临时目录
:: ============================================================
echo.
echo [STEP 2] Collecting build artifacts ...

set "STAGING=installer\_staging"
if exist "%STAGING%" rmdir /s /q "%STAGING%"
mkdir "%STAGING%"

:: 主程序
copy /y "src-tauri\target\release\AgentWithU.exe" "%STAGING%\" >nul
:: Python sidecar — 带 target triple 后缀的是 Tauri 用的，我们拷原名
if exist "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe" (
    copy /y "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe" "%STAGING%\agent-with-u-backend.exe" >nul
) else if exist "dist\agent-with-u-backend.exe" (
    copy /y "dist\agent-with-u-backend.exe" "%STAGING%\agent-with-u-backend.exe" >nul
)
:: WebView2Loader
copy /y "src-tauri\target\release\WebView2Loader.dll" "%STAGING%\" >nul 2>nul
echo [OK] Artifacts staged

:: ============================================================
::  Step 3: 编译 NSIS 安装包
:: ============================================================
echo.
echo [STEP 3] Compiling NSIS installer ...

:: 检查 makensis
where makensis >nul 2>&1
if errorlevel 1 (
    :: 尝试常见安装路径
    if exist "C:\Program Files (x86)\NSIS\makensis.exe" (
        set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
    ) else if exist "C:\Program Files\NSIS\makensis.exe" (
        set "MAKENSIS=C:\Program Files\NSIS\makensis.exe"
    ) else (
        echo [ERROR] NSIS not found! Install from https://nsis.sourceforge.io/
        echo         or: winget install NSIS.NSIS
        pause & exit /b 1
    )
) else (
    set "MAKENSIS=makensis"
)

if not exist "dist" mkdir "dist"

"%MAKENSIS%" /V3 ^
    /DVERSION=!VERSION! ^
    /DTAURI_BUNDLE_DIR=..\_staging ^
    /DFAT_MODE=1 ^
    /DCLAUDE_ENV_DIR=claude-env ^
    installer\installer.nsi

if errorlevel 1 (
    echo [FAILED] NSIS compile failed
    pause & exit /b 1
)

:: 清理临时文件
rmdir /s /q "%STAGING%" 2>nul

echo.
echo  =============================================
echo   Done! Fat installer:
echo   dist\AgentWithU-!VERSION!-setup.exe
echo  =============================================
echo.
echo  Lite installer (Tauri MSI):
echo   src-tauri\target\release\bundle\msi\
echo.
pause

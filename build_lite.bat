@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Build Lite Installer - AgentWithU
cd /d "%~dp0"

echo.
echo  =============================================
echo   AgentWithU -- Lite Installer Build
echo   (不含 Claude Code，需用户自行安装)
echo  =============================================
echo.

:: ── 版本号：沿用已经编译进主程序/sidecar 的版本 ────────────────
for /f "delims=" %%a in ('python -c "import src._version as v; print(getattr(v,'__display_version__',v.__version__))"') do set "VERSION=%%a"

for /f "tokens=2" %%T in ('rustc -Vv ^| findstr /i "host"') do set TARGET_TRIPLE=%%T
if "%TARGET_TRIPLE%"=="" set TARGET_TRIPLE=x86_64-pc-windows-msvc

:: 确保 Tauri 已构建
set "TAURI_EXE=src-tauri\target\release\agent-with-u.exe"
if not exist "!TAURI_EXE!" (
    echo [INFO] Running build_all.bat first ...
    call build_all.bat
    if errorlevel 1 ( echo [FAILED] & pause & exit /b 1 )
)

:: 收集产物
set "STAGING=installer\_staging"
if exist "%STAGING%" rmdir /s /q "%STAGING%"
mkdir "%STAGING%"
if not exist "src-tauri\target\release\agent-with-u.exe" (
    echo [ERROR] agent-with-u.exe not found. Run build_all.bat first.
    pause & exit /b 1
)
copy /y "src-tauri\target\release\agent-with-u.exe" "%STAGING%\AgentWithU.exe"
if exist "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe" (
    copy /y "src-tauri\binaries\agent-with-u-backend-%TARGET_TRIPLE%.exe" "%STAGING%\agent-with-u-backend.exe"
) else if exist "dist\agent-with-u-backend.exe" (
    copy /y "dist\agent-with-u-backend.exe" "%STAGING%\agent-with-u-backend.exe"
) else (
    echo [WARN] Backend sidecar not found!
)
copy /y "src-tauri\target\release\WebView2Loader.dll" "%STAGING%\" >nul 2>nul

:: NSIS（不传 FAT_MODE）— 按优先级查找：PATH → Tauri 缓存 → 常见安装路径
set "MAKENSIS="
where makensis >nul 2>&1 && set "MAKENSIS=makensis"
if "!MAKENSIS!"=="" (
    for /f "delims=" %%F in ('dir /s /b "%LOCALAPPDATA%\tauri\makensis.exe" 2^>nul') do if "!MAKENSIS!"=="" set "MAKENSIS=%%F"
)
if "!MAKENSIS!"=="" if exist "C:\Program Files (x86)\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
if "!MAKENSIS!"=="" if exist "C:\Program Files\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files\NSIS\makensis.exe"
if "!MAKENSIS!"=="" (
    echo [ERROR] NSIS not found! Install from https://nsis.sourceforge.io/Download
    pause & exit /b 1
)
echo [OK] Found NSIS: !MAKENSIS!

if not exist "dist" mkdir "dist"

"%MAKENSIS%" /V3 ^
    /DVERSION=!VERSION! ^
    /DTAURI_BUNDLE_DIR=_staging ^
    installer\installer.nsi

if errorlevel 1 ( echo [FAILED] NSIS compile failed & pause & exit /b 1 )
rmdir /s /q "%STAGING%" 2>nul

python scripts\register_release_candidate.py --project-root "%CD%" --source build_lite
if errorlevel 1 echo [WARN] Build succeeded, but release candidate registration failed. You can rescan in Release Center.

echo.
echo  Done! Lite installer: dist\AgentWithU-!VERSION!-setup.exe
echo.
pause

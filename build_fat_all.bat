@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Build Fat All - AgentWithU
cd /d "%~dp0"

echo.
echo  =============================================
echo   AgentWithU -- Full Fat Build
echo   PyInstaller + Tauri + Claude Code + NSIS
echo   完整重建所有组件
echo  =============================================
echo.

:: ============================================================
::  Step 1: 完整构建 (PyInstaller sidecar + Tauri 前端)
:: ============================================================
echo [STEP 1/2] Running build_all.bat ...
echo.
:: 限制 Rust 并行编译数，防止内存不足导致 OOM
if not defined CARGO_BUILD_JOBS (
    set "CARGO_BUILD_JOBS=2"
    echo [INFO] Set CARGO_BUILD_JOBS=2 to reduce memory usage
)
call build_all.bat
if errorlevel 1 (
    echo.
    echo [FAILED] build_all.bat failed, aborting fat build
    pause & exit /b 1
)

:: ============================================================
::  Step 2: Fat 打包 (claude-env + NSIS installer)
:: ============================================================
echo.
echo [STEP 2/2] Running build_fat.bat ...
echo.
call build_fat.bat
if errorlevel 1 (
    echo.
    echo [FAILED] build_fat.bat failed
    pause & exit /b 1
)

echo.
echo  =============================================
echo   All done! Full fat build completed.
echo  =============================================
echo.
pause

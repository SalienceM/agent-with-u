@echo off
chcp 65001 >nul
setlocal

:: ────────────────────────────────────────
::  AgentWithU 开发模式一键启动
::  会打开两个终端窗口：前端 Vite + 后端 WS
::  浏览器自动打开 http://localhost:5173
:: ────────────────────────────────────────

set "ROOT=%~dp0"
set "FRONTEND=%ROOT%frontend"

echo.
echo  ====================================
echo   AgentWithU Dev Mode Starting...
echo  ====================================
echo.

:: ── 检查 Python ──────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found in PATH.
    pause & exit /b 1
)

:: ── 检查 Node / npm ──────────────────────
where npm >nul 2>&1
if errorlevel 1 (
    :: 尝试 AppData\npm（Windows 全局安装常见位置）
    set "NPM_GLOBAL=%APPDATA%\npm"
    if exist "%NPM_GLOBAL%\npm.cmd" (
        set "PATH=%NPM_GLOBAL%;%PATH%"
    ) else (
        echo [ERROR] npm not found in PATH.
        pause & exit /b 1
    )
)

:: ── 检查前端依赖 ──────────────────────────
if not exist "%FRONTEND%\node_modules" (
    echo [INFO] node_modules not found, running npm install...
    pushd "%FRONTEND%"
    call npm install
    popd
)

:: ── 启动后端（新窗口）───────────────────
echo [1/2] Starting Python WebSocket backend...
start "AgentWithU Backend" cmd /k "cd /d "%ROOT%" && echo [Backend] Starting ws_main on ws://127.0.0.1:44321 ... && python -m src.ws_main"

:: ── 等待后端稳定 ─────────────────────────
timeout /t 2 /nobreak >nul

:: ── 启动前端（新窗口）───────────────────
echo [2/2] Starting Vite dev server...
start "AgentWithU Frontend" cmd /k "cd /d "%FRONTEND%" && echo [Frontend] Starting Vite on http://localhost:5173 ... && npm run dev"

:: ── 等待 Vite 启动后打开浏览器 ──────────
echo.
echo  Waiting for Vite to start (3s)...
timeout /t 3 /nobreak >nul

echo  Opening browser...
start "" "http://localhost:5173"

echo.
echo  ====================================
echo   Services started:
echo     Backend : ws://127.0.0.1:44321
echo     Frontend: http://localhost:5173
echo.
echo   Close the two terminal windows to
echo   stop both services.
echo  ====================================
echo.
endlocal

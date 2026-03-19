@echo off
chcp 65001 >nul
setlocal
title AgentWithU — Dev Mode

set "ROOT=%~dp0"
set "FRONTEND=%ROOT%frontend"

echo.
echo  ====================================
echo   AgentWithU — 开发模式启动
echo  ====================================
echo.

:: ══════════════════════════════════════
:: 环境检查 + 自动准备
:: ══════════════════════════════════════

:: ── Python ───────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python。
    echo.
    echo   请安装 Python 3.10+ 并确保加入 PATH：
    echo   https://www.python.org/downloads/
    echo   （安装时勾选 "Add Python to PATH"）
    echo.
    pause & exit /b 1
)
for /f "tokens=*" %%V in ('python --version 2^>^&1') do echo [OK] %%V

:: ── Python 依赖 ──────────────────────
echo.
echo [准备] 检查 Python 依赖...
python -c "import websockets, PIL, httpx" >nul 2>&1
if errorlevel 1 (
    echo [安装] 安装 Python 依赖（清华镜像）...
    python -m pip install -r "%ROOT%requirements.txt" ^
        -i https://pypi.tuna.tsinghua.edu.cn/simple ^
        --trusted-host pypi.tuna.tsinghua.edu.cn
    if errorlevel 1 (
        echo [错误] pip install 失败，请检查网络
        pause & exit /b 1
    )
)
echo [OK] Python 依赖就绪

:: ── Node / npm ───────────────────────
echo.
where npm >nul 2>&1
if errorlevel 1 (
    set "NPM_GLOBAL=%APPDATA%\npm"
    if exist "%NPM_GLOBAL%\npm.cmd" (
        set "PATH=%NPM_GLOBAL%;%PATH%"
    ) else (
        echo [错误] 未找到 Node.js / npm。
        echo.
        echo   请安装 Node.js 18+ LTS：
        echo   https://nodejs.org/zh-cn/download/
        echo   （安装时勾选 "Add to PATH"，装完重启此窗口）
        echo.
        pause & exit /b 1
    )
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo [OK] Node %%V

:: ── 前端 node_modules ────────────────
if not exist "%FRONTEND%\node_modules" (
    echo.
    echo [安装] 安装前端依赖（淘宝镜像）...
    pushd "%FRONTEND%"
    call npm install --registry https://registry.npmmirror.com
    if errorlevel 1 (
        echo [错误] npm install 失败
        popd & pause & exit /b 1
    )
    popd
)
echo [OK] 前端依赖就绪

echo.
echo  ── 环境就绪，启动服务 ──────────────────────
echo.

:: ── 后端（新窗口）────────────────────
echo [1/2] 启动 Python WebSocket 后端...
start "AgentWithU Backend" cmd /k "cd /d "%ROOT%" && python -m src.ws_main"

:: ── 等待后端启动 ─────────────────────
timeout /t 2 /nobreak >nul

:: ── 前端（新窗口）────────────────────
echo [2/2] 启动 Vite 开发服务器...
start "AgentWithU Frontend" cmd /k "cd /d "%FRONTEND%" && npm run dev --registry https://registry.npmmirror.com"

:: ── 等待 Vite 启动后打开浏览器 ───────
echo.
echo  等待 Vite 启动（3s）...
timeout /t 3 /nobreak >nul

start "" "http://localhost:5173"

echo.
echo  ====================================
echo   已启动：
echo     后端  ws://127.0.0.1:44321
echo     前端  http://localhost:5173
echo.
echo   关闭两个终端窗口即可停止服务。
echo  ====================================
echo.
endlocal

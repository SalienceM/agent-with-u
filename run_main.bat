@echo off
chcp 65001 >nul
title Run Python App

echo ===== 启动 Python 程序 =====

cd /d "%~dp0"

if not exist "venv\Scripts\activate.bat" (
    echo [错误] 未找到虚拟环境激活脚本: venv\Scripts\activate.bat
    pause
    exit /b 1
)

call "venv\Scripts\activate.bat"

if errorlevel 1 (
    echo [错误] 虚拟环境激活失败
    pause
    exit /b 1
)

python -m src.main

if errorlevel 1 (
    echo.
    echo [失败] 程序执行失败
    pause
    exit /b 1
)

echo.
echo [成功] 程序执行完成
pause
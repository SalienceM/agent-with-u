@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ===== 首次运行只需修改这里 =====
set "RELAY_TOKEN=CHANGE_ME_TO_A_LONG_RANDOM_TOKEN"
set "RELAY_BIND=0.0.0.0"
set "RELAY_PORT=44360"
rem =================================

if "%RELAY_TOKEN%"=="CHANGE_ME_TO_A_LONG_RANDOM_TOKEN" (
  echo [ERROR] 请先用文本编辑器打开 run-relay.bat，设置 RELAY_TOKEN。
  pause
  exit /b 1
)

echo [Relay] ws://%RELAY_BIND%:%RELAY_PORT%
echo [Relay] 按 Ctrl+C 停止。
set "AGENT_WITH_U_RELAY_TOKEN=%RELAY_TOKEN%"
set "AGENT_WITH_U_RELAY_BIND=%RELAY_BIND%"
set "AGENT_WITH_U_RELAY_PORT=%RELAY_PORT%"
"%~dp0agent-with-u-relay.exe"

if errorlevel 1 (
  echo.
  echo [ERROR] Relay 已退出，错误码 %errorlevel%。
  pause
)

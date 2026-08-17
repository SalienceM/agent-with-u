@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ===== Edit the token before first run =====
set "RELAY_TOKEN=CHANGE_ME_TO_A_LONG_RANDOM_TOKEN"
set "RELAY_BIND=127.0.0.1"
set "RELAY_PORT=44360"
set "RELAY_PUBLIC_URL=wss://awu.saliencemc.com/relay"
set "RELAY_USERS_FILE=%~dp0data\users.json"
rem ===========================================

if not defined RELAY_TOKEN goto token_error
if "%RELAY_TOKEN%"=="CHANGE_ME_TO_A_LONG_RANDOM_TOKEN" goto token_error

if not exist "%~dp0agent-with-u-relay.exe" (
  echo [ERROR] agent-with-u-relay.exe was not found beside this BAT file.
  pause
  exit /b 2
)

echo [Relay] Local:  ws://%RELAY_BIND%:%RELAY_PORT%
echo [Relay] Public: %RELAY_PUBLIC_URL%
echo [Relay] Public firewall only needs Nginx ports 80 and 443.
echo [Relay] Press Ctrl+C to stop.
echo.

set "AGENT_WITH_U_RELAY_TOKEN=%RELAY_TOKEN%"
set "AGENT_WITH_U_RELAY_BIND=%RELAY_BIND%"
set "AGENT_WITH_U_RELAY_PORT=%RELAY_PORT%"
if not exist "%~dp0data" mkdir "%~dp0data"
set "AGENT_WITH_U_RELAY_USERS_FILE=%RELAY_USERS_FILE%"
"%~dp0agent-with-u-relay.exe"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Relay exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

:token_error
echo [ERROR] Open run-relay.bat and replace RELAY_TOKEN with a long random token.
pause
exit /b 1

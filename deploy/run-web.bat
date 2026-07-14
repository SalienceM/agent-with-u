@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ===== Nginx reverse-proxy settings =====
set "WEB_BIND=127.0.0.1"
set "WEB_PORT=44320"
set "WS_PORT=44321"
set "PUBLIC_URL=https://awu.saliencemc.com"
set "PUBLIC_WS_URL=wss://awu.saliencemc.com/ws"
rem ========================================

if not exist "%~dp0agent-with-u-web.exe" (
  echo [ERROR] agent-with-u-web.exe was not found beside this BAT file.
  pause
  exit /b 2
)

echo [Web] Local UI:  http://%WEB_BIND%:%WEB_PORT%
echo [Web] Local WS:  ws://%WEB_BIND%:%WS_PORT%
echo [Web] Public UI: %PUBLIC_URL%
echo [Web] Public WS: %PUBLIC_WS_URL%
echo [Web] Public firewall only needs Nginx ports 80 and 443.
echo [Web] The startup device code will be printed below.
echo.

"%~dp0agent-with-u-web.exe" ^
  --bind "%WEB_BIND%" ^
  --web-port "%WEB_PORT%" ^
  --port "%WS_PORT%" ^
  --public-ws-url "%PUBLIC_WS_URL%" ^
  --web-trust-loopback-proxy ^
  %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [Web] Server stopped with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

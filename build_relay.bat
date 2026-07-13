@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [Relay] Building standalone Windows executable...
where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python 3.10+ not found.
  exit /b 1
)

python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  echo [Relay] Installing build dependencies...
  python -m pip install "pyinstaller>=6" "websockets>=13"
  if errorlevel 1 exit /b 1
)

python -m PyInstaller ^
  --name agent-with-u-relay ^
  --onefile ^
  --console ^
  --noconfirm ^
  --clean ^
  --distpath dist\relay-build ^
  --workpath build\relay ^
  --specpath build\relay-spec ^
  --collect-all websockets ^
  relay_entry.py

if errorlevel 1 exit /b 1
if not exist "dist\relay-windows-x64" mkdir "dist\relay-windows-x64"
copy /y "dist\relay-build\agent-with-u-relay.exe" "dist\relay-windows-x64\agent-with-u-relay.exe" >nul
copy /y "deploy\run-relay.bat" "dist\relay-windows-x64\run-relay.bat" >nul
echo.
echo [OK] Portable package: dist\relay-windows-x64\
echo Edit run-relay.bat, set RELAY_TOKEN, then double-click it.

@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [Web] Building frontend...
pushd frontend
call npm run build
if errorlevel 1 ( popd & exit /b 1 )
popd

echo [Web] Building standalone Windows executable...
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  python -m pip install "pyinstaller>=6"
  if errorlevel 1 exit /b 1
)
python -m PyInstaller --noconfirm --clean agent-with-u-web.spec
if errorlevel 1 exit /b 1

if not exist "dist\web-windows-x64" mkdir "dist\web-windows-x64"
copy /y "dist\agent-with-u-web.exe" "dist\web-windows-x64\agent-with-u-web.exe" >nul
copy /y "deploy\run-web.bat" "dist\web-windows-x64\run-web.bat" >nul
echo.
echo [OK] Portable web package: dist\web-windows-x64\
echo Device code and access URLs are printed every time run-web.bat starts.

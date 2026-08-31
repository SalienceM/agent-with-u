@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."

where docker >nul 2>&1
if errorlevel 1 (
  echo [Docker] Docker CLI not found; Docker release bundle was not built.
  exit /b 2
)
docker info >nul 2>&1
if errorlevel 1 (
  echo [Docker] Docker engine is not running; Docker release bundle was not built.
  exit /b 2
)

if /I not "%~1"=="--reuse-version" (
  python scripts\stamp_version.py
  if errorlevel 1 exit /b 1
)

if not defined AGENT_WITH_U_DOCKER_ARCH set "AGENT_WITH_U_DOCKER_ARCH=x86_64"
for /f "delims=" %%V in ('python -c "from src import _version as v; print(getattr(v,'__display_version__',getattr(v,'__version__','dev')))"') do set "AGENT_WITH_U_VERSION=%%V"
for /f "delims=" %%V in ('python -c "from src import _version as v; print(getattr(v,'__build_id__','dev'))"') do set "AGENT_WITH_U_BUILD_ID=%%V"
set "BUNDLE=dist\agent-with-u-docker-linux-%AGENT_WITH_U_DOCKER_ARCH%.tar"
if not exist dist mkdir dist
del /q "%BUNDLE%" 2>nul

echo [Docker] Building backend/web images (Codex + Qwen included)...
docker compose -f deploy\docker-compose.example.yml build awu-backend awu-web
if errorlevel 1 exit /b 1

echo [Docker] Exporting online-update bundle: %BUNDLE%
docker image save --output "%BUNDLE%" agent-with-u-backend:latest agent-with-u-web:latest
if errorlevel 1 exit /b 1

python scripts\register_release_candidate.py --project-root "%CD%" --source build_docker_release
if errorlevel 1 echo [WARN] Docker bundle succeeded, but candidate registration failed. You can rescan in Release Center.
echo [OK] Docker online-update bundle: %BUNDLE%
exit /b 0

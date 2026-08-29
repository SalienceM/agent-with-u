#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

python3 scripts/stamp_version.py
(cd frontend && npm run build)
python3 -m PyInstaller --version >/dev/null 2>&1 || python3 -m pip install "pyinstaller>=6"
python3 -m PyInstaller --noconfirm --clean agent-with-u-web.spec

rm -rf dist/web-linux-x64
mkdir -p dist/web-linux-x64
cp dist/agent-with-u-web dist/web-linux-x64/agent-with-u-web
cp deploy/run-web.sh dist/web-linux-x64/run-web.sh
chmod +x dist/web-linux-x64/agent-with-u-web dist/web-linux-x64/run-web.sh
tar -C dist -czf dist/agent-with-u-web-linux-x64.tar.gz web-linux-x64
if [ "${AGENT_WITH_U_SKIP_DOCKER_RELEASE:-0}" != "1" ] \
  && command -v docker >/dev/null 2>&1 \
  && docker info >/dev/null 2>&1; then
  if ! sh deploy/build-docker-release.sh --reuse-version; then
    echo "[WARN] Portable web package succeeded, but Docker release bundle failed."
  fi
else
  echo "[INFO] Docker engine unavailable or disabled; skipped Docker online-update bundle."
fi
if ! python3 scripts/register_release_candidate.py --project-root "$PWD" --source build_web_linux; then
  echo "[WARN] Build succeeded, but release candidate registration failed. You can rescan in Release Center."
fi
echo "[OK] Portable web package: dist/agent-with-u-web-linux-x64.tar.gz"

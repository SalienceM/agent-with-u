#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

(cd frontend && npm run build)
python3 -m PyInstaller --version >/dev/null 2>&1 || python3 -m pip install "pyinstaller>=6"
python3 -m PyInstaller --noconfirm --clean agent-with-u-web.spec

mkdir -p dist/web-linux-x64
cp dist/agent-with-u-web dist/web-linux-x64/agent-with-u-web
cp deploy/run-web.sh dist/web-linux-x64/run-web.sh
chmod +x dist/web-linux-x64/agent-with-u-web dist/web-linux-x64/run-web.sh
echo "[OK] Portable web package: dist/web-linux-x64/"

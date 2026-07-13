#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
ARCH=$(uname -m)
PACKAGE="dist/relay-linux-$ARCH"

PYTHON=${PYTHON:-python3}
"$PYTHON" -m pip install --user "pyinstaller>=6" "websockets>=13"
"$PYTHON" -m PyInstaller \
  --name agent-with-u-relay \
  --onefile \
  --console \
  --noconfirm \
  --clean \
  --distpath dist/relay-build \
  --workpath build/relay \
  --specpath build/relay-spec \
  --collect-all websockets \
  relay_entry.py

mkdir -p "$PACKAGE"
cp dist/relay-build/agent-with-u-relay "$PACKAGE/agent-with-u-relay"
cp deploy/run-relay.sh "$PACKAGE/run-relay.sh"
chmod +x "$PACKAGE/agent-with-u-relay" "$PACKAGE/run-relay.sh"
printf '\n[OK] Portable package: %s/%s\n' "$ROOT" "$PACKAGE"
printf 'Edit run-relay.sh, set RELAY_TOKEN, then run ./run-relay.sh\n'

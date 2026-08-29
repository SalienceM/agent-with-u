#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "[Docker] Docker engine is unavailable; Docker release bundle was not built." >&2
  exit 2
fi

if [ "${1:-}" != "--reuse-version" ]; then
  python3 scripts/stamp_version.py
fi

arch="${AGENT_WITH_U_DOCKER_ARCH:-$(uname -m)}"
case "$arch" in
  amd64|x64) arch=x86_64 ;;
  arm64) arch=aarch64 ;;
esac
AGENT_WITH_U_VERSION="$(python3 -c "from src import _version as v; print(getattr(v, '__display_version__', getattr(v, '__version__', 'dev')))")"
AGENT_WITH_U_BUILD_ID="$(python3 -c "from src import _version as v; print(getattr(v, '__build_id__', 'dev'))")"
export AGENT_WITH_U_VERSION AGENT_WITH_U_BUILD_ID
bundle="dist/agent-with-u-docker-linux-$arch.tar"
mkdir -p dist
rm -f "$bundle"

echo "[Docker] Building backend/web images (Codex included)..."
docker compose -f deploy/docker-compose.example.yml build awu-backend awu-web
echo "[Docker] Exporting online-update bundle: $bundle"
docker image save --output "$bundle" agent-with-u-backend:latest agent-with-u-web:latest

if ! python3 scripts/register_release_candidate.py --project-root "$PWD" --source build_docker_release; then
  echo "[WARN] Docker bundle succeeded, but candidate registration failed. You can rescan in Release Center." >&2
fi
echo "[OK] Docker online-update bundle: $bundle"

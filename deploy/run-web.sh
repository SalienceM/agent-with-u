#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting AgentWithU portable web server..."
echo "Open TCP ports 44320 (Web UI) and 44321 (WebSocket) when accessing remotely."
exec ./agent-with-u-web "$@"

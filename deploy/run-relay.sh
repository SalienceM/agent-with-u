#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

# ===== 首次运行只需修改这里 =====
RELAY_TOKEN='CHANGE_ME_TO_A_LONG_RANDOM_TOKEN'
RELAY_BIND='0.0.0.0'
RELAY_PORT='44360'
RELAY_USERS_FILE="$(pwd)/data/users.json"
# =================================

if [ "$RELAY_TOKEN" = 'CHANGE_ME_TO_A_LONG_RANDOM_TOKEN' ]; then
  echo '[ERROR] 请先编辑 run-relay.sh，设置 RELAY_TOKEN。' >&2
  exit 1
fi

echo "[Relay] ws://$RELAY_BIND:$RELAY_PORT"
echo '[Relay] 按 Ctrl+C 停止。'
export AGENT_WITH_U_RELAY_TOKEN="$RELAY_TOKEN"
export AGENT_WITH_U_RELAY_BIND="$RELAY_BIND"
export AGENT_WITH_U_RELAY_PORT="$RELAY_PORT"
mkdir -p "$(dirname "$RELAY_USERS_FILE")"
export AGENT_WITH_U_RELAY_USERS_FILE="$RELAY_USERS_FILE"
exec "$(pwd)/agent-with-u-relay"

#!/bin/sh
# AgentWithU Docker updater sidecar.
# shellcheck shell=sh

set -u

DATA_ROOT="${AGENT_WITH_U_DATA_ROOT:-/app/data}"
QUEUE_DIR="${AGENT_WITH_U_DOCKER_UPDATER_DIR:-$DATA_ROOT/docker-updater}"
REQUEST_PATH="$QUEUE_DIR/request.json"
PROCESSING_PATH="$QUEUE_DIR/processing.json"
HEARTBEAT_PATH="$QUEUE_DIR/heartbeat"
DEFAULT_RESULT_PATH="$DATA_ROOT/updates/install-result.json"
COMPOSE_FILE="${AGENT_WITH_U_DOCKER_COMPOSE_FILE:-/workspace/deploy/docker-compose.example.yml}"
PROJECT_DIR="${AGENT_WITH_U_DOCKER_PROJECT_DIR:-/workspace}"
PROJECT_NAME="${AGENT_WITH_U_DOCKER_PROJECT_NAME:-}"

BACKEND_IMAGE="agent-with-u-backend:latest"
WEB_IMAGE="agent-with-u-web:latest"
BACKEND_CONTAINER="awu-backend"
WEB_CONTAINER="awu-web"

mkdir -p "$QUEUE_DIR" "$DATA_ROOT/updates"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

heartbeat_loop() {
  while :; do
    temp="$HEARTBEAT_PATH.tmp.$$"
    date +%s > "$temp"
    mv -f "$temp" "$HEARTBEAT_PATH"
    sleep 5
  done
}

HEARTBEAT_PID=""
cleanup() {
  if [ -n "$HEARTBEAT_PID" ]; then
    kill "$HEARTBEAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM
heartbeat_loop &
HEARTBEAT_PID=$!

RESULT_PATH="$DEFAULT_RESULT_PATH"
VERSION=""
BUILD_ID=""
ERROR_MESSAGE=""
ROLLBACK_BACKEND=""
ROLLBACK_WEB=""
ROLLBACK_TAG=""

set_error() {
  ERROR_MESSAGE="$1"
  log "ERROR: $ERROR_MESSAGE"
  return 1
}

write_result() {
  ok="$1"
  error="$2"
  mkdir -p "$(dirname "$RESULT_PATH")"
  temp="$RESULT_PATH.tmp.$$"
  if [ "$ok" = "true" ]; then
    jq -n \
      --argjson finishedAt "$(date +%s)" \
      --arg version "$VERSION" \
      --arg buildId "$BUILD_ID" \
      '{schemaVersion:1, finishedAt:$finishedAt, version:$version, buildId:$buildId, ok:true, installer:"docker-sidecar"}' \
      > "$temp"
  else
    jq -n \
      --argjson finishedAt "$(date +%s)" \
      --arg version "$VERSION" \
      --arg buildId "$BUILD_ID" \
      --arg error "$error" \
      '{schemaVersion:1, finishedAt:$finishedAt, version:$version, buildId:$buildId, ok:false, installer:"docker-sidecar", error:$error}' \
      > "$temp"
  fi
  mv -f "$temp" "$RESULT_PATH"
}

compose_up() {
  compose_project="$PROJECT_NAME"
  if [ -z "$compose_project" ]; then
    compose_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  fi
  if [ -n "$compose_project" ]; then
    docker compose \
      --project-name "$compose_project" \
      --project-directory "$PROJECT_DIR" \
      --file "$COMPOSE_FILE" \
      up -d --no-build --force-recreate awu-backend awu-web
  else
    docker compose \
      --project-directory "$PROJECT_DIR" \
      --file "$COMPOSE_FILE" \
      up -d --no-build --force-recreate awu-backend awu-web
  fi
}

rollback_images() {
  [ -n "$ROLLBACK_TAG" ] || return 0
  log "Restoring the previous AgentWithU images"
  if [ -n "$ROLLBACK_BACKEND" ]; then
    docker image tag "$ROLLBACK_BACKEND" "$BACKEND_IMAGE" >/dev/null 2>&1 || true
  fi
  if [ -n "$ROLLBACK_WEB" ]; then
    docker image tag "$ROLLBACK_WEB" "$WEB_IMAGE" >/dev/null 2>&1 || true
  fi
  compose_up >/dev/null 2>&1 || true
}

remove_rollback_tags() {
  [ -n "$ROLLBACK_TAG" ] || return 0
  docker image rm "agent-with-u-backend:$ROLLBACK_TAG" >/dev/null 2>&1 || true
  docker image rm "agent-with-u-web:$ROLLBACK_TAG" >/dev/null 2>&1 || true
}

wait_until_healthy() {
  count=0
  while [ "$count" -lt 90 ]; do
    backend_running="$(docker inspect --format '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
    web_running="$(docker inspect --format '{{.State.Running}}' "$WEB_CONTAINER" 2>/dev/null || true)"
    if [ "$backend_running" = "true" ] && [ "$web_running" = "true" ]; then
      if nc -z -w 2 awu-backend 44321 >/dev/null 2>&1 \
        && wget -q -T 2 -O /dev/null http://awu-web/ >/dev/null 2>&1; then
        return 0
      fi
    fi
    count=$((count + 1))
    sleep 1
  done
  set_error "new containers did not become healthy within 90 seconds"
}

apply_request() {
  request="$1"
  RESULT_PATH="$DEFAULT_RESULT_PATH"
  VERSION=""
  BUILD_ID=""
  ERROR_MESSAGE=""
  ROLLBACK_BACKEND=""
  ROLLBACK_WEB=""
  ROLLBACK_TAG=""

  marker="$(jq -r '.marker // empty' "$request" 2>/dev/null || true)"
  [ "$marker" = "agentwithu-docker-update-request-v1" ] \
    || set_error "untrusted Docker update request marker" || return 1

  plan_path="$(jq -r '.planPath // empty' "$request")"
  updates_root="$(readlink -f "$DATA_ROOT/updates" 2>/dev/null || true)"
  plan_real="$(readlink -f "$plan_path" 2>/dev/null || true)"
  case "$plan_real" in
    "$updates_root"/*/install-plan.json) ;;
    *) set_error "update plan is outside the managed updates directory"; return 1 ;;
  esac
  [ -f "$plan_real" ] || { set_error "update plan is missing"; return 1; }

  plan_marker="$(jq -r '.marker // empty' "$plan_real")"
  installer_type="$(jq -r '.installerType // empty' "$plan_real")"
  artifact_kind="$(jq -r '.artifactKind // empty' "$plan_real")"
  [ "$plan_marker" = "agentwithu-update-plan-v1" ] \
    || { set_error "untrusted update plan marker"; return 1; }
  [ "$installer_type" = "docker-updater" ] && [ "$artifact_kind" = "docker-bundle" ] \
    || { set_error "the staged artifact is not an AgentWithU Docker bundle"; return 1; }

  artifact_path="$(jq -r '.artifactPath // empty' "$plan_real")"
  artifact_real="$(readlink -f "$artifact_path" 2>/dev/null || true)"
  case "$artifact_real" in
    "$updates_root"/*) ;;
    *) set_error "Docker bundle is outside the managed updates directory"; return 1 ;;
  esac
  [ -f "$artifact_real" ] || { set_error "Docker bundle is missing"; return 1; }

  expected="$(jq -r '.artifactSha256 // empty' "$plan_real" | tr 'A-F' 'a-f')"
  actual="$(sha256sum "$artifact_real" | awk '{print $1}')"
  [ "${#expected}" -eq 64 ] && [ "$actual" = "$expected" ] \
    || { set_error "Docker bundle SHA-256 mismatch"; return 1; }

  VERSION="$(jq -r '.version // empty' "$plan_real")"
  BUILD_ID="$(jq -r '.buildId // empty' "$plan_real")"
  configured_result="$(jq -r '.resultPath // empty' "$plan_real")"
  result_real="$(readlink -f "$(dirname "$configured_result")" 2>/dev/null || true)/$(basename "$configured_result")"
  case "$result_real" in
    "$updates_root"/*) RESULT_PATH="$result_real" ;;
    *) set_error "update result path is outside the managed updates directory"; return 1 ;;
  esac

  request_id="$(jq -r '.requestId // empty' "$request" | tr -cd 'A-Za-z0-9._-')"
  [ -n "$request_id" ] || request_id="$(date +%s)"
  ROLLBACK_TAG="awu-rollback-$request_id"
  # A sidecar/container restart may leave processing.json behind.  Reuse the
  # original rollback tags instead of overwriting them with a half-applied image.
  ROLLBACK_BACKEND="$(docker image inspect "agent-with-u-backend:$ROLLBACK_TAG" --format '{{.Id}}' 2>/dev/null || true)"
  ROLLBACK_WEB="$(docker image inspect "agent-with-u-web:$ROLLBACK_TAG" --format '{{.Id}}' 2>/dev/null || true)"
  if [ -z "$ROLLBACK_BACKEND" ]; then
    ROLLBACK_BACKEND="$(docker image inspect "$BACKEND_IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  fi
  if [ -z "$ROLLBACK_WEB" ]; then
    ROLLBACK_WEB="$(docker image inspect "$WEB_IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  fi
  if [ -n "$ROLLBACK_BACKEND" ] \
    && ! docker image inspect "agent-with-u-backend:$ROLLBACK_TAG" >/dev/null 2>&1; then
    docker image tag "$ROLLBACK_BACKEND" "agent-with-u-backend:$ROLLBACK_TAG" \
      || { set_error "cannot preserve the current backend image"; return 1; }
  fi
  if [ -n "$ROLLBACK_WEB" ] \
    && ! docker image inspect "agent-with-u-web:$ROLLBACK_TAG" >/dev/null 2>&1; then
    docker image tag "$ROLLBACK_WEB" "agent-with-u-web:$ROLLBACK_TAG" \
      || { set_error "cannot preserve the current web image"; return 1; }
  fi

  log "Loading verified Docker bundle for $VERSION ($BUILD_ID)"
  docker image load --input "$artifact_real" \
    || { set_error "docker image load failed"; return 1; }

  backend_component="$(docker image inspect "$BACKEND_IMAGE" --format '{{index .Config.Labels "io.agentwithu.component"}}' 2>/dev/null || true)"
  web_component="$(docker image inspect "$WEB_IMAGE" --format '{{index .Config.Labels "io.agentwithu.component"}}' 2>/dev/null || true)"
  [ "$backend_component" = "backend" ] && [ "$web_component" = "web" ] \
    || { set_error "bundle does not contain the labelled AgentWithU backend/web images"; return 1; }
  backend_build="$(docker image inspect "$BACKEND_IMAGE" --format '{{index .Config.Labels "io.agentwithu.build-id"}}' 2>/dev/null || true)"
  web_build="$(docker image inspect "$WEB_IMAGE" --format '{{index .Config.Labels "io.agentwithu.build-id"}}' 2>/dev/null || true)"
  [ -n "$BUILD_ID" ] && [ "$backend_build" = "$BUILD_ID" ] && [ "$web_build" = "$BUILD_ID" ] \
    || { set_error "Docker image labels do not match the staged release build id"; return 1; }

  [ -f "$COMPOSE_FILE" ] \
    || { set_error "Docker Compose file is not mounted into the updater"; return 1; }
  log "Recreating awu-backend and awu-web"
  compose_up || { set_error "docker compose could not recreate AgentWithU"; return 1; }
  wait_until_healthy || return 1

  remove_rollback_tags
  write_result true ""
  log "Docker update completed successfully"
  return 0
}

log "AgentWithU Docker updater is ready (project=${PROJECT_NAME:-auto})"
while :; do
  pending=""
  if [ -f "$PROCESSING_PATH" ]; then
    pending="$PROCESSING_PATH"
    log "Resuming an interrupted Docker update request"
  elif [ -f "$REQUEST_PATH" ] && mv "$REQUEST_PATH" "$PROCESSING_PATH" 2>/dev/null; then
    pending="$PROCESSING_PATH"
  fi
  if [ -n "$pending" ]; then
    if apply_request "$PROCESSING_PATH"; then
      rm -f "$PROCESSING_PATH"
    else
      rollback_images
      write_result false "${ERROR_MESSAGE:-Docker update failed}"
      remove_rollback_tags
      rm -f "$PROCESSING_PATH"
    fi
  fi
  sleep 2
done

#!/usr/bin/env bash
set -euo pipefail

PUSH_PORT="${1:-5000}"
# REGISTRY_HOST="127.0.0.1:${PUSH_PORT}"
REGISTRY_HOST="host.docker.internal:${PUSH_PORT}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf "[%s] %s\n" "$(date +'%H:%M:%S')" "$*"
}

log "Using registry ${REGISTRY_HOST}"

build_image() {
  local name="$1"
  local dockerfile="$2"
  log "BUILD+PUSH ${name} (linux/amd64)"
  docker buildx build --platform linux/amd64 -t "${REGISTRY_HOST}/${name}:latest" -f "${dockerfile}" "${ROOT_DIR}" --push
  log "DONE  ${name}"
}

log "Starting parallel buildx pushes"
build_image "bot-a-api" "${ROOT_DIR}/api/Dockerfile" &
PID_API=$!
build_image "bot-a-db-migrate" "${ROOT_DIR}/packages/db/Dockerfile.migrate" &
PID_DBM=$!
build_image "bot-a-bot" "${ROOT_DIR}/bot/Dockerfile" &
PID_BOT=$!
build_image "bot-a-partner-bot" "${ROOT_DIR}/partner_bot/Dockerfile" &
PID_PBOT=$!

wait "${PID_API}" "${PID_DBM}" "${PID_BOT}" "${PID_PBOT}"
log "All buildx pushes completed"

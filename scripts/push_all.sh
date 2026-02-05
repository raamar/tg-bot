#!/usr/bin/env bash
set -euo pipefail

PUSH_PORT="${1:-5000}"
REGISTRY_HOST="127.0.0.1:${PUSH_PORT}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf "[%s] %s\n" "$(date +'%H:%M:%S')" "$*"
}

log "Using registry ${REGISTRY_HOST}"

build_image() {
  local name="$1"
  local dockerfile="$2"
  log "BUILD ${name}"
  docker build -t "${REGISTRY_HOST}/${name}:latest" -f "${dockerfile}" "${ROOT_DIR}"
  log "DONE  ${name}"
}

compose_build() {
  log "BUILD via docker compose"
  docker compose -f "${ROOT_DIR}/docker-compose.prod.yml" build
  log "DONE  docker compose build"
}

push_image() {
  local name="$1"
  log "PUSH  ${name}"
  docker push "${REGISTRY_HOST}/${name}:latest"
  log "DONE  ${name}"
}

COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
if rg -q "^[[:space:]]*build:" "${COMPOSE_FILE}"; then
  if ! compose_build; then
    log "docker compose build failed, switching to parallel docker build"
    build_image "bot-a-api" "${ROOT_DIR}/api/Dockerfile" &
    PID_API=$!
    build_image "bot-a-db-migrate" "${ROOT_DIR}/packages/db/Dockerfile.migrate" &
    PID_DBM=$!
    build_image "bot-a-bot" "${ROOT_DIR}/bot/Dockerfile" &
    PID_BOT=$!
    build_image "bot-a-partner-bot" "${ROOT_DIR}/partner_bot/Dockerfile" &
    PID_PBOT=$!

    wait "${PID_API}" "${PID_DBM}" "${PID_BOT}" "${PID_PBOT}"
    log "All builds completed"
  fi
else
  log "No build sections in docker-compose.prod.yml, switching to parallel docker build"
  build_image "bot-a-api" "${ROOT_DIR}/api/Dockerfile" &
  PID_API=$!
  build_image "bot-a-db-migrate" "${ROOT_DIR}/packages/db/Dockerfile.migrate" &
  PID_DBM=$!
  build_image "bot-a-bot" "${ROOT_DIR}/bot/Dockerfile" &
  PID_BOT=$!
  build_image "bot-a-partner-bot" "${ROOT_DIR}/partner_bot/Dockerfile" &
  PID_PBOT=$!

  wait "${PID_API}" "${PID_DBM}" "${PID_BOT}" "${PID_PBOT}"
  log "All builds completed"
fi

log "Starting parallel pushes"
push_image "bot-a-api" &
P1=$!
push_image "bot-a-db-migrate" &
P2=$!
push_image "bot-a-bot" &
P3=$!
push_image "bot-a-partner-bot" &
P4=$!

wait "${P1}" "${P2}" "${P3}" "${P4}"
log "All pushes completed"

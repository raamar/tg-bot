#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <ssh_alias|user@host> [ssh_port]"
  exit 1
fi

SSH_TARGET="$1"
SSH_PORT="${2:-22}"
REGISTRY_HOST="localhost:5000"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf "[%s] %s\n" "$(date +'%H:%M:%S')" "$*"
}

start_tunnel() {
  log "Opening SSH tunnel to ${SSH_TARGET}:${SSH_PORT} -> ${REGISTRY_HOST}"
  ssh -N -L 5000:127.0.0.1:5000 -p "${SSH_PORT}" -o ExitOnForwardFailure=yes "${SSH_TARGET}" &
  TUNNEL_PID=$!
  sleep 1
  if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    log "SSH tunnel failed. Check SSH alias/host and port."
    exit 1
  fi
}

stop_tunnel() {
  if [[ -n "${TUNNEL_PID:-}" ]]; then
    kill "${TUNNEL_PID}" >/dev/null 2>&1 || true
  fi
}

trap stop_tunnel EXIT

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

start_tunnel

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

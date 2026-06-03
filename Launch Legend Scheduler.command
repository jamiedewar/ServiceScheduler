#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${LEGEND_SCHEDULER_HOST:-127.0.0.1}"
PORT="${LEGEND_SCHEDULER_PORT:-4173}"
LOG_PATH="${APP_DIR}/data/launcher.log"
PID_PATH="${APP_DIR}/data/launcher.pid"

cd "$APP_DIR" || exit 1
mkdir -p data

backend_ready() {
  curl -fsS "${URL}/api/health" >/dev/null 2>&1
}

static_ready() {
  curl -fsS "${URL}/index.html" 2>/dev/null | grep -q "Legend Service Scheduler"
}

open_file_mode() {
  open "file://${APP_DIR}/index.html"
}

if ! command -v python3 >/dev/null 2>&1; then
  open_file_mode
  exit 0
fi

PORTS=("$PORT" 4180 4181 4182)
for candidate_port in "${PORTS[@]}"; do
  PORT="$candidate_port"
  URL="http://${HOST}:${PORT}"

  if backend_ready || static_ready; then
    open "$URL"
    exit 0
  fi

  python3 backend.py --host "$HOST" --port "$PORT" >> "$LOG_PATH" 2>&1 &!
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_PATH"

  for _ in {1..40}; do
    if backend_ready; then
      open "$URL"
      exit 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
done

open_file_mode

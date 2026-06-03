#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${LEGEND_SCHEDULER_HOST:-100.84.114.63}"
PORT="${LEGEND_SCHEDULER_PORT:-4173}"
URL="http://${HOST}:${PORT}"
LOG_PATH="${APP_DIR}/data/tailscale-launcher.log"
PID_PATH="${APP_DIR}/data/tailscale-launcher.pid"

cd "$APP_DIR" || exit 1
mkdir -p data

export LEGEND_SCHEDULER_AUTH="${LEGEND_SCHEDULER_AUTH:-pin}"
export LEGEND_SCHEDULER_PIN_DISPATCHER="${LEGEND_SCHEDULER_PIN_DISPATCHER:-2468}"
export LEGEND_SCHEDULER_PIN_MANAGER="${LEGEND_SCHEDULER_PIN_MANAGER:-1357}"
export LEGEND_SCHEDULER_PIN_TECHNICIAN="${LEGEND_SCHEDULER_PIN_TECHNICIAN:-1122}"
export LEGEND_SCHEDULER_PIN_ADMIN="${LEGEND_SCHEDULER_PIN_ADMIN:-9999}"
export LEGEND_SCHEDULER_SESSION_TTL_SECONDS="${LEGEND_SCHEDULER_SESSION_TTL_SECONDS:-43200}"

if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

python3 backend.py --host "$HOST" --port "$PORT" >> "$LOG_PATH" 2>&1 &!
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_PATH"

for _ in {1..40}; do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
    open "$URL"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

echo "Could not start Legend Scheduler at ${URL}."
echo "See ${LOG_PATH} for details."
read "?Press return to close."

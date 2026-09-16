#!/usr/bin/env bash
# Starts everything for local development in one go:
#   - the website (web/) on http://localhost:8765, opened in your browser
#   - the Loupe desktop app (npm run dev)
# Quit the app (or press Ctrl+C here) and the website server stops too.
#
#   ./dev_start.sh              website on port 8765
#   PORT=9000 ./dev_start.sh    website on another port
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8765}"

# A port already in use: move on to the next free one.
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ "$(uname)" = "Darwin" ] && [ ! -x bin/capture ]; then
  echo "Building the native helpers (first run only)..."
  npm run build:native
fi

echo "Website: http://localhost:$PORT"
python3 -m http.server "$PORT" --directory web >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for the server to answer, then open the site.
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.25
done
if command -v open >/dev/null 2>&1; then
  open "http://localhost:$PORT/"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$PORT/"
fi

echo "App: starting Loupe (quit it or press Ctrl+C to stop everything)"
npm run dev

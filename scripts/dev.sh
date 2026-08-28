#!/usr/bin/env bash
# Starts everything the demo needs, in one terminal, with prefixed logs.
# Ctrl-C stops all of it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill in OPENAI_API_KEY." >&2
  exit 1
fi

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "starting livekit-server (ws://localhost:7880)"
livekit-server --dev 2>&1 | sed 's/^/[livekit] /' &
pids+=($!)

echo "starting FastAPI (http://localhost:8000)"
uv run uvicorn server.main:app --port 8000 --reload 2>&1 | sed 's/^/[api]     /' &
pids+=($!)

sleep 2

echo "starting voice agent worker"
uv run python -m agent.main dev 2>&1 | sed 's/^/[agent]   /' &
pids+=($!)

echo "starting dashboard (http://localhost:3000)"
(cd web && npm run dev) 2>&1 | sed 's/^/[web]     /' &
pids+=($!)

wait

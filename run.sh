#!/usr/bin/env bash
#
# One command to bring the whole demo up.
#
#   ./run.sh          start livekit-server, the API, the voice agent, the dashboard
#   ./run.sh --seed   same, but also load a few example cases first
#
# Ctrl-C stops everything.

set -euo pipefail
cd "$(dirname "$0")"

SEED=0
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- preflight
missing=0
for tool in uv node npm livekit-server; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing: $tool" >&2
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  echo >&2
  echo "install with:" >&2
  echo "  uv:             curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  livekit-server: brew install livekit" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "no .env found. copying .env.example - set OPENAI_API_KEY in it, then rerun." >&2
  cp .env.example .env
  exit 1
fi

# `sk-...` is what .env.example ships, and the copy above is what wrote it, so
# a bare `sk-` prefix would wave the untouched placeholder straight through.
if ! grep -qE '^OPENAI_API_KEY=sk-[A-Za-z0-9_-]{20,}$' .env; then
  echo "OPENAI_API_KEY is not set to a real key in .env." >&2
  echo "The voice agent will not start without it." >&2
  exit 1
fi

echo "syncing python dependencies"
uv sync --quiet

if [ ! -d web/node_modules ]; then
  echo "installing dashboard dependencies"
  (cd web && npm install --silent)
fi

# ------------------------------------------------------------------ startup
# `$!` after `cmd | sed &` is the sed, not the service, so the old form
# recorded four colourisers and left every server running on Ctrl-C. Writing
# through a process substitution keeps the service itself as the background job.
pids=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "shutting down"
  kill "${pids[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() { # url, label, attempts
  local url="$1" label="$2" tries="${3:-40}"
  for _ in $(seq "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "$label did not come up at $url" >&2
  return 1
}

echo "starting livekit-server   ws://localhost:7880"
livekit-server --dev > >(sed $'s/^/\033[35m[livekit]\033[0m /') 2>&1 &
pids+=($!)

echo "starting api              http://localhost:8000"
uv run uvicorn server.main:app --port 8000 --reload > >(sed $'s/^/\033[36m[api]    \033[0m /') 2>&1 &
pids+=($!)

wait_for http://localhost:8000/api/health api

if [ "$SEED" -eq 1 ]; then
  echo "seeding example cases"
  uv run python scripts/seed.py
fi

echo "starting voice agent      room worker"
uv run python -m agent.main dev > >(sed $'s/^/\033[33m[agent]  \033[0m /') 2>&1 &
pids+=($!)

echo "starting dashboard        http://localhost:3000"
(cd web && npm run dev) > >(sed $'s/^/\033[32m[web]    \033[0m /') 2>&1 &
pids+=($!)

wait_for http://localhost:3000 dashboard 60 || true

cat <<'BANNER'

  ready
    staff dashboard   http://localhost:3000
    place a call      http://localhost:3000/call
    api docs          http://localhost:8000/docs

  no microphone handy? in another terminal:
    uv run python scripts/demo_rehearsal.py

BANNER

wait

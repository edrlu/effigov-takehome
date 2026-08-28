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

API_PORT=8000
WEB_PORT=3000

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

# ------------------------------------------------------- stale demo processes
# Three voice agent workers registered against one LiveKit dev server is the
# worst failure this demo has. LiveKit hands each call to whichever worker
# grabs it first, so an old checkout answers in the words it was written with,
# or nobody greets the caller at all. Nothing looks broken - you are simply
# talking to code you thought you had stopped. So a run always starts from a
# clean field.
#
# The agent is the dangerous one precisely because it holds no port. It cannot
# be found by looking at 8000 or 3000; it has to be matched as a process, and
# matched across the whole machine, because the stale worker is usually running
# out of a checkout you walked away from days ago.
#
# Everything here is deliberately narrow. No pattern is used that could match a
# program the operator merely happens to be running, and a port held by
# something this project does not recognise stops the run with instructions
# rather than being cleared.
#
# Written for bash 3.2, which is what macOS ships: no `mapfile`, and every
# `test && action` is an `if`, because under `set -e` a failing one would end
# the script.

# `pgrep -f` matches the whole argv. These are anchored on strings nothing else
# on a developer's machine runs.
AGENT_MATCH='-m[[:space:]]+agent\.main'
API_MATCH='uvicorn[[:space:]]+server\.main:app'
LIVEKIT_MATCH='livekit-server([[:space:]]|$)'
# `next dev` becomes `next-server` once it is up; both forms appear.
WEB_MATCH='next(-server|[[:space:]])'

stopped_any=0

describe_pid() { # pid -> one or two indented lines naming it
  local pid="$1" cmdline directory=""
  cmdline="$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')"
  if [ -z "$cmdline" ]; then
    return 1
  fi
  if [ -r "/proc/$pid/cwd" ]; then
    directory="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    directory="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  fi
  printf '  pid %-7s %s\n' "$pid" "$cmdline"
  # "an old checkout" is the whole diagnosis, and its directory is the only
  # thing on screen that shows it, so it gets its own line.
  if [ -n "$directory" ] && [ "$directory" != "$PWD" ]; then
    printf '  %-11s from %s\n' "" "$directory"
  fi
  return 0
}

terminate() { # label, pid...
  local label="$1"; shift
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  echo "  stopping $label"
  local pid
  for pid in "$@"; do
    describe_pid "$pid" || true
  done
  stopped_any=1

  kill "$@" 2>/dev/null || true

  # Give them a moment to close down before insisting.
  local waited=0 alive
  while [ "$waited" -lt 20 ]; do
    alive=0
    for pid in "$@"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    if [ "$alive" -eq 0 ]; then
      return 0
    fi
    sleep 0.25
    waited=$((waited + 1))
  done

  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  pid $pid ignored SIGTERM, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

matching_pids() { # regex -> pids, never this script or its parent
  local pid
  for pid in $(pgrep -f "$1" 2>/dev/null || true); do
    if [ "$pid" = "$$" ] || [ "$pid" = "${PPID:-0}" ]; then
      continue
    fi
    echo "$pid"
  done
}

port_pids() { # port -> pids listening on it
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true
}

stop_matching() { # label, regex - bash 3.2 has no mapfile, so read a line at a time
  local label="$1" pattern="$2" pid
  local found=""
  while IFS= read -r pid; do
    if [ -n "$pid" ]; then
      found="$found $pid"
    fi
  done < <(matching_pids "$pattern")
  # Unquoted on purpose: this is a list of pids, and it may be empty.
  terminate "$label" $found
}

stop_port() { # label, port
  local label="$1" port="$2" pid
  local found=""
  while IFS= read -r pid; do
    if [ -n "$pid" ]; then
      found="$found $pid"
    fi
  done < <(port_pids "$port")
  terminate "$label" $found
}

# A port holder we cannot recognise is not ours to kill.
require_port_is_ours() { # port, regex, label
  local port="$1" pattern="$2" label="$3" pid
  for pid in $(port_pids "$port"); do
    if ! ps -o args= -p "$pid" 2>/dev/null | grep -Eq "$pattern"; then
      echo >&2
      echo "port $port is held by a process this demo does not recognise:" >&2
      ps -o pid=,args= -p "$pid" >&2 2>/dev/null || true
      echo >&2
      echo "That is not the $label, so nothing was killed. Stop it yourself" >&2
      echo "(kill $pid), or free port $port, then rerun ./run.sh." >&2
      exit 1
    fi
  done
}

echo "checking for anything left over from an earlier run"

if ! command -v pgrep >/dev/null 2>&1; then
  echo "  pgrep not found: cannot check for a stale voice agent worker." >&2
  echo "  If the agent answers in the wrong words, look for a stray" >&2
  echo "  'python -m agent.main' yourself and stop it." >&2
elif ! command -v lsof >/dev/null 2>&1; then
  echo "  lsof not found: matching by process name only, not by port"
fi

# Refuse before killing anything, so an unrelated program on one of these
# ports never costs the operator the other services too.
require_port_is_ours "$API_PORT" "$API_MATCH" "api"
require_port_is_ours "$WEB_PORT" "$WEB_MATCH" "dashboard"

# The agent goes first: a worker must not pick up a call while the API it
# reports to is coming down. Matched machine-wide, since the stale one is
# typically not from this checkout.
stop_matching "voice agent worker" "$AGENT_MATCH"

# Matching `uvicorn server.main:app` catches the reloader and the worker it
# spawned. Killing only the port holder would let the reloader replace it.
stop_matching "api" "$API_MATCH"

stop_matching "livekit-server" "$LIVEKIT_MATCH"

# The dashboard is found by port, not by name: `next dev` is common enough that
# matching it across the machine could hit an unrelated project.
stop_port "dashboard" "$WEB_PORT"

if [ "$stopped_any" -eq 0 ]; then
  echo "  nothing to clean up"
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

echo "starting api              http://localhost:$API_PORT"
uv run uvicorn server.main:app --port "$API_PORT" --reload > >(sed $'s/^/\033[36m[api]    \033[0m /') 2>&1 &
pids+=($!)

wait_for "http://localhost:$API_PORT/api/health" api

if [ "$SEED" -eq 1 ]; then
  echo "seeding example cases"
  uv run python scripts/seed.py
fi

echo "starting voice agent      room worker"
uv run python -m agent.main dev > >(sed $'s/^/\033[33m[agent]  \033[0m /') 2>&1 &
pids+=($!)

echo "starting dashboard        http://localhost:$WEB_PORT"
(cd web && PORT="$WEB_PORT" npm run dev) > >(sed $'s/^/\033[32m[web]    \033[0m /') 2>&1 &
pids+=($!)

wait_for "http://localhost:$WEB_PORT" dashboard 60 || true

cat <<'BANNER'

  ready
    staff dashboard   http://localhost:3000
    place a call      http://localhost:3000/call
    api docs          http://localhost:8000/docs

  no microphone handy? in another terminal:
    uv run python scripts/demo_rehearsal.py

BANNER

wait

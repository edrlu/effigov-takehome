# Emma311: voice intake for Berkeley

A resident calls **Emma**, the automated intake line for **Berkeley 311**.
Emma works out what the problem is and where it is, then opens a case or recognises the city already has one.
Staff watch the whole call happen live.

- Service area is Berkeley, California. Anything outside it is not a case this system takes.
- Emma greets the caller first rather than waiting for them to speak.
- Emma hangs up on her own once the caller confirms they have nothing to add.

## The one idea worth understanding

Most 311 systems create one ticket per phone call, which is the wrong unit.

> A **Case** is the civic incident. A **Report** is one resident's observation of it.

- Six neighbours ringing about one pothole produce one case with six reports, not six cases.
- Corroboration is what pushes a case up the queue, because `report_count` feeds the priority score.
- Every reporter keeps their own name, callback number, and words, so a crew chief can ring any of them.
- A `Call` is a third thing: one voice session, which exists from the moment the room opens and produces at most one report.

Everything else in the system follows from that split.
See [architecture.md](architecture.md) for the argument and [database.md](database.md) for the schema.

## Setup

Prerequisites: [uv](https://docs.astral.sh/uv/getting-started/installation/), Node 20+, and `brew install livekit`.

```bash
cp .env.example .env      # then set OPENAI_API_KEY
uv sync
cd web && npm install && cd ..
```

- `OPENAI_API_KEY` is the only key you have to supply. LiveKit runs locally in dev mode with the keys already in `.env.example`.
- Geocoding uses OpenStreetMap Nominatim, which needs no key and no signup.

## Running

```bash
./run.sh --seed    # livekit-server, api, voice agent, dashboard, plus example cases
```

- `run.sh` preflights the tools it needs, syncs dependencies, starts all four processes, and stops them all on Ctrl-C.
- Drop `--seed` to start against whatever is already in `effigov.db`.
- To talk to Emma from a terminal instead of the browser: `uv run python -m agent.main console`.

## Demoing without a microphone

```bash
uv run python scripts/demo_rehearsal.py   # against a running API
uv run pytest                             # triage rules, write path, wire contract
```

- The rehearsal drives three calls: a pothole, the same pothole in different words (which merges and raises priority), and a downed power line (which escalates).
- It is the only thing that exercises phases, interim transcript deltas, the confidence gate, and `?since=` replay together.
- Open the dashboard beside it and the board moves as it runs.

## URLs

| URL | What it is |
| --- | --- |
| <http://localhost:3000> | Staff dashboard: tiles, recent cases, call volume, case mix, needs attention |
| <http://localhost:3000/call> | Resident call console: place a call and watch it get transcribed |
| <http://localhost:3000/cases/{id}> | Case detail: progress, summary, incident location map, activity |
| <http://localhost:8000/docs> | FastAPI's generated API docs |
| `ws://localhost:8000/ws?since=<seq>` | The live event stream |
| `ws://localhost:7880` | LiveKit dev server |

## Repo layout

| Path | What lives there |
| --- | --- |
| `agent/main.py` | The Emma agent: prompt, function tools, call lifecycle |
| `agent/backend.py` | Async HTTP client the agent writes every fact through |
| `server/main.py` | FastAPI app: REST handlers and the `/ws` endpoint |
| `server/store.py` | The single write choke point. Every mutation, audit row, and broadcast |
| `server/triage.py` | Routing, deduplication, priority, confidence gate. Pure functions |
| `server/geocode.py` | Berkeley-bounded Nominatim lookup, off the request path |
| `server/analytics.py` | Read-only `/api/stats` aggregations for the dashboard |
| `server/models.py` | SQLModel tables and enums |
| `server/db.py` | SQLite engine plus the additive startup migration |
| `server/hub.py` | In-process websocket fan-out with per-client backpressure |
| `web/src/app/` | Next.js App Router pages: dashboard, call console, case and call detail |
| `web/src/lib/useLiveEvents.ts` | The websocket client: cursor, resume, resync gate |
| `web/fixture/server.mjs` | Zero-dependency backend stand-in for driving the UI |
| `scripts/seed.py` | Example cases plus a fortnight of backdated history |
| `scripts/demo_rehearsal.py` | The no-microphone end-to-end demo |
| `tests/` | Triage rules, the write path, the wire contract, analytics |

## Where to read next

- **[architecture.md](architecture.md)** - the three processes, the event protocol, where policy lives, and the honest limitations.
- **[database.md](database.md)** - every table, column, enum, index, and which code path writes it.

# EffiGov take-home: 311 voice intake

A resident calls an AI agent, the agent opens and fills in a service request while they talk, and city staff watch the case appear and change in real time on a dashboard.

## Architecture

```
browser mic ──▶ LiveKit room ──▶ voice agent (OpenAI Realtime)
                                        │ function tools (HTTP)
                                        ▼
                                  FastAPI + SQLite
                                        │ websocket fan-out
                                        ▼
                                 Next.js dashboard
```

Three processes, one database, one source of truth.

The agent holds no state of its own.
Every fact it collects is written straight to the backend through a function tool, so the dashboard and the database can never disagree about what the caller said.

Every write goes through `server/store.py`, which does three things atomically: update the row, append an `Event` row to the audit log, and broadcast the change on the websocket hub.
That single choke point is why the audit trail is complete and why the dashboard never has to poll.

The agent opens a case *early*, as soon as it knows roughly what the problem is, then PATCHes fields onto it as the caller supplies them.
A PATCH only carries fields that actually moved, and the backend broadcasts the list of changed field names, so the dashboard can highlight exactly what just changed rather than re-rendering the whole record.

## Data model

- `Case` - the durable unit of work: caller, issue type, description, status, priority, notes, summary.
- `Call` - one voice session, optionally attached to a case. A call can exist before a case does.
- `Turn` - one transcript line in a call.
- `Event` - append-only audit log: which field changed, from what, to what, by whom.

Separating `Call` from `Case` is what makes the live view work.
The call record appears in the dashboard the moment the room opens, before the agent knows whether this is a new report or a status check.

## Setup

Prerequisites: [uv](https://docs.astral.sh/uv/getting-started/installation/), Node 20+, and `brew install livekit`.

```bash
cp .env.example .env      # then set OPENAI_API_KEY
uv sync
cd web && npm install && cd ..
```

## Running

```bash
./scripts/dev.sh          # livekit-server + api + agent worker + dashboard
uv run python scripts/seed.py   # optional: a few cases so the list is not empty
```

Then open <http://localhost:3000> for the staff dashboard and <http://localhost:3000/call> to place a call.

To test the agent without a browser, talk to it straight from the terminal:

```bash
uv run python -m agent.main console
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/cases` | Create a case |
| GET | `/api/cases?q=&status=` | List and filter cases |
| GET | `/api/cases/lookup?identifier=` | Find by case number or phone, used by the agent |
| GET | `/api/cases/{id}` | One case |
| PATCH | `/api/cases/{id}` | Partial update, one audit event per changed field |
| POST | `/api/cases/{id}/notes` | Append a timestamped note |
| GET | `/api/cases/{id}/events` | Audit log |
| POST | `/api/calls` | Start a call record |
| PATCH | `/api/calls/{id}` | Attach a case, end the call, store the summary |
| POST | `/api/calls/{id}/turns` | Append a transcript line |
| POST | `/api/token` | Mint a LiveKit join token for the browser |
| WS | `/ws` | Live stream of every case, call, and transcript change |

## Agent tools

| Tool | What it does |
| --- | --- |
| `open_request` | Opens a case as soon as the problem is understood |
| `update_request` | Patches name, phone, address, description, issue type, priority |
| `look_up_request` | Finds an existing case by case number or phone |
| `add_case_note` | Appends a note |
| `set_status` | Moves the case between new, in_progress, needs_info, resolved |

## Tradeoffs

Chosen deliberately for a three hour build:

- SQLite with SQLModel, no migrations. The schema is created on startup.
- One in-process websocket hub instead of Redis pub/sub. Correct for a single-process demo, and the only thing that would change under multiple workers is the transport behind `hub.publish`.
- OpenAI Realtime as one speech-to-speech model rather than a separate STT, LLM, and TTS chain. Fewer moving parts and fewer API keys, at the cost of provider lock-in and less control over each stage.
- No auth on the dashboard or the API. This is a localhost demo.
- The call summary is generated once at hangup with a small model, not streamed.

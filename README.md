# EffiGov take-home: 311 voice intake

A resident calls an AI agent.
The agent works out what the problem is and where, and either opens a case or recognises that the city already has one.
Staff watch all of it happen live in a dashboard.

## The idea worth stealing

Most 311 systems create one ticket per phone call.
Cities do not have a call problem, they have a pothole problem: six people ring about the same pothole and a crew gets dispatched six times, or five reports sit unread behind the first.

So the model here separates the two:

> A **Case** is the civic incident. A **Report** is one resident's observation of it.

Everything interesting follows from that single distinction.
A second caller describing the same pothole does not create a second case, it attaches a second report to the first one, and that corroboration is what pushes the case up the queue.
Both residents keep their own callback number and their own words, so a crew chief can ring either of them.

## Architecture

```
browser mic ──▶ LiveKit room ──▶ voice agent (OpenAI Realtime)
                                        │ typed function tools (HTTP)
                                        ▼
                                  FastAPI + SQLite
                                    │        │
                        deterministic triage │ websocket fan-out
                        (route / dedupe /    ▼
                         prioritise)   Next.js dashboard
```

Three processes, one database, one source of truth.

**The agent holds no state of its own.**
Every fact it collects is written straight to the backend through a function tool, so the dashboard and the database can never disagree about what the caller said.

**The model reasons, the backend decides.**
The language model runs the conversation and extracts intent.
It never decides which department owns a pothole, whether two callers are describing the same one, or how urgent the result is.
Those live in `server/triage.py` as pure functions a city could read, argue with, and change without touching a prompt.
They are also the only part of the system with real unit tests, because they are the part with real policy in them.

**Every write goes through `server/store.py`**, which does three things together: update the row, append an `Event` to the audit log, and broadcast the change on the websocket hub.
That single choke point is why the audit trail is complete and why the dashboard never has to poll.

**The agent files early and patches often.**
It calls `file_report` as soon as it knows what and where, then PATCHes name, phone, and detail onto the case as the caller supplies them.
A PATCH carries only the fields that actually moved, and the backend broadcasts the list of changed field names, so the dashboard highlights exactly what just changed instead of re-rendering the record.

## Data model

```
Case                     Report                  Call            Event
  case_number              case_id                 room            case_id
  issue_type               call_id                 case_id         kind
  department               reporter_name           report_id       field
  location                 reporter_phone          status          old_value
  description              description             summary         new_value
  status                   created_at              started_at      actor
  priority                                         ended_at        created_at
  priority_score
  report_count
  escalated
  summary
```

- `Case` - one civic incident, no matter how many people report it.
- `Report` - one resident's account, and how to reach them.
- `Call` - one voice session. Produces at most one report. Exists from the moment the room opens, which is why a call shows up in the dashboard before anyone knows what it is about.
- `Event` - append-only audit log: which field changed, from what, to what, by whom.

## The three rules in `server/triage.py`

**Routing.** Issue type maps to a department. A corrected issue type re-routes the case automatically and logs a `case.routed` event.

**Deduplication.** A new report merges into an open case when the issue type matches, the case is not resolved, it was opened within 30 days, and the locations overlap.
Locations are compared as sets of identifying words with street suffixes and filler stripped, so "Shattuck and University" and "University Ave and Shattuck" score 1.0.
The threshold is deliberately conservative: a false merge hides a resident's report, which is worse than a duplicate case.

**Priority.** `severity x 10 + 15 per corroborating report + 1 per day of age (capped at 10) + 50 if escalated`.
Three inputs a public works supervisor would actually accept, and the score is shown in the UI so the ranking is legible rather than magic.
A second reporter on a pothole is enough to move it from normal to high.

**Escalation.** If a caller describes an immediate danger, the agent calls `escalate_to_human`, which flags the case, pins it to the top of the queue, and lights up the dashboard.
This is the state change, not a dispatch integration.

## Setup

Prerequisites: [uv](https://docs.astral.sh/uv/getting-started/installation/), Node 20+, and `brew install livekit`.

```bash
cp .env.example .env      # then set OPENAI_API_KEY
uv sync
cd web && npm install && cd ..
```

## Running

```bash
./run.sh --seed    # livekit-server, api, voice agent, and dashboard, with example cases
```

Staff dashboard at <http://localhost:3000>, resident call page at <http://localhost:3000/call>.

To talk to the agent without a browser:

```bash
uv run python -m agent.main console
```

To prove the whole flow works before a demo, with no microphone:

```bash
uv run python scripts/demo_rehearsal.py   # two calls, one merge, one escalation
uv run pytest                             # triage rules and the write path
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/reports` | File a report. Opens a case or merges into one. Returns `merged` |
| PATCH | `/api/reports/{id}` | Attach the reporter's name and callback number |
| GET | `/api/cases?q=&status=` | The queue, ordered by priority score |
| GET | `/api/cases/lookup?identifier=` | Find by case number or any reporter's phone |
| GET | `/api/cases/{id}` | One case |
| PATCH | `/api/cases/{id}` | Partial update, one audit event per changed field |
| GET | `/api/cases/{id}/reports` | Every resident who reported this incident |
| POST | `/api/cases/{id}/escalate` | Flag for human review |
| POST | `/api/cases/{id}/notes` | Append a timestamped note |
| GET | `/api/cases/{id}/events` | Audit log |
| POST | `/api/calls` | Start a call record |
| PATCH | `/api/calls/{id}` | Attach a case, end the call, store the summary |
| POST | `/api/calls/{id}/turns` | Append a transcript line |
| POST | `/api/token` | Mint a LiveKit join token for the browser |
| WS | `/ws` | Live stream of every case, call, report, and transcript change |

## Agent tools

| Tool | What it does |
| --- | --- |
| `file_report` | Files the report as soon as the problem and place are known. Tells the agent whether it merged |
| `update_request` | Patches the reporter's name and number, and the case's location, description, and type |
| `look_up_request` | Finds an existing case by case number or phone |
| `add_case_note` | Appends a note |
| `escalate_to_human` | Flags an immediate danger for human review |
| `set_status` | Moves the case between new, in_progress, needs_info, resolved |

## The dashboard under motion

`web/` is a Next.js App Router client that keeps one websocket per tab
(`web/src/lib/useLiveEvents.ts`) and treats the stream as something to be
trusted, not merely displayed.

- **A cursor, not a firehose.**
  Every data frame carries a gap-free `seq`.
  The tab remembers the last one it applied, reconnects with `?since=<seq>`, and drops any frame that is not newer, so a replayed frame is idempotent.
- **A resync gate.**
  When the server answers `hello` with `resume: false`, or sends `resync_required`, local state is wrong rather than stale.
  The socket buffers incoming frames, asks every subscriber to refetch its REST snapshot, and only then flushes the buffer in `seq` order - so a frame that lands mid-refetch is not overwritten by the older snapshot it raced.
- **An honest indicator.**
  `Live`, `Catching up` and `Reconnecting` are distinct states in the top nav, and while the feed is down the indicator says how stale the data is and offers an immediate retry.
  A socket that opens but never sends a contract-shaped `hello` is treated as dead, not as live.
- **Rows that do not jump.**
  Live updates always change the contents of a row; they only change its *order* when nobody is reading.
  While the pointer or focus is inside the table, a reorder or an arriving case is withheld and surfaced as a pill in the gap above the table, so nothing slides out from under a click and nothing shifts to say so.
- **Edits that survive their own echo.**
  A field with a staff PATCH in flight is locally owned until the PATCH resolves, so the websocket echo of the pre-edit value cannot undo what the user just did.
- **Streaming transcript.**
  `transcript.delta` renders as a provisional italic line with the interim marker in the timestamp column; the matching `transcript.turn` replaces it in place at the same `(call_id, turn_seq)`.
  The view follows the tail, but never yanks a reader who has scrolled up - it offers "Jump to latest" instead.

Every animation is behind `prefers-reduced-motion`, and each state that motion conveys is also carried by colour, border or text.

### Driving the dashboard without the backend

`web/fixture/server.mjs` is a zero-dependency stand-in that serves the REST
snapshots and streams contract-v1 frames, including the outbox, `?since=`
replay and the control frames.
It exists because killing a real backend mid-call is not a repeatable test.

```bash
node web/fixture/server.mjs --port 8010
cd web && NEXT_PUBLIC_API_URL=http://localhost:8010 \
  NEXT_PUBLIC_WS_URL=ws://localhost:8010/ws npm run dev
```

| Endpoint | What it does |
| --- | --- |
| `GET /fixture/scenario?step=250` | Run one call end to end, at the given delta cadence |
| `GET /fixture/burst` | File a duplicate report against the newest case |
| `GET /fixture/drop` | Kill every socket but keep the outbox, exercising `?since=` replay |
| `GET /fixture/resync` | Push `resync_required`, exercising the resync gate |

## Tradeoffs

Chosen deliberately for a three hour build:

- SQLite with SQLModel, no migrations. The schema is created on startup.
- One in-process websocket hub instead of Redis pub/sub. Correct for a single process, and the only thing that changes under multiple workers is the transport behind `hub.publish`.
- Deduplication is lexical, not semantic. No embeddings and no geocoder. It is explainable, instant, testable, and offline, which matters more here than catching "the big hole by the Safeway". A geocoder plus a radius check is the obvious production upgrade.
- OpenAI Realtime as one speech-to-speech model rather than a separate STT, LLM, and TTS chain. Fewer moving parts and one API key, at the cost of provider lock-in.
- No auth on the dashboard or the API. This is a localhost demo.
- The call summary is generated once at hangup with a small model, not streamed.

In production the next things would be Postgres with real migrations, a durable event log rather than an in-process hub, idempotency keys on report filing, auth and RBAC on the dashboard, PII handling for the recordings and transcripts, and a human review queue behind the escalation flag rather than just a red banner.

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

**The live stream is durable and resumable.**
Every frame is written to an `Outbox` row and committed *before* it is broadcast, and that row's primary key is the frame's `seq`: strictly increasing, gap-free, and unchanged by a restart of the API.
A dashboard reconnects with `/ws?since=<last seq it saw>` and gets back exactly the frames it missed, replayed from the stored JSON rather than re-derived from current rows, because a replay is history and not a fresh snapshot.
When it asks for something the server can no longer provide - a `since` from a rebuilt database, or one older than the retained window - the server says `resume: false` and the client refetches over REST instead of trusting state it cannot verify.

**One slow dashboard is its own problem.**
Each websocket connection owns a bounded queue drained by its own writer task, so a client on a bad network backs up alone instead of stalling the broadcast for everyone else and for the voice agent's writes.
When its queue overflows the server drops that client's backlog, sends `resync_required`, and leaves the socket open.
A dropped frame is recoverable; a stalled broadcast is not.

**The agent files early and patches often.**
It calls `file_report` as soon as it knows what and where, then PATCHes name, phone, and detail onto the case as the caller supplies them.
A PATCH carries only the fields that actually moved, and the backend broadcasts the list of changed field names, so the dashboard highlights exactly what just changed instead of re-rendering the record.
A PATCH where nothing moved publishes no frame at all, so the agent re-sending what it already saved is silent rather than a flicker on the board.

## Data model

```
Case                       Report            Call        Turn       Event      Outbox
  case_number                case_id           room        call_id    case_id    seq
  issue_type                 call_id           case_id     turn_seq   kind       type
  issue_type_confidence      reporter_name     report_id   role       field      ts
  department                 reporter_phone    status      text       old_value  frame
  location                   description       phase       created_at new_value
  description                created_at        summary                actor
  status                                       started_at             created_at
  priority                                     ended_at
  priority_score
  report_count
  escalated
  summary
```

- `Case` - one civic incident, no matter how many people report it.
- `Report` - one resident's account, and how to reach them.
- `Call` - one voice session. Produces at most one report. Exists from the moment the room opens, which is why a call shows up in the dashboard before anyone knows what it is about.
- `Turn` - one *final* line of transcript, numbered per call by `turn_seq`. Interim speech is never stored.
- `Event` - append-only audit log: which field changed, from what, to what, by whom. Every row is streamed as it is written, so the timeline fills in without refetching.
- `Outbox` - append-only log of every frame broadcast, and the ordering truth for the live stream.

`Case.status` and `Call.status` are the coarse lifecycles. `Call.phase` - `greeting, gathering, filed, wrapping, ended` - is the fine-grained progression staff actually watch, and the voice agent drives it as the conversation moves.

### Transcript, as it is being spoken

A `Turn` is durable and final. Interim speech is not: it is a guess the recognizer is still revising, so it is broadcast as a `transcript.delta` frame carrying the `turn_seq` the eventual final turn will use, and then forgotten.
The dashboard renders the delta as a provisional line and replaces it when the `transcript.turn` with the same `(call_id, turn_seq)` arrives.
A delta always carries the whole utterance so far rather than an incremental suffix, because a revised guess can be *shorter* than the one before it, and a client that concatenates would end up with a sentence the caller never said.

### Migrating an existing database

`init_db` runs an additive migration before `create_all`: it reads each table's columns and `ALTER TABLE ADD COLUMN`s the ones the running code expects but an older file lacks, then backfills them.
A call that already hung up gets `phase = ended` rather than the default, and old turns recover their `turn_seq` from their insertion order.

Additive rather than "delete the file and start again", because `effigov.db` is gitignored but it is also the demo's memory: wiping it on every schema change throws away the cases a rehearsal just built.
Nothing is dropped or rewritten, so an old database keeps working and a downgrade loses no data. Full migrations are a Postgres-and-Alembic problem, and this is deliberately not that.

## The rules in `server/triage.py`

**Routing.** Issue type maps to a department. A corrected issue type re-routes the case automatically and logs a `case.routed` event.

**Deduplication.** A new report merges into an open case when the issue type matches, the case is not resolved, it was opened within 30 days, and the locations overlap.
Locations are compared as sets of identifying words with street suffixes and filler stripped, so "Shattuck and University" and "University Ave and Shattuck" score 1.0.
The threshold is deliberately conservative: a false merge hides a resident's report, which is worse than a duplicate case.

**Priority.** `severity x 10 + 15 per corroborating report + 1 per day of age (capped at 10) + 50 if escalated`.
Three inputs a public works supervisor would actually accept, and the score is shown in the UI so the ranking is legible rather than magic.
A second reporter on a pothole is enough to move it from normal to high.

**Classification confidence.** The agent reports how sure it is of the category, from 0.0 to 1.0, and below `ISSUE_TYPE_CONFIDENCE_THRESHOLD` (0.6) the backend refuses to apply it.
The case keeps `issue_type: null`, stores the confidence, and routes to `unassigned` until a confident classification lands - at which point it re-routes itself.
A case the city knows it cannot yet categorise is a different thing from one nobody has looked at, and the dashboard can tell them apart.
Dispatching a sanitation crew to a water leak costs more than leaving a case unclassified for another minute, and the agent's tool docstrings tell it to report a low number honestly rather than always claiming certainty.

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
| POST | `/api/calls/{id}/turns` | Append a final transcript line |
| GET | `/api/calls/{id}/turns` | The transcript, ordered by `turn_seq` |
| POST | `/api/calls/{id}/interim` | Broadcast a partial utterance. Stores nothing |
| POST | `/api/token` | Mint a LiveKit join token for the browser |
| WS | `/ws?since=<seq>` | Live stream, resumable. See below |

`POST /api/reports` and `PATCH /api/cases/{id}` both take an optional `issue_type_confidence` alongside `issue_type`.
`PATCH /api/calls/{id}` takes `phase`.

### The websocket contract

Every frame is exactly `{"v": 1, "seq": 128, "ts": "...", "type": "...", "payload": {...}}`.
`hello`, `pong`, and `resync_required` are control frames and carry `"seq": null`; only replayable data frames consume a sequence number.

The first frame is always `hello`. With `resume: true` it carries `from`/`to` and every frame in that range follows immediately in ascending `seq` order, before any new live frame.
With `resume: false` the client discards local state and refetches its snapshots over REST.
The client may send `{"type":"ping"}` and gets a `pong` back; any other client frame is ignored rather than treated as an error, so a newer dashboard cannot take its own connection down.

| `type` | `payload` |
| --- | --- |
| `case.created` | the `Case` |
| `case.updated` | `{case, changed: [...]}` - never empty; no frame at all when nothing moved |
| `case.escalated` | the `Case` |
| `report.filed` | `{report, case, merged, similarity}` |
| `report.updated` | `{report, case_id, changed: [...]}` |
| `call.started` | the `Call` |
| `call.updated` | `{call, changed: [...]}` - a phase change is always its own frame |
| `transcript.turn` | the `Turn`, a final utterance |
| `transcript.delta` | `{call_id, turn_seq, role, text, final: false}` - replace, never concatenate |
| `event.appended` | the `Event` audit row |

## Agent tools

| Tool | What it does |
| --- | --- |
| `file_report` | Files the report as soon as the problem and place are known. Tells the agent whether it merged, and whether its confidence was too low to categorise |
| `update_request` | Patches the reporter's name and number, and the case's location, description, type, and category confidence |
| `look_up_request` | Finds an existing case by case number or phone |
| `add_case_note` | Appends a note |
| `escalate_to_human` | Flags an immediate danger for human review |
| `set_status` | Moves the case between new, in_progress, needs_info, resolved |
| `set_call_phase` | Tells the dashboard where the conversation has got to |
| `end_call` | Hangs up once the caller has confirmed they are finished, after the closing line has played |

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

- SQLite with SQLModel, and an additive `ALTER TABLE` migration on startup rather than Alembic. Enough to keep an existing local database working across a schema change; not enough to rename or drop anything.
- One in-process websocket hub instead of Redis pub/sub. Correct for a single process, and because the durable ordering lives in the `Outbox` table rather than in the hub, the only thing that changes under multiple workers is who tails that table.
- The outbox keeps its most recent 2000 frames. Roughly an hour of a busy call centre: long enough that a laptop lid closed over lunch still resumes, short enough that the table stays small. Past that the client refetches, which is a slower path but never a wrong one.
- livekit-agents 1.7 exposes interim transcription for the caller (`user_input_transcribed` with `is_final: false`) but has no public interim event for the agent's own speech, so the agent side emits one delta per utterance immediately before its final turn. The dashboard renders both speakers identically either way.
- Deduplication is lexical, not semantic. No embeddings and no geocoder. It is explainable, instant, testable, and offline, which matters more here than catching "the big hole by the Safeway". A geocoder plus a radius check is the obvious production upgrade.
- OpenAI Realtime as one speech-to-speech model rather than a separate STT, LLM, and TTS chain. Fewer moving parts and one API key, at the cost of provider lock-in.
- No auth on the dashboard or the API. This is a localhost demo.
- The call summary is generated once at hangup with a small model, not streamed.

In production the next things would be Postgres with real migrations, the outbox tailed by more than one process, idempotency keys on report filing, auth and RBAC on the dashboard, PII handling for the recordings and transcripts, and a human review queue behind the escalation flag rather than just a red banner.

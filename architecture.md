# Emma311: architecture

The system is three processes over one database, and every fact the voice agent learns is written straight through to it.

- This document is the argument; [README.md](README.md) is the setup guide and [database.md](database.md) is the schema.
- The agent is **Emma**, the service is **Berkeley 311**, and the service area is **Berkeley, California**. She greets first and hangs up herself.

## 1. The modelling insight

Cities do not have a call problem, they have a pothole problem.

> A **Case** is the civic incident. A **Report** is one resident's observation of it.

| Consequence | Mechanism |
| --- | --- |
| Deduplication | A second caller attaches a `Report` to the open `Case`, not a new case |
| Corroboration raises priority | `report_count` feeds the score, moving a pothole from normal to high |
| Every caller keeps their callback | Name, phone, and description live on the `Report` |
| Staff see a call before it has a subject | `Call` is separate, and exists from the moment the room opens |
| One resolution date survives edits | The transition to `resolved` is an `Event`, not a column |

- A `Call` produces at most one `Report`, so six calls about one pothole are one `Case`, six `Report` rows, and six `Call` rows.

## 2. Three processes

System topology. Solid hops are the request path; the dashboard hop is the live stream.

```mermaid
flowchart LR
  Mic[Browser mic] -->|audio| Room[LiveKit room]
  Room -->|audio| Agent[Voice agent Emma]
  Agent -->|HTTP function tools| API[FastAPI]
  API --> DB[(SQLite)]
  API -->|websocket| Web[Next.js dashboard]
  Web -->|HTTP REST| API
  API -->|HTTP| Nominatim[OSM Nominatim]
```

- **The agent holds no state of its own.** Every fact goes to the backend through a function tool, so the dashboard and the database cannot disagree.
- **The model reasons, the backend decides.** The language model runs the conversation and extracts intent; it never decides routing, deduplication, or urgency.
- **One database is the source of truth,** and the dashboard reads the same rows the agent wrote.

## 3. Where policy lives

`server/triage.py` holds pure functions with no database, no network, and no model call, so a city can read and change them without touching a prompt.

| Rule | Policy |
| --- | --- |
| Routing | Issue type maps to a department. A corrected type re-routes and logs `case.routed` |
| Deduplication | Merge when the issue type matches, the case is open, it is under 30 days old, and location Jaccard overlap is >= 0.5 |
| Priority | `severity x 10 + 15 per corroborating report + 1 per day of age (capped at 10) + 50 if escalated`, banded high at 35 and normal at 15 |
| Confidence gate | An `issue_type` is applied only at confidence >= 0.6, otherwise the case keeps `issue_type: null` and routes to `unassigned` |

- Location comparison strips street suffixes and filler, so "Shattuck and University" scores 1.0 against "University Ave and Shattuck".
- The dedupe threshold is conservative on purpose: a false merge hides a resident's report, which is worse than a duplicate case.
- A confidence of `None` means nobody measured it, so a staffer's typed category is taken at face value; only a stated low number is refused.

## 4. The single write choke point

Every mutation goes through `server/store.py`, which updates the row, appends an `Event`, and publishes a frame as one unit.

- No handler mutates a model directly, which is why the audit trail is complete and the dashboard never polls.
- Audit frames are published before the domain frame, so a client applying frames in order sees the reasons before the result.
- `case.updated`, `call.updated`, and `report.updated` each carry a non-empty `changed` list, and when nothing moved no frame is published at all.
- That is what makes "file early, patch often" cheap: a repeated identical PATCH is silent rather than a flicker on the board.

## 5. One call, end to end

Emma files as soon as she knows what and where, then patches as she learns.

```mermaid
sequenceDiagram
  participant C as Caller
  participant A as Emma
  participant S as store.py
  participant D as Dashboard
  A->>C: greets first
  C->>A: describes problem
  A->>S: file_report
  S->>S: dedupe, route, price
  S-->>D: report.filed
  A->>S: update_request
  S-->>D: case.updated
  A->>C: reads case number
  A->>S: end_call, summary
  S-->>D: call.updated phase ended
```

- `file_report` returns whether the report opened a case or merged into one, and Emma must tell the caller which. Every arrow into `store.py` also writes an `Event`, which streams as `event.appended`.

## 6. The live event protocol

The failure this design prevents: a dashboard that has quietly lost its connection while still showing confident data.

- Every frame is exactly `{"v": 1, "seq": 128, "ts": "...", "type": "case.updated", "payload": {...}}`, with `seq` strictly increasing and gap-free. Control frames (`hello`, `pong`, `resync_required`) carry `seq: null`.
- **Durable outbox.** Each data frame is written as an `Outbox` row and committed *before* broadcast, and `seq` is that row's primary key, so ordering survives an API restart.
- The outbox stores the serialized frame and keeps the most recent 2000 rows, so a replay is history rather than a fresh snapshot of current rows.
- **Resume.** The client connects to `/ws?since=<seq>`; the first frame is always `hello`.

| `hello` says | Client does |
| --- | --- |
| `resume: true`, `from`/`to` | Missed frames arrive in ascending `seq` order, then live traffic |
| `resume: false` | Discard local state, refetch snapshots over REST |

- `resume: false` is returned when `since` is absent, negative, ahead of the server, or older than the retained window. The client ignores any frame whose `seq` is not greater than the last it applied, so a replayed frame is idempotent.
- **Backpressure.** Each client has a bounded 256-frame queue drained by its own writer task. On overflow the server drops that client's backlog, sends `resync_required`, and keeps the socket open.

| `type` | `payload` |
| --- | --- |
| `case.created` | the `Case` |
| `case.updated` | `{case, changed}` - never empty |
| `case.escalated` | the `Case` |
| `report.filed` | `{report, case, merged, similarity}` |
| `report.updated` | `{report, case_id, changed}` |
| `call.started` | the `Call` |
| `call.updated` | `{call, changed}` - a phase change is always its own frame |
| `transcript.turn` | the `Turn`, a final utterance |
| `transcript.delta` | `{call_id, turn_seq, role, text, final: false}` - replace, never concatenate |
| `event.appended` | the `Event` audit row |

- A delta carries the full text so far and the `turn_seq` the final turn will use, because a revised guess can be shorter than the one before it.

## 7. Call and case lifecycle

`Call.status` is the coarse lifecycle; `phase` is what staff actually watch.

Call phase progression, driven by Emma.

```mermaid
stateDiagram-v2
  [*] --> greeting
  greeting --> gathering: collecting details
  gathering --> filed: report filed
  filed --> wrapping: reading case number
  wrapping --> ended: hangup
  ended --> [*]
```

Case status, common path. Staff can set any status, and reopening is allowed.

```mermaid
stateDiagram-v2
  [*] --> new
  new --> needs_info: detail missing
  new --> in_progress: summary written
  needs_info --> in_progress: detail supplied
  in_progress --> resolved: staff closes
  resolved --> [*]
```

- `Call.status` is only `active` or `completed`, and completing always forces `phase = ended` in the backend, so a crash cannot leave a call looking live.
- *When* a case reached `resolved` lives only in the audit log; `updated_at` moves for any edit and cannot date a fix.

## 8. Location resolution

The caller's words are kept, and the coordinates are best effort.

- Geocoding is **OpenStreetMap Nominatim**, bounded to Berkeley with `countrycodes=us` and a `viewbox` with `bounded=1`. A bare street or intersection gets `, Berkeley, CA` appended first.
- It runs **off the request path** as a background task, so a tool call never blocks on the network, and results are cached by normalized query text.
- The result is written through `store.py` like any other change, arriving as `case.updated` with the location fields in `changed`.
- `location_precision` is the honest part: `exact` for a house number or intersection, `approximate` for something vague that still resolves to a point, `unresolved` when nothing did.
- Failure is never visible to the caller: keep the text, set `unresolved`, log it, move on.

## 9. What staff see

Three surfaces, all driven by one websocket client (`web/src/lib/useLiveEvents.ts`).

| Surface | Panels |
| --- | --- |
| Dashboard | Four stat tiles with sparklines, recent cases, call volume, cases by type, needs attention |
| Call console | Call controls, extracted information, current call, live transcript, case activity |
| Case detail | Progress stepper, case summary, AI collected details, resident, incident location map, activity timeline |

- Tiles and charts come from `/api/stats/*`, which aggregates existing rows with nothing cached or precomputed.
- Rows change contents live but change *order* only when nobody is reading: a reorder is withheld while the pointer or focus is in the table, and surfaced as a pill.
- A field with a staff PATCH in flight is locally owned until it resolves, so the websocket echo of the pre-edit value cannot undo the edit.

## 10. Honest limitations

- **Interim transcription is one-sided.** The installed `livekit-agents` exposes interim transcription for the caller and none for the agent's own speech, so the caller's words stream mid-utterance while Emma's arrive one utterance at a time.
- **Deduplication is lexical.** Geocoding informs the map, not the merge, so "the big hole by the Safeway" still misses; merging on a radius is the obvious upgrade.
- **One process, no broker.** The outbox makes ordering durable, but fan-out is in-process; under multiple workers only the notify path has to change.
- **SQLite, no migration tool.** `init_db` runs an additive `ALTER TABLE ADD COLUMN` pass with backfills, which keeps a local database working but cannot rename or drop anything.
- **No auth on the API or the dashboard.** Transcripts and callback numbers are PII stored in the clear.
- **Escalation is a state change, not a dispatch,** and a retried tool call files a second report because there are no idempotency keys.

## 11. Testing

Tested where there is real policy or a real invariant.

| Suite | Covers |
| --- | --- |
| `tests/test_triage.py` | Routing, location matching, the dedupe guards, the priority formula and bands |
| `tests/test_api.py` | Deduplication end to end, corroboration, re-routing, escalation, an audit row per change |
| `tests/test_live.py` | Monotonic gap-free `seq`, replay, `resume: false`, slow-consumer resync, `changed` accuracy |
| `tests/test_analytics.py` | The `/api/stats` shapes, including resolution time read from the audit log |

- Not tested: the model's conversational behaviour and the browser UI. Prompt behaviour is not a stable assertion; the UI is verified by driving the real dashboard with `scripts/demo_rehearsal.py`. Next in production: Postgres with real migrations, merging on a geocoded radius, idempotency keys on report filing, and auth with a review queue behind the escalation flag.

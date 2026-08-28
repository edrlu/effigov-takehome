# EffiGov 311: architecture brief

A resident calls an AI agent.
The agent works out what the problem is and where, then opens a case or recognises the city already has one.
Staff watch the whole call happen live.

This document is the spine of the walkthrough.
The README is the setup guide; this is the argument.

## 1. The modelling insight

Most 311 systems create one ticket per phone call.
Cities do not have a call problem, they have a pothole problem.
Six callers about one pothole either dispatch six crews or bury five reports behind the first.

> A **Case** is the civic incident. A **Report** is one resident's observation of it.

Everything below falls out of that one split.

| Consequence | Mechanism |
| --- | --- |
| Deduplication | A second caller attaches a `Report` to the open `Case`, not a new case |
| Corroboration raises priority | `report_count` feeds the score, so the second caller moves a pothole from normal to high |
| Every caller keeps their own callback | Name, phone, and description live on the `Report`, so a crew chief can ring any of them |
| Every caller keeps their own words | Each `Report` carries that resident's description; the case keeps the canonical one |

`Call` is the third entity, and it is separate on purpose.
A call exists from the moment the room opens, which is why staff see a call before anyone knows what it is about.
A call produces at most one report.

## 2. Architecture

```
browser mic ──▶ LiveKit room ──▶ voice agent (OpenAI Realtime)
                                        │ typed function tools (HTTP)
                                        ▼
                                  FastAPI + SQLite
                                    │        │
                        deterministic triage │ durable outbox
                        (route / dedupe /    │ + websocket fan-out
                         prioritise)         ▼
                                      Next.js dashboard
```

Three processes, one database, one source of truth.

**The agent holds no state of its own.**
Every fact it collects is written straight to the backend through a function tool.
The dashboard and the database cannot disagree about what the caller said, because there is nowhere else for the truth to live.

**The model reasons, the backend decides.**
The language model runs the conversation and extracts intent.
It never decides which department owns a pothole, whether two callers mean the same one, or how urgent the result is.

## 3. Where policy lives

`server/triage.py` holds four pure functions with no database, no network, and no model call.
A city could read them, argue with them, and change them without touching a prompt.

| Rule | Policy |
| --- | --- |
| Routing | Issue type maps to a department. A corrected type re-routes and logs `case.routed` |
| Deduplication | Merge when the issue type matches, the case is open, it is under 30 days old, and location Jaccard overlap is >= 0.5. Street suffixes and filler words are stripped, so "Shattuck and University" scores 1.0 against "University Ave and Shattuck" |
| Priority | `severity x 10 + 15 per corroborating report + 1 per day of age (capped at 10) + 50 if escalated`. The score is shown in the UI, so the ranking is legible rather than magic |
| Classification confidence | An `issue_type` is applied only at confidence >= 0.6. Below that the case stores the confidence, keeps `issue_type: null`, and routes to `unassigned` until a confident answer lands |

The dedupe threshold is deliberately conservative.
A false merge hides a resident's report, which is worse than a duplicate case.

## 4. The single write choke point

Every mutation goes through `server/store.py`.
It does three things as one unit: update the row, append an `Event` to the audit log, publish a frame.

No handler mutates a model directly.
That is the entire reason the audit trail is complete and the dashboard never polls.

## 5. Real time: the part that has to be trustworthy

The failure mode this design exists to prevent: **a dashboard that has quietly lost its connection while still showing confident data.**
A staffer reading a stale queue does not know they are reading a stale queue.
Every mechanism below is aimed at that one problem.

### Envelope

```json
{"v": 1, "seq": 128, "ts": "2026-08-28T18:00:00.123456+00:00", "type": "case.updated", "payload": {}}
```

`seq` is strictly increasing and gap-free across the server.
Control frames (`hello`, `pong`, `resync_required`) carry `seq: null`; only replayable data frames consume a number.

### Durable outbox

Every data frame is written as an `Outbox` row **before** it is broadcast, and `seq` is that row's primary key.
The database, not process memory, is the ordering authority.

That buys two things.
Ordering survives an API restart, so `seq` does not reset and a reconnecting dashboard is not silently handed a fresh numbering.
And the outbox stores the serialized frame, so a replay is history rather than a fresh snapshot of current rows.

The outbox is trimmed to the most recent 2000 rows on write.
A demo does not need an unbounded log, and an unbounded log would be a lie about retention.

### Resume and resync

The client connects to `/ws?since=<seq>`.
The first frame is always `hello`.

| `hello` says | Client does |
| --- | --- |
| `resume: true`, `from`/`to` | Missed frames arrive immediately in ascending `seq` order, then live traffic resumes |
| `resume: false` | Discard local state and refetch snapshots over REST |

`resume: false` is returned when `since` is absent, invalid, ahead of the server, or older than the retained window.
The client ignores any frame whose `seq` is not greater than the last it applied, so a duplicated replay is idempotent.

### Per-client backpressure

Each websocket client gets a bounded 256-frame queue drained by its own writer task.
One slow dashboard cannot stall the fan-out for the other dashboards, or for the voice agent's writes.

On overflow the server drops that client's backlog, sends `resync_required`, and keeps the socket open.
A slow consumer is degraded, never disconnected, and never quietly starved.

### Accurate `changed`, no-ops suppressed

`case.updated`, `call.updated`, and `report.updated` each carry a non-empty list of the field names that actually moved.
When nothing moved, no frame is published at all.

This is what makes the agent's "file early, patch often" pattern cheap.
The agent files a report as soon as it knows what and where, then PATCHes name, phone, and a better location as the caller supplies them.
The dashboard highlights exactly the fields that changed instead of re-rendering the record, and a repeated identical PATCH is silent instead of a flicker.

## 6. What a staffer sees during one call

| Moment | Frame | Dashboard |
| --- | --- | --- |
| Room opens | `call.started` | The call appears before anyone knows what it is about |
| Resident speaks | `transcript.delta` | A provisional line, visibly not final |
| Utterance ends | `transcript.turn` | The provisional line is replaced in place by the durable turn |
| Agent guesses the category | `case.updated` | Low confidence shows as "still classifying", not an empty field |
| Confidence crosses 0.6 | `case.updated` | The issue type fills in and the case re-routes to a real department |
| Report filed | `report.filed` | New case, or a merge with its similarity score |
| Throughout | `call.updated` | Phase moves `greeting -> gathering -> filed -> wrapping -> ended` |
| Every change | `event.appended` | The audit timeline streams instead of refetching |

Transcript deltas carry the full text so far, not a suffix, and carry the `turn_seq` the final turn will use.
The client replaces, it never concatenates, so a dropped delta cannot corrupt a line.

`Call.status` (`active | completed`) stays the coarse lifecycle.
`phase` is the fine-grained progression staff actually watch.
Case status also moves more than once in a call: `new` at filing, `in_progress` when the agent closes out with a summary.

The agent is Emma, on the Berkeley 311 line.
It greets first rather than waiting for the caller to speak.

## 7. Honest limitations

- **Interim transcription is one-sided.** The installed `livekit-agents` 1.7.1 exposes `user_input_transcribed` with `is_final=false` for the caller, and has no equivalent for the agent's own speech. The caller's words stream mid-utterance; the agent's arrive one utterance at a time.
- **Deduplication is lexical.** No embeddings, no geocoder. It is explainable, instant, and offline, and it will miss "the big hole by the Safeway". A geocoder plus a radius check is the obvious upgrade.
- **One process, no broker.** The outbox makes ordering durable, but the fan-out is still in-process. Under multiple workers the outbox stays correct and only the notify path behind it has to change.
- **SQLite, no migration tool.** The schema is created on startup. Fine for a demo, not for a second deployment.
- **No auth on the API or the dashboard.** This is a localhost demo. Transcripts and callback numbers are PII and are stored in the clear.
- **Escalation is a state change, not a dispatch.** It flags the case and pins it to the top of the queue. There is no pager on the other end.
- **The call summary is generated once at hangup** with a small model, and is not streamed.

## 8. Testing

Tested, because these are the parts with real policy or a real invariant in them:

- **Triage rules** (`tests/test_triage.py`). Routing, location matching, the four dedupe guards, the priority formula and its bands. Pure functions, no database, no network, no model.
- **The write path** (`tests/test_api.py`). Deduplication end to end, corroboration raising priority, re-routing on a corrected issue type, escalation pinning the queue, and an audit row for every change.
- **The wire contract.** Monotonic gap-free `seq`, replay returning exactly the missed frames in order, `resume:false` past the retention window, a slow consumer getting `resync_required` without harming other clients, `changed` accuracy including the suppressed no-op, the confidence gate on both sides of 0.6, and `turn_seq` monotonicity per call.

Not tested: the model's conversational behaviour, and the browser UI.
Prompt behaviour is not a stable assertion, and the UI is verified by driving the real dashboard with `scripts/demo_rehearsal.py`.

## 9. Running it

```bash
./run.sh --seed                            # livekit, api, agent, dashboard, example cases
uv run python scripts/demo_rehearsal.py    # the whole story with no microphone
uv run pytest
```

- Staff dashboard: <http://localhost:3000>
- Resident call page: <http://localhost:3000/call>
- API docs: <http://localhost:8000/docs>

The rehearsal script drives three calls against the running backend: a pothole, the same pothole in different words (which merges and raises priority), and a downed power line (which escalates).
It exercises phase transitions and interim deltas too, so the dashboard can be demonstrated without speaking to it.

## 10. What comes next

- **Postgres and real migrations**, because the outbox is the one table that must never be recreated on startup.
- **Geocode the location and merge on a radius**, because lexical overlap cannot match a landmark to an address.
- **Idempotency keys on report filing**, because a retried tool call currently files a second report.
- **Auth, RBAC, and a review queue behind the escalation flag**, because a red banner is not an assignment.

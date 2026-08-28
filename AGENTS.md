# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

**A commit inside the publish path must not expire the caller's objects.**
`server/store.py` writes an `Outbox` row and commits it *after* the domain change is already committed. A plain `session.commit()` there expires every loaded instance, and SQLModel's `model_dump()` reads `__dict__` directly, so a serialized model silently becomes `{}` - the handler returns an empty body and the broadcast frame is empty too, with no error anywhere. Use `_commit_without_expiring`.

For the same reason `_log` snapshots each `Event` with `serialize` at write time rather than holding the instance until publish: the caller's own commit would expire it first.

**Frames a websocket test asserts on must be fenced, not slept on.**
`{"type":"ping"}` is queued through the same per-client writer as data frames, so a `pong` can only arrive after everything published before it. `tests/test_live.py::read_until_quiet` uses that; a bare `receive_json()` with nothing pending blocks forever and hangs the suite.

**When a case was resolved is only in the audit log.**
`Case.updated_at` moves for any edit, so it cannot date a fix.
The transition is recorded as an `Event` with `kind="case.updated"`, `field="status"`, `new_value="resolved"`, and `server/analytics.py` reads exactly that shape.
Anything that writes a resolution outside `store.update_case` - `scripts/seed.py` does - has to write that event too, or the case silently drops out of the resolution-time average.

## Commands

- `uv run pytest` - the whole suite.
- `uv run python scripts/demo_rehearsal.py` against a running API - the end-to-end demo, and the only thing that exercises phases, interim deltas, the confidence gate, and `?since=` replay together.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

**A commit inside the publish path must not expire the caller's objects.**
`server/store.py` writes an `Outbox` row and commits it *after* the domain change is already committed. A plain `session.commit()` there expires every loaded instance, and SQLModel's `model_dump()` reads `__dict__` directly, so a serialized model silently becomes `{}` - the handler returns an empty body and the broadcast frame is empty too, with no error anywhere. Use `_commit_without_expiring`.

For the same reason `_log` snapshots each `Event` with `serialize` at write time rather than holding the instance until publish: the caller's own commit would expire it first.

**Geocoding is off by default in the suite, and must stay that way.**
`server/geocode.py` runs as a FastAPI background task that opens its own `Session(server.db.engine)` - not the test-overridden one - so an un-gated geocode in a test both reaches the network and writes to the developer's own `effigov.db`. `tests/conftest.py` sets `EFFIGOV_GEOCODE=0` for the whole suite; a test that wants the real path re-enables it and stubs `geocode._fetch`.

**A call is linked to its case through the report, not always through `Call.case_id`.**
`GET /api/cases/{id}/calls` returns nothing for a call whose `case_id` was never backfilled, even though the call produced a report on that case. Anything that needs the transcript or the call duration for a case has to fall back to the newest report's `call_id`; `web/src/components/case/CasePage.tsx` does exactly that.

**Frames a websocket test asserts on must be fenced, not slept on.**
`{"type":"ping"}` is queued through the same per-client writer as data frames, so a `pong` can only arrive after everything published before it. `tests/test_live.py::read_until_quiet` uses that; a bare `receive_json()` with nothing pending blocks forever and hangs the suite.

**When a case was resolved is only in the audit log.**
`Case.updated_at` moves for any edit, so it cannot date a fix.
The transition is recorded as an `Event` with `kind="case.updated"`, `field="status"`, `new_value="resolved"`, and `server/analytics.py` reads exactly that shape.
Anything that writes a resolution outside `store.update_case` - `scripts/seed.py` does - has to write that event too, or the case silently drops out of the resolution-time average.

**A panel that follows its own tail must ignore its own scroll events.**
Setting `scrollTop` fires a `scroll` event a frame later, by which time more rows may have landed and pushed the bottom further away.
Judging "has the reader scrolled up?" from that stale event unpins the panel permanently after the first burst, and it silently stops following.
`web/src/lib/useTailFollow.ts` remembers the offset it scrolled to and treats an event still sitting there as its own; use it rather than hand-rolling the effect again.

**There is one bar, and a page fills its title slot rather than drawing its own.**
`web/src/components/TopNav.tsx` is the product's only header row: brand, nav, the current page's title, its one action, and the live indicator.
A page pushes its title and action in with `<PageBar title=... action={{href, label}} />` (`web/src/components/PageBar.tsx`); it must not add a header row of its own.
The action is plain data, not a node, because a JSX node is a new object every render and would make `PageBar`'s effect fire forever.

**The call console is one fixed-height row, and every panel in it holds its rectangle.**
`CONSOLE_H` in `web/src/app/call/page.tsx` is the natural height of the merged call panel, which is the tallest column; the other two stretch to it.
Nothing on that page may grow as data arrives, so each block inside `CallPanel` is `shrink-0` with a fixed height and each list scrolls internally.
Without `shrink-0` the flex column silently squeezes every block instead of overflowing - the symptom is text clipped mid-glyph, not a scrollbar.
Changing the panel's content means re-measuring it in a browser and updating `CONSOLE_H`.

**A frame handler cannot read a ref that only updates on render.**
`call.started` and the `event.appended` announcing it are dispatched in the same task, so a handler that decides ownership from a ref assigned during render sees the previous value and drops the event.
`web/src/lib/useCallConsole.ts` assigns those refs inside the handler that adopts the call, not in the render body.

## Commands

- `uv run pytest` - the whole suite.
- `uv run python scripts/demo_rehearsal.py` against a running API - the end-to-end demo, and the only thing that exercises phases, interim deltas, the confidence gate, and `?since=` replay together.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

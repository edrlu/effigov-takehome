# Emma311: what was tested

What was actually run, what was checked by hand, and what was not tested at all.
Read this against the repository; where the two disagree, the repository is right.

## Automated tests

`uv run pytest` - 65 tests, all passing, in about half a second.

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/test_triage.py` | 19 | Routing per issue type, location matching (word order, street suffixes, empty), the four dedupe guards, and the priority formula and bands, all as pure functions |
| `tests/test_live.py` | 29 | Sequenced frames, restart, `?since=` replay and its four refusals, slow-consumer resync, `changed` accuracy, phases, the confidence gate, and `turn_seq` with interim deltas |
| `tests/test_api.py` | 8 | A report opening a routed case, a second caller merging and raising priority, both residents surviving, lookup by either phone, re-routing, escalation, an audit row per change, server-side phone formatting |
| `tests/test_geocode.py` | 6 | Query building, the Berkeley bound, precision classification from what Nominatim matched, and a failure leaving the case usable |
| `tests/test_analytics.py` | 3 | An empty database returning zeroes rather than errors, resolution time read from the audit event, and the case-mix tail folding into `Other` |

- The suite runs with `EFFIGOV_GEOCODE=0`, so no test reaches the network. `tests/test_geocode.py` re-enables the path and stubs the fetch.
- **HTTP failure paths are not asserted in pytest.** No test checks a 404 or a 422; those were checked by hand in the backend sweep below.
- **There are no frontend tests and no test harness in `web/`.** This was a time-box decision, not an oversight.
- **There is no CI.** Nothing runs on push, so the count above is only as current as the last local run.

## End-to-end verification

Two full sweeps were run by hand against the merged code. Both passed.

### Backend sweep

| Area | Verified |
| --- | --- |
| Endpoints | All four required endpoints including failure paths: missing records return 404, bad input 422, never a 500 |
| The call path | Call starts, case created, fields patched as the agent learns them, a second caller merged into the existing case rather than duplicated, priority rose with corroboration, summary written on hangup |
| Agent contract | The confidence gate holds at 0.3 and reclassification at 0.95 re-routes; lookup works by case number and by phone in formatted and raw form; escalation and notes work; hanging up sets the call completed with an end time |
| Live stream | Sequence numbers monotonic and gap-free, `?since=` replay byte-identical, reconnect converges, `changed` lists accurate, a no-op update publishes nothing |
| Data integrity | Zero orphan rows, resolution events present |
| Migration | A legacy database upgrades additively and keeps serving reads and writes |
| Geocoding | Never blocks intake - a case was created in 0.016s with the geocoder unreachable - and has a kill switch |

### Browser sweep

| Area | Verified |
| --- | --- |
| Core flow | End to end with no manual refresh, the required dashboard behaviours, and staff edits persisting and being audited |
| Stretch goal | The call appears as it starts, the transcript streams, the issue type resolves from 0.35 to 0.94, and the status changes three times in one interaction |
| Reconnection | With the API killed the dashboard showed an amber reconnecting state with a staleness count rather than silently stale data; on return it converged, picked up the case created during the outage, and produced zero duplicate rows |
| Console | Clean on every page |

## Defects those sweeps found

Six real defects, each found by the sweeps above and fixed in its own pull request.

| Defect | Fixed in |
| --- | --- |
| Fifteen open dashboards exhausted the database connection pool and hung the entire REST API, because the websocket held a connection for the life of the browser tab | #9 |
| `run.sh` accepted the placeholder API key it had just written, and Ctrl-C left all four servers holding their ports because the captured process id was the log formatter, not the service | #13 |
| Seeded cases had no reporter row and an overstated report count, so the case page showed a blank resident and an audit trail that opened mid-story | #14 |
| Error surfaces rendered the raw JSON envelope at the user instead of the message | #15 |
| The call page was unreachable from the UI after the dashboard rebuild, making the Live Calls tile a dead end | #18 |
| The seed left calls active forever, so the console displayed a phantom connected call | #17 |

## Not tested

- **A real microphone LiveKit voice session.** Token minting was verified; a live realtime session was never run.
- **The full four-service `./run.sh` launch on its default ports.** Each service was verified individually instead.
- **Any frontend unit or integration testing.** See above.

## Code and pull request quality

19 pull requests: 17 merged, one closed as superseded (#16), and one left open after its work was rebased and merged as #12 (#8).

- Every change shipped as its own pull request with a single purpose and a real description.
- The earliest changes went through an automated review pipeline. Once the time box tightened, later ones shipped on a passing suite plus the browser and API sweeps above. That was a deliberate tradeoff, and not every PR got the same treatment.
- Three structural choices are what make the code checkable at all, and they are why the suites above are short:
  - Policy is isolated as pure functions in `server/triage.py`, with no database, network, or model call, so routing, deduplication, priority, and the confidence gate are testable as arithmetic.
  - Every mutation goes through one choke point in `server/store.py`, which writes the audit row and broadcasts the frame in the same unit, so "is it audited?" is not a per-handler question.
  - The live stream is a durable outbox, so replay is a range scan over rows a test can assert on rather than a race against a socket.

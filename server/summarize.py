"""Keep a case's summary describing the incident, not whoever rang last.

A case is the thing staff work. It has to read as the whole problem - what was
reported, where, and what several residents said about it - without anybody
opening five reports to piece it together. So every time another resident
contributes, the summary is rewritten across *all* of their accounts rather
than overwritten with the newest call.

Three things make that safe to do on a live intake line.

*It is never on the request path.* Summarising is a model call. A resident on
the phone must not wait on it, and filing a report must not fail because the
provider was slow or down. Like ``server.geocode``, this runs as a background
task after the response has gone out, opens its own session, and never raises
into a caller. A case whose summary is a minute stale is fine; a case that
could not be filed is not.

*It is debounced.* Three neighbours calling inside a minute is one incident
getting three reports, not three summaries worth writing. A regeneration
already queued for a case absorbs the ones behind it.

*It is off by default in tests.* ``EFFIGOV_SUMMARY=0`` keeps a process from
reaching the model at all, the same switch ``EFFIGOV_GEOCODE`` gives geocoding
and for the same reason: a background thread must not reach the network or
write to a developer's own database from the suite.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from fastapi import BackgroundTasks
from sqlmodel import Session, select

from server.models import Case, Report

logger = logging.getLogger("effigov.summarize")

MODEL = "gpt-4o-mini"

# A case with one account is that account; there is nothing to reconcile, and
# the call's own summary already says it.
MIN_REPORTS = 2

# How long a queued regeneration waits for the rest of a burst to land.
DEBOUNCE_SECONDS = 20.0

SYSTEM_PROMPT = (
    "Summarize a 311 case for the city staffer who will work it. Several "
    "residents have reported the same incident. Say what the problem is, "
    "where it is, what the accounts agree on, and - if they disagree about "
    "anything - say so plainly rather than choosing between them. Three "
    "sentences at most, no preamble, and do not name the callers."
)

_lock = threading.Lock()
# case id -> the wall clock time its queued regeneration will run at. A case
# already waiting is not queued twice; the wait is simply extended.
_queued: dict[int, float] = {}


def enabled() -> bool:
    """Set ``EFFIGOV_SUMMARY=0`` to keep a process off the model entirely."""
    return os.getenv("EFFIGOV_SUMMARY", "1").lower() not in ("0", "false", "no")


def schedule(background: BackgroundTasks, case: Case | None) -> None:
    """Queue a summary regeneration to run after the response has been sent.

    Nothing filing a report waits for this. If a regeneration for this case is
    already waiting, this one joins it rather than starting a second: a burst
    of neighbours produces one summary, written once the burst is over.
    """
    if case is None or case.id is None or not enabled():
        return
    due = time.monotonic() + DEBOUNCE_SECONDS
    with _lock:
        if case.id in _queued:
            # Extend the existing wait instead of racing it.
            _queued[case.id] = due
            return
        _queued[case.id] = due
    background.add_task(regenerate, case.id)


def regenerate(case_id: int) -> None:
    """Wait out the debounce, then rewrite one case's summary. Never raises."""
    from server.db import engine  # imported here to keep this module importable alone

    try:
        while True:
            with _lock:
                due = _queued.get(case_id)
            if due is None:
                return
            remaining = due - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(remaining, DEBOUNCE_SECONDS))

        with _lock:
            _queued.pop(case_id, None)

        accounts = _accounts(engine, case_id)
        if accounts is None:
            return
        summary = _write(accounts)
        if not summary:
            return
        _store(engine, case_id, summary)
    except Exception:
        # A summary is a convenience. Losing one must not mark the case, retry
        # forever, or surface anywhere near the resident who triggered it.
        logger.exception("could not regenerate the summary for case %s", case_id)
        with _lock:
            _queued.pop(case_id, None)


def _accounts(engine, case_id: int) -> list[str] | None:
    """One line per resident's account, or ``None`` if there is nothing to do.

    The session is opened and closed here rather than held across the model
    call: by the time this runs the request that triggered it is long finished,
    and a call that can take seconds has no business holding a pooled
    connection.
    """
    with Session(engine) as session:
        case = session.get(Case, case_id)
        if case is None:
            return None
        reports = session.exec(
            select(Report).where(Report.case_id == case_id).order_by(Report.created_at)
        ).all()
        if len(reports) < MIN_REPORTS:
            return None

        lines = [
            f"Case as recorded: {case.issue_type.value if case.issue_type else 'unclassified'}"
            f" at {case.location or 'an unrecorded location'}."
            f" {case.description or ''}".strip()
        ]
        for index, report in enumerate(reports, start=1):
            said = report.description or "no description given"
            where = f" Location as given: {report.location}." if report.location else ""
            kind = f" Called it: {report.issue_type.value}." if report.issue_type else ""
            lines.append(f"Resident {index}: {said}.{where}{kind}")
        contested = case.contested_fields
        if contested:
            lines.append(f"The residents do not agree about: {contested}.")
        return lines


def _write(accounts: list[str]) -> str:
    """One completion. Separated so a test can stub the model out."""
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(accounts)},
        ],
    )
    return (response.choices[0].message.content or "").strip()


def _store(engine, case_id: int, summary: str) -> None:
    """Write it through the store, so it audits and broadcasts like anything else."""
    from server import store

    with Session(engine) as session:
        case = session.get(Case, case_id)
        if case is None:
            return
        store.update_case(session, case, {"summary": summary}, actor="system")

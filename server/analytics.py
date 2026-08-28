"""Read-only aggregations behind the staff dashboard.

Every number here is derived from rows that already exist: cases, calls, and
the audit ``Event`` log. Nothing is cached and nothing is precomputed, which
keeps the dashboard honest at the cost of a few table scans - the right trade
at 311 volumes, and an easy one to revisit behind these same response shapes.

Two decisions worth stating, because they are policy rather than plumbing:

* **"Resolved" comes from the audit log, not from ``updated_at``.** A case row
  only records the status it is in now; ``updated_at`` moves for any edit, so a
  note added a week after the fix would inflate the resolution time. The
  ``Event`` row that recorded the transition to ``resolved`` is the only record
  of *when* it happened. A case with no such event is excluded from the average
  rather than guessed at.
* **Series are dense.** A day with no activity is a zero bucket. A sparkline
  drawn from sparse data lies about its own shape, because the gaps close up
  and a quiet week looks like a busy one.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from server.db import get_session
from server.models import (
    Call,
    CallStatus,
    Case,
    CaseStatus,
    Department,
    Event,
    IssueType,
    Priority,
    utcnow,
)

router = APIRouter(prefix="/api/stats", tags=["stats"])

# How many slices the donut keeps before the tail is folded into "Other".
TOP_TYPE_SLICES = 5

SERIES_DAYS = 7


# --------------------------------------------------------------------------
# Time helpers
#
# SQLite gives back naive datetimes even for values written as aware ones, so
# everything read from the database goes through ``_aware`` before it is
# compared against ``utcnow()``.
# --------------------------------------------------------------------------


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _day_of(value: datetime) -> date:
    return _aware(value).astimezone(timezone.utc).date()


def _end_of(day: date) -> datetime:
    """The instant a UTC day closes, for "as of end of day" questions."""
    return datetime.combine(day, time.max, tzinfo=timezone.utc)


def _day_window(days: int, *, ending: date) -> list[date]:
    """``days`` consecutive dates ending on ``ending``, oldest first."""
    return [ending - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def _percent_change(current: float, previous: float) -> float:
    """Change from ``previous`` to ``current``, in percent.

    Growth from nothing has no defined percentage, so a previous window of zero
    reports 0% when nothing happened either and 100% when something did. That
    is a readable tile rather than an infinity or a crash.
    """
    if previous == 0:
        return 0.0 if current == 0 else 100.0
    return round((current - previous) / previous * 100, 1)


# --------------------------------------------------------------------------
# Case history reconstructed from the audit log
# --------------------------------------------------------------------------


def _resolved_at(session: Session) -> dict[int, datetime]:
    """First moment each case reached ``resolved``, per the audit trail.

    The *first* transition, not the last: a case reopened and resolved again
    was still fixed the first time, and taking the later event would quietly
    charge the second round trip to the original report.
    """
    events = session.exec(
        select(Event)
        .where(Event.kind == "case.updated")
        .where(Event.field == "status")
        .where(Event.new_value == CaseStatus.resolved.value)
        .order_by(Event.created_at.asc())
    ).all()

    first: dict[int, datetime] = {}
    for event in events:
        if event.case_id is None or event.case_id in first:
            continue
        first[event.case_id] = _aware(event.created_at)
    return first


def _escalated_at(session: Session) -> list[datetime]:
    events = session.exec(select(Event).where(Event.kind == "case.escalated")).all()
    return [_aware(e.created_at) for e in events]


# --------------------------------------------------------------------------
# GET /api/stats/summary
# --------------------------------------------------------------------------


def _open_series(cases: list[Case], resolved: dict[int, datetime], days: list[date]) -> list[int]:
    """Cases open at the close of each day in ``days``.

    Open at time *t* means: created by *t*, and not resolved by *t*. A case
    resolved yesterday therefore still counts in every bucket before that,
    which is what makes the sparkline a backlog trend rather than a snapshot
    repeated seven times.
    """
    series = []
    for day in days:
        edge = _end_of(day)
        series.append(
            sum(
                1
                for case in cases
                if _aware(case.created_at) <= edge
                and not (case.id in resolved and resolved[case.id] <= edge)
            )
        )
    return series


def _counts_per_day(moments: list[datetime], days: list[date]) -> list[int]:
    buckets: dict[date, int] = defaultdict(int)
    for moment in moments:
        buckets[_day_of(moment)] += 1
    return [buckets[day] for day in days]


def _resolution_days(case: Case, resolved_at: datetime) -> float:
    return max((resolved_at - _aware(case.created_at)).total_seconds(), 0.0) / 86400.0


def _tile(value, change, series: list[int] | list[float]) -> dict:
    return {"value": value, "change": change, "series": series}


@router.get("/summary")
def summary(session: Session = Depends(get_session)) -> dict:
    """The four headline tiles, each with its own seven-day sparkline."""
    now = utcnow()
    today = now.date()
    days = _day_window(SERIES_DAYS, ending=today)

    cases = list(session.exec(select(Case)).all())
    calls = list(session.exec(select(Call)).all())
    resolved = _resolved_at(session)

    # --- open cases -------------------------------------------------------
    open_series = _open_series(cases, resolved, days)
    open_now = sum(1 for case in cases if case.status != CaseStatus.resolved)
    open_yesterday = open_series[-2] if len(open_series) >= 2 else 0

    # --- live calls -------------------------------------------------------
    # The tile is a snapshot of what is on the line right now; the sparkline is
    # calls started per day, because "how many were live at 3pm last Tuesday"
    # is not something the call rows can answer after the fact.
    # ``change`` here is calls started today against yesterday, not a delta of
    # the snapshot: "two fewer people on the line than at this moment
    # yesterday" is not a number the call rows can support.
    live_now = sum(1 for call in calls if call.status == CallStatus.active)
    call_series = _counts_per_day([_aware(c.started_at) for c in calls], days)

    # --- average resolution time -----------------------------------------
    by_case = {case.id: case for case in cases}
    durations = [
        (moment, _resolution_days(by_case[case_id], moment))
        for case_id, moment in resolved.items()
        if case_id in by_case
    ]

    def _mean(values: list[float]) -> float:
        return round(sum(values) / len(values), 2) if values else 0.0

    window_start = _end_of(days[0] - timedelta(days=1))
    previous_start = window_start - timedelta(days=SERIES_DAYS)
    this_window = [d for moment, d in durations if moment > window_start]
    prior_window = [d for moment, d in durations if previous_start < moment <= window_start]

    per_day: dict[date, list[float]] = defaultdict(list)
    for moment, duration in durations:
        per_day[_day_of(moment)].append(duration)
    resolution_series = [_mean(per_day[day]) for day in days]

    # --- escalations ------------------------------------------------------
    escalations = _escalated_at(session)
    escalation_series = _counts_per_day(escalations, days)
    escalated_now = sum(1 for case in cases if case.escalated)
    today_escalations = escalation_series[-1] if escalation_series else 0
    yesterday_escalations = escalation_series[-2] if len(escalation_series) >= 2 else 0

    return {
        "as_of": now.isoformat(),
        "days": [day.isoformat() for day in days],
        "open_cases": _tile(open_now, open_now - open_yesterday, open_series),
        "live_calls": _tile(live_now, call_series[-1] - call_series[-2] if len(call_series) >= 2 else 0, call_series),
        "avg_resolution_days": _tile(
            _mean([d for _, d in durations]),
            round(_mean(this_window) - _mean(prior_window), 2),
            resolution_series,
        ),
        "escalations": _tile(
            escalated_now,
            today_escalations - yesterday_escalations,
            escalation_series,
        ),
        # How much of the average is actually measured. A dashboard that says
        # "3.1 days" should be able to say how many cases it asked.
        "resolved_sample": len(durations),
    }


# --------------------------------------------------------------------------
# GET /api/stats/call-volume
# --------------------------------------------------------------------------


@router.get("/call-volume")
def call_volume(
    days: int = Query(default=7, ge=1, le=90),
    session: Session = Depends(get_session),
) -> dict:
    """Calls per day over the window, against the window before it."""
    today = utcnow().date()
    window = _day_window(days, ending=today)
    previous_window = _day_window(days, ending=window[0] - timedelta(days=1))

    starts = [_aware(c.started_at) for c in session.exec(select(Call)).all()]
    counts = _counts_per_day(starts, window)
    previous_counts = _counts_per_day(starts, previous_window)

    total = sum(counts)
    previous_total = sum(previous_counts)

    return {
        "days": days,
        "total": total,
        "previous_total": previous_total,
        "change_pct": _percent_change(total, previous_total),
        "buckets": [
            {"date": day.isoformat(), "count": count} for day, count in zip(window, counts)
        ],
    }


# --------------------------------------------------------------------------
# GET /api/stats/cases-by-type
# --------------------------------------------------------------------------

_TYPE_LABELS: dict[IssueType, str] = {
    IssueType.missed_collection: "Missed collection",
    IssueType.pothole: "Pothole",
    IssueType.streetlight: "Streetlight",
    IssueType.noise_complaint: "Noise complaint",
    IssueType.water_leak: "Water leak",
    IssueType.graffiti: "Graffiti",
    IssueType.other: "Other",
}


@router.get("/cases-by-type")
def cases_by_type(session: Session = Depends(get_session)) -> dict:
    """Case mix, with the long tail folded into a single ``Other`` slice.

    A donut with eleven slices is a colour chart, not a finding. Everything
    past the top few categories is folded together, and so are the cases the
    classifier was never confident enough to label - those are genuinely
    "other" from a dispatcher's point of view, not a category of their own.
    """
    counts: dict[IssueType | None, int] = defaultdict(int)
    for case in session.exec(select(Case)).all():
        counts[case.issue_type] += 1

    total = sum(counts.values())

    named = sorted(
        ((issue, count) for issue, count in counts.items() if issue and issue != IssueType.other),
        key=lambda pair: (-pair[1], pair[0].value),
    )
    head = named[:TOP_TYPE_SLICES]
    tail = sum(count for _, count in named[TOP_TYPE_SLICES:])
    other = tail + counts.get(IssueType.other, 0) + counts.get(None, 0)

    def _pct(count: int) -> float:
        return round(count / total * 100, 1) if total else 0.0

    slices = [
        {
            "issue_type": issue.value,
            "label": _TYPE_LABELS.get(issue, issue.value),
            "count": count,
            "percentage": _pct(count),
        }
        for issue, count in head
    ]
    if other:
        slices.append(
            {
                "issue_type": IssueType.other.value,
                "label": "Other",
                "count": other,
                "percentage": _pct(other),
            }
        )

    return {"total": total, "slices": slices}


# --------------------------------------------------------------------------
# GET /api/stats/needs-attention
# --------------------------------------------------------------------------


@router.get("/needs-attention")
def needs_attention(session: Session = Depends(get_session)) -> dict:
    """Queues a supervisor can actually act on, each backed by a real query.

    Only groups that are non-empty are worth a supervisor's eye, but they are
    all returned regardless: a card that disappears reads as a bug, while a
    card showing zero reads as "nothing to do here", which is the truth.
    """
    open_cases = list(
        session.exec(select(Case).where(Case.status != CaseStatus.resolved)).all()
    )

    unrouted = [
        c for c in open_cases if c.priority == Priority.high and c.department == Department.unassigned
    ]
    escalated = [c for c in open_cases if c.escalated]
    unlocatable = [c for c in open_cases if not (c.location or "").strip()]

    groups = [
        {
            "key": "high_priority_unassigned",
            "count": len(unrouted),
            "title": "High priority, no department",
            "detail": "Top of the queue with nobody to work it - route these first.",
            "case_numbers": [c.case_number for c in unrouted[:5]],
        },
        {
            "key": "escalated_unresolved",
            "count": len(escalated),
            "title": "Escalated and still open",
            "detail": "Flagged for immediate human review and not closed out yet.",
            "case_numbers": [c.case_number for c in escalated[:5]],
        },
        {
            "key": "missing_location",
            "count": len(unlocatable),
            "title": "Missing a location",
            "detail": "No address on the case, so no crew can be dispatched to it.",
            "case_numbers": [c.case_number for c in unlocatable[:5]],
        },
    ]

    return {"total": sum(g["count"] for g in groups), "groups": groups}

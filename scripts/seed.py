"""Drop realistic data into the database so the dashboard is not empty.

Two passes, for two different reasons:

1. **Today's reports go through ``/api/reports``**, so the seeded data exercises
   the same deduplication path a real call would rather than sidestepping it.
2. **A fortnight of history is written straight to the database.** The REST API
   has no way to file a report *last Tuesday*, and it should not - backdating is
   not something a live intake system ought to be able to do. But the dashboard
   charts are trend charts, and a trend needs a past, so the backfill writes
   cases, resolution events, escalations, and calls with the timestamps they
   would have had, including the audit ``Event`` rows the analytics read to
   date a resolution.

Run it against a running API: ``uv run python scripts/seed.py``.
"""

from __future__ import annotations

import os
import random
import sys
from datetime import timedelta
from pathlib import Path

# Run as ``python scripts/seed.py``, which puts scripts/ on the path rather
# than the repo root. The backfill needs the real models, so put the root back.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from server.db import engine, init_db  # noqa: E402
from server.models import (  # noqa: E402
    Call,
    CallPhase,
    CallStatus,
    Case,
    CaseStatus,
    Event,
    IssueType,
    Report,
    Sentiment,
    new_case_number,
    utcnow,
)
from server.triage import priority_band, priority_score, route  # noqa: E402

# Same variable the voice agent and the rehearsal use.
BASE = os.getenv("BACKEND_URL", "http://localhost:8000")

# Fixed so a rehearsal twice in a row produces the same shaped charts.
RNG = random.Random(311)

HISTORY_DAYS = 14

# Lets a rerun recognise its own work, so seeding twice does not double the
# charts. An audit row rather than a field on the case: the marker is a fact
# about the seeding, not about the incident.
SEED_MARK = "seed.backfill"

# How many trailing BACKLOG entries are the deliberately awkward ones.
SPECIAL_CASES = 4

REPORTS = [
    {
        "reporter_name": "Marcus Webb",
        "reporter_phone": "5105550142",
        "location": "1420 Chestnut St",
        "issue_type": "missed_collection",
        "description": "Green waste bin was not emptied on Tuesday, third week in a row.",
    },
    {
        "reporter_name": "Dana Ortiz",
        "reporter_phone": "4155550119",
        "location": "88 Marina Blvd",
        "issue_type": "streetlight",
        "description": "Streetlight out in front of the building, the whole block is dark.",
    },
    {
        "reporter_name": "Priya Raman",
        "reporter_phone": "5105550188",
        "location": "Telegraph Ave and Dwight Way",
        "issue_type": "graffiti",
        "description": "Tagging across the side of the transit shelter.",
    },
]

# (issue type, location, description). Weighted the way a real 311 queue is:
# a lot of bins and potholes, a handful of leaks.
BACKLOG = [
    (IssueType.missed_collection, "2210 Ward St", "Recycling left at the curb since Monday."),
    (IssueType.missed_collection, "1719 Addison St", "Whole street was skipped on collection day."),
    (IssueType.missed_collection, "500 El Cerrito Plaza", "Compost bin never emptied."),
    (IssueType.missed_collection, "3040 Adeline St", "Bins still full two days later."),
    (IssueType.missed_collection, "1200 University Ave", "Missed pickup, bins blocking the sidewalk."),
    (IssueType.missed_collection, "77 Solano Ave", "Green bin skipped again this week."),
    (IssueType.pothole, "Sacramento St near Dwight Way", "Deep pothole, two cars pulled over with flats."),
    (IssueType.pothole, "Ashby Ave and Shattuck Ave", "Sinking patch in the right lane."),
    (IssueType.pothole, "1900 Sixth St", "Pothole widening after the rain."),
    (IssueType.pothole, "Gilman St under the overpass", "Crater in the bike lane, unrideable."),
    (IssueType.pothole, "College Ave and Alcatraz Ave", "Broken asphalt across the crosswalk."),
    (IssueType.streetlight, "Milvia St and Allston Way", "Light flickers all night."),
    (IssueType.streetlight, "2400 Durant Ave", "Two lights out on the same pole."),
    (IssueType.streetlight, "Grizzly Peak Blvd", "Long dark stretch, no lighting at all."),
    (IssueType.streetlight, "1000 Cedar St", "Streetlight stays on through the day."),
    (IssueType.noise_complaint, "2130 Center St", "Construction starting before 6am."),
    (IssueType.noise_complaint, "1408 Blake St", "Amplified music past midnight, every weekend."),
    (IssueType.noise_complaint, "2555 Telegraph Ave", "Generator running overnight behind the building."),
    (IssueType.water_leak, "1030 Hearst Ave", "Water running from a broken main into the gutter."),
    (IssueType.water_leak, "Sixth St and Camelia St", "Standing water, seems to be coming up from below."),
    (IssueType.water_leak, "2900 Russell St", "Hydrant leaking steadily since yesterday."),
    (IssueType.graffiti, "Berkeley Way underpass", "Tagging along the full length of the wall."),
    (IssueType.graffiti, "1730 Oregon St", "Graffiti on the side of the parking structure."),
    (IssueType.graffiti, "Center St and Oxford St", "Newsstand covered in tags."),
    # A case a crew cannot be dispatched to: the caller hung up before giving
    # an address. Real, and exactly what the "needs attention" card is for.
    (IssueType.pothole, None, "Caller described a pothole but dropped before giving the cross street."),
    (IssueType.water_leak, None, "Leak reported, call ended before the location was confirmed."),
    # Never classified confidently enough to act on: lands in the donut's
    # "Other" slice and, once escalated, in the unrouted queue.
    (None, "Shattuck Ave and Center St", "Caller reported something blocking the sidewalk, unclear what."),
    (None, "1600 Sixth St", "Report was hard to make out, needs a callback."),
]

CALLERS = [
    ("Alicia Fenn", "5105550101"),
    ("Ben Okafor", "5105550122"),
    ("Chloe Duarte", "4155550166"),
    ("Devon Park", "5105550177"),
    ("Erin Mackey", "5105550190"),
    ("Farid Haddad", "4155550133"),
]


def file_todays_reports() -> None:
    with httpx.Client(base_url=BASE, timeout=10) as client:
        for report in REPORTS:
            response = client.post("/api/reports", params={"actor": "staff"}, json=report)
            response.raise_for_status()
            body = response.json()
            verb = "merged into" if body["merged"] else "opened"
            print(f"{verb} {body['case']['case_number']}  {body['case']['department']}")


def backfill_history() -> None:
    """Write a fortnight of cases, resolutions, escalations, and calls."""
    now = utcnow()

    with Session(engine) as session:
        if session.exec(select(Event).where(Event.kind == SEED_MARK)).first():
            print("history already seeded, skipping backfill")
            return

        taken = {c.case_number for c in session.exec(select(Case)).all()}

        def unique_case_number() -> str:
            """``new_case_number`` is random, and the column is unique."""
            while (number := new_case_number()) in taken:
                pass
            taken.add(number)
            return number

        cases: list[Case] = []
        for issue_type, location, description in BACKLOG:
            # Spread across the window rather than bunched, so every day has
            # something in it and the bars have a shape.
            age = timedelta(
                days=RNG.randint(1, HISTORY_DAYS),
                hours=RNG.randrange(0, 24),
                minutes=RNG.randrange(0, 60),
            )
            created = now - age
            case = Case(
                case_number=unique_case_number(),
                issue_type=issue_type,
                issue_type_confidence=None if issue_type else 0.35,
                department=route(issue_type),
                location=location,
                description=description,
                status=CaseStatus.new,
                report_count=1,
                created_at=created,
                updated_at=created,
            )
            session.add(case)
            cases.append(case)
        session.commit()
        for case in cases:
            session.refresh(case)

        # The last four entries of BACKLOG are the ones the "needs attention"
        # cards exist for. They are held out of the lifecycle below so they
        # stay open: a case that is already resolved needs nobody's attention.
        routine, held_out = cases[:-SPECIAL_CASES], cases[-SPECIAL_CASES:]

        # --- corroboration: a few incidents several neighbours called about --
        for case in routine[:6]:
            extra = RNG.randint(1, 3)
            case.report_count += extra
            for _ in range(extra):
                name, phone = RNG.choice(CALLERS)
                session.add(
                    Report(
                        case_id=case.id,
                        reporter_name=name,
                        reporter_phone=phone,
                        description=case.description,
                        created_at=_aged(case.created_at, now, RNG),
                    )
                )

        # --- escalations, dated so the sparkline has a real shape ------------
        for case in routine[6:10]:
            case.escalated = True
            case.escalation_reason = "Repeat reports at the same location with no crew assigned."
            escalated_at = _aged(case.created_at, now, RNG)
            session.add(
                Event(
                    case_id=case.id,
                    kind="case.escalated",
                    field="escalated",
                    old_value="False",
                    new_value=case.escalation_reason,
                    actor="staff",
                    created_at=escalated_at,
                )
            )

        # --- work in progress ------------------------------------------------
        for case in routine[10:16]:
            case.status = CaseStatus.in_progress
            _status_event(session, case, CaseStatus.in_progress, _aged(case.created_at, now, RNG))

        # --- resolutions, which are what the average is computed from --------
        # Deliberately varied: a leak closed the same day, a graffiti case that
        # sat for a week. A flat average is a suspicious average.
        for case in routine[16:]:
            created = case.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=now.tzinfo)
            room = (now - created).total_seconds()
            if room < 3600:
                continue
            resolved_at = created + timedelta(seconds=RNG.uniform(3600, room))
            case.status = CaseStatus.resolved
            case.updated_at = now  # an unrelated later touch; the event still dates the fix
            _status_event(session, case, CaseStatus.resolved, resolved_at)

        # --- the held-out four -----------------------------------------------
        # Two with no address a crew could be sent to, and two the classifier
        # was never confident about - escalated, so they are high priority and
        # still sitting in ``unassigned`` with nobody to work them.
        for case in held_out[2:]:
            case.escalated = True
            case.escalation_reason = "Escalated for a callback: nobody can act on this as filed."
            session.add(
                Event(
                    case_id=case.id,
                    kind="case.escalated",
                    field="escalated",
                    old_value="False",
                    new_value=case.escalation_reason,
                    actor="staff",
                    created_at=_aged(case.created_at, now, RNG),
                )
            )

        for case in cases:
            case.priority_score = priority_score(case)
            case.priority = priority_band(case.priority_score)
            session.add(case)

        # --- calls: eight days of volume, plus two still on the line ---------
        for day_offset in range(HISTORY_DAYS):
            for _ in range(RNG.randint(2, 9)):
                started = now - timedelta(
                    days=day_offset, hours=RNG.randrange(0, 24), minutes=RNG.randrange(0, 60)
                )
                if started > now:
                    continue
                name, phone = RNG.choice(CALLERS)
                case = RNG.choice(cases)
                session.add(
                    Call(
                        room=f"intake-seed-{day_offset}-{RNG.randrange(16**6):06x}",
                        case_id=case.id,
                        status=CallStatus.completed,
                        phase=CallPhase.ended,
                        caller_name=name,
                        caller_phone=phone,
                        sentiment=RNG.choice(
                            [Sentiment.neutral, Sentiment.neutral, Sentiment.negative, Sentiment.positive]
                        ),
                        summary=f"Reported: {case.description}" if case.description else None,
                        started_at=started,
                        ended_at=started + timedelta(minutes=RNG.randint(2, 9)),
                    )
                )

        for index in range(2):
            name, phone = CALLERS[index]
            session.add(
                Call(
                    room=f"intake-live-{index}",
                    status=CallStatus.active,
                    phase=CallPhase.gathering,
                    caller_name=name,
                    caller_phone=phone,
                    sentiment=Sentiment.neutral,
                    activity_line="Confirming the cross street with the caller.",
                    started_at=now - timedelta(minutes=RNG.randint(1, 6)),
                )
            )

        session.add(Event(kind=SEED_MARK, actor="system", created_at=now))
        session.commit()

    print(f"backfilled {len(BACKLOG)} historical cases across {HISTORY_DAYS} days")


def _aged(created, now, rng: random.Random):
    """A moment between ``created`` and now, for something that happened after."""
    if created.tzinfo is None:
        created = created.replace(tzinfo=now.tzinfo)
    span = max((now - created).total_seconds(), 60)
    return created + timedelta(seconds=rng.uniform(60, span))


def _status_event(session: Session, case: Case, status: CaseStatus, moment) -> None:
    """The audit row the analytics read to date a status change.

    Written in exactly the shape ``store.update_case`` writes it, because that
    is what ``/api/stats/summary`` queries for.
    """
    session.add(
        Event(
            case_id=case.id,
            kind="case.updated",
            field="status",
            old_value=CaseStatus.new.value,
            new_value=status.value,
            actor="staff",
            created_at=moment,
        )
    )


if __name__ == "__main__":
    init_db()
    backfill_history()
    file_todays_reports()

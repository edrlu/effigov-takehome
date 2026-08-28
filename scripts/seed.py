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

Both passes carry coordinates for their Berkeley locations, recorded rather than
looked up. The backend geocodes every one of these strings for itself, off the
request path, and returns exactly these answers - but a demo has to draw its map
in a room with no network, and a case that already carries a pin is left alone
by a background geocode that lands later. The five that resolve to nothing, and
the several that OSM knows only to street level, are kept as they are: a map
that is honest about what the city does not know is the point.

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
    LocationPrecision,
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

# Where each seeded location actually is, as OpenStreetMap answered for the
# exact strings above. ``None`` means Nominatim found nothing inside Berkeley
# for it, which is a real outcome and one the dashboard has to be able to show.
GEOCODED = {
    '1420 Chestnut St': (
        'Chestnut Street, Poets Corner, Berkeley, Alameda County, California, 94702, United States',
        37.8703798, -122.2881401, 'approximate',
    ),
    '88 Marina Blvd': (
        'Marina Boulevard, Berkeley Marina, Berkeley, Alameda County, California, 94710, United States',
        37.8684151, -122.3130132, 'approximate',
    ),
    'Telegraph Ave and Dwight Way': (
        'Telegraph Avenue & Dwight Way, Telegraph Avenue, Southside, Berkeley, Alameda County, California, 94705, United States',
        37.86455, -122.2586656, 'exact',
    ),
    '2210 Ward St': (
        '2210, Ward Street, LeConte, Berkeley, Alameda County, California, 94705, United States',
        37.8597712, -122.2639636, 'exact',
    ),
    '1719 Addison St': (
        '1719, Addison Street, Central Berkeley, Berkeley, Alameda County, California, 94704, United States',
        37.8703518, -122.2765445, 'exact',
    ),
    '500 El Cerrito Plaza': None,
    '3040 Adeline St': (
        'Adeline Street, Lorin, Berkeley, Alameda County, California, 94703, United States',
        37.8473528, -122.2718371, 'approximate',
    ),
    '1200 University Ave': (
        '1200, University Avenue, Poets Corner, Berkeley, Alameda County, California, 94702, United States',
        37.869321, -122.289396, 'exact',
    ),
    '77 Solano Ave': (
        'Solano Avenue, Northbrae, Berkeley, Alameda County, California, 94707, United States',
        37.8911319, -122.276119, 'approximate',
    ),
    'Sacramento St near Dwight Way': (
        'Dwight Way & Sacramento Street, Dwight Way, Poets Corner, Berkeley, Alameda County, California, 94703, United States',
        37.862292, -122.2809336, 'exact',
    ),
    'Ashby Ave and Shattuck Ave': (
        'Ashby Avenue & Shattuck Avenue, Ashby Avenue, Berkeley, Alameda County, California, 94705, United States',
        37.8552555, -122.2662411, 'exact',
    ),
    '1900 Sixth St': (
        '1900;1904, Sixth Street, West Berkeley, Berkeley, Alameda County, California, 94710, United States',
        37.869004, -122.298514, 'approximate',
    ),
    'Gilman St under the overpass': None,
    'College Ave and Alcatraz Ave': (
        'College Avenue & Alcatraz Avenue, College Avenue, North Oakland, Berkeley, Alameda County, California, 94168, United States',
        37.8509305, -122.252566, 'exact',
    ),
    'Milvia St and Allston Way': None,
    '2400 Durant Ave': (
        'Cafe 3, 2400;2430;2432;2434;2436;2438;2440;2442;2444;2446;2450, Durant Avenue, Southside, Berkeley, Alameda County, California, 94720, United States',
        37.8672882, -122.2605158, 'approximate',
    ),
    'Grizzly Peak Blvd': (
        'Grizzly Peak Boulevard, Berkeley Hills, Berkeley, Alameda County, California, 94708, United States',
        37.8938469, -122.2579519, 'approximate',
    ),
    '1000 Cedar St': (
        '1000, Cedar Street, Ocean View, Berkeley, Alameda County, California, 94710, United States',
        37.8746009, -122.2961168, 'exact',
    ),
    '2130 Center St': (
        '2128;2130, Center Street, Downtown Berkeley, Berkeley, Alameda County, California, 94704, United States',
        37.8701496, -122.267053, 'approximate',
    ),
    '1408 Blake St': (
        '1408, Blake Street, San Pablo Park, Berkeley, Alameda County, California, 94703, United States',
        37.8608669, -122.2825554, 'exact',
    ),
    '2555 Telegraph Ave': (
        '2555, Telegraph Avenue, Southside, Berkeley, Alameda County, California, 94704, United States',
        37.8640258, -122.2588173, 'exact',
    ),
    '1030 Hearst Ave': (
        '1030, Hearst Avenue, Central Berkeley, Berkeley, Alameda County, California, 94703, United States',
        37.87209, -122.2819442, 'exact',
    ),
    'Sixth St and Camelia St': None,
    '2900 Russell St': (
        '2900, Russell Street, Claremont, Berkeley, Alameda County, California, 94168, United States',
        37.8586284, -122.2482241, 'exact',
    ),
    'Berkeley Way underpass': None,
    '1730 Oregon St': (
        'Martin Luther King Jr. Youth Services Center, 1730, Oregon Street, South Berkeley, North Oakland, Berkeley, Alameda County, California, 94703, United States',
        37.8565345, -122.2735435, 'exact',
    ),
    'Center St and Oxford St': (
        'Li Ka Shing Center, 1951, Oxford Street, Downtown Berkeley, Berkeley, Alameda County, California, 94720, United States',
        37.8729723, -122.2654381, 'approximate',
    ),
    'Shattuck Ave and Center St': (
        'Center Street & Shattuck Avenue, Center Street, Downtown Berkeley, Berkeley, Alameda County, California, 94704, United States',
        37.8703132, -122.2686169, 'exact',
    ),
    '1600 Sixth St': (
        '1600, Sixth Street, Ocean View, Berkeley, Alameda County, California, 94710, United States',
        37.873945, -122.299783, 'exact',
    ),
}

# The "whereabouts on the street" note the agent asks for once it has the
# address. No geocoder produces this, and no map pin replaces it.
LOCATION_DETAIL = {
    "1420 Chestnut St": "Third house up from the corner, bins left at the curb.",
    "88 Marina Blvd": "Pole on the water side of the road, by the second bench.",
    "Telegraph Ave and Dwight Way": "Northeast corner, the shelter facing downhill.",
    "Sacramento St near Dwight Way": "Northbound lane, right where the bike lane starts.",
    "Ashby Ave and Shattuck Ave": "Right lane heading west, just past the crosswalk.",
    "1030 Hearst Ave": "Running out of the gutter on the south side.",
}


def pin_for(location: str | None) -> dict[str, object]:
    """The recorded geocode for a seeded location, in the shape a case stores.

    An empty dict for anywhere Nominatim could not place: the case keeps the
    caller's words, stays ``unresolved``, and is still perfectly workable.
    """
    found = GEOCODED.get(location or "")
    detail = LOCATION_DETAIL.get(location or "")
    if not found:
        return {"location_detail": detail} if detail else {}
    formatted, latitude, longitude, precision = found
    return {
        "location_formatted": formatted,
        "latitude": latitude,
        "longitude": longitude,
        "location_precision": precision,
        **({"location_detail": detail} if detail else {}),
    }


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
            case = body["case"]

            pin = pin_for(report["location"])
            if pin:
                pinned = client.patch(
                    f"/api/cases/{case['id']}", params={"actor": "staff"}, json=pin
                )
                pinned.raise_for_status()
                case = pinned.json()

            where = (
                f"{case['latitude']:.4f},{case['longitude']:.4f} {case['location_precision']}"
                if case["latitude"] is not None
                else "unresolved"
            )
            print(f"{verb} {case['case_number']}  {case['department']}  {where}")


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
            pin = pin_for(location)
            case = Case(
                case_number=unique_case_number(),
                issue_type=issue_type,
                issue_type_confidence=None if issue_type else 0.35,
                department=route(issue_type),
                location=location,
                # These rows never pass through the API, so nothing would ever
                # geocode them. The caller's words and the pin go on together.
                location_text=location,
                location_formatted=pin.get("location_formatted"),
                latitude=pin.get("latitude"),
                longitude=pin.get("longitude"),
                location_precision=LocationPrecision(
                    pin.get("location_precision", LocationPrecision.unresolved.value)
                ),
                location_detail=pin.get("location_detail"),
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

        # --- the report and the audit rows every case is born with -----------
        # ``report_count`` starts at 1, so there has to be a report to count,
        # and somebody's name and number on it - that is what the case page
        # shows as the reporter. Written straight rather than through the API
        # for the same reason as the cases themselves: it happened last week.
        # The audit rows are the ones ``store.create_case`` and
        # ``store.file_report`` write, so a seeded case reads on the dashboard
        # the way one taken by the agent does instead of starting mid-story.
        # The caller is picked by position, not from RNG, so adding this does
        # not shift the random sequence the rest of the backfill draws from.
        for index, case in enumerate(cases):
            name, phone = CALLERS[index % len(CALLERS)]
            session.add(
                Report(
                    case_id=case.id,
                    reporter_name=name,
                    reporter_phone=phone,
                    description=case.description,
                    created_at=case.created_at,
                )
            )
            session.add(
                Event(
                    case_id=case.id,
                    kind="case.created",
                    new_value=case.case_number,
                    actor="voice_agent",
                    created_at=case.created_at,
                )
            )
            session.add(
                Event(
                    case_id=case.id,
                    kind="case.routed",
                    field="department",
                    new_value=case.department.value,
                    actor="system",
                    created_at=case.created_at,
                )
            )
            session.add(
                Event(
                    case_id=case.id,
                    kind="report.filed",
                    field="report_count",
                    old_value="0",
                    new_value="1",
                    actor="voice_agent",
                    created_at=case.created_at,
                )
            )

        # The last four entries of BACKLOG are the ones the "needs attention"
        # cards exist for. They are held out of the lifecycle below so they
        # stay open: a case that is already resolved needs nobody's attention.
        routine, held_out = cases[:-SPECIAL_CASES], cases[-SPECIAL_CASES:]

        # --- corroboration: a few incidents several neighbours called about --
        for case in routine[:6]:
            extra = RNG.randint(1, 3)
            # Sorted, because the count each event carries only makes sense in
            # the order the timeline renders them: 1 -> 2 -> 3, not 1 -> 2 then
            # 3 -> 4 dated before 2 -> 3.
            filed_ats = sorted(_aged(case.created_at, now, RNG) for _ in range(extra))
            for filed_at in filed_ats:
                name, phone = RNG.choice(CALLERS)
                case.report_count += 1
                session.add(
                    Report(
                        case_id=case.id,
                        reporter_name=name,
                        reporter_phone=phone,
                        description=case.description,
                        created_at=filed_at,
                    )
                )
                session.add(
                    Event(
                        case_id=case.id,
                        kind="report.merged",
                        field="report_count",
                        old_value=str(case.report_count - 1),
                        new_value=str(case.report_count),
                        actor="voice_agent",
                        created_at=filed_at,
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

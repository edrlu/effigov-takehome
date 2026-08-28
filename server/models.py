"""Data model.

The central modelling decision: a **Case is a civic incident**, and a
**Report is one resident's observation of it**. Three neighbours calling about
the same pothole produce one case with three reports, not three cases. Almost
everything interesting in this demo - deduplication, priority that rises with
corroboration, an audit trail that survives repeated calls - falls out of that
one distinction.

* ``Case``   - the pothole itself. What a crew gets dispatched to.
* ``Report`` - what one resident said about it, and how to call them back.
* ``Call``   - one voice session. Produces at most one report.
* ``Turn``   - a single transcript line inside a call.
* ``Event``  - append-only audit log of everything that changed a case.
* ``Outbox`` - append-only log of every frame broadcast on the websocket.

``Outbox`` is the odd one out: it is not domain data, it is the ordering truth
for the live stream. A dashboard that reconnects replays it instead of guessing
what it missed, which is why ``seq`` has to survive a restart of the process.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_case_number() -> str:
    """Human-speakable case number. Digits only so the agent can read it aloud."""
    return f"SR-{secrets.randbelow(900000) + 100000}"


class CaseStatus(str, Enum):
    new = "new"
    in_progress = "in_progress"
    needs_info = "needs_info"
    resolved = "resolved"


class IssueType(str, Enum):
    missed_collection = "missed_collection"
    pothole = "pothole"
    streetlight = "streetlight"
    noise_complaint = "noise_complaint"
    water_leak = "water_leak"
    graffiti = "graffiti"
    other = "other"


class Department(str, Enum):
    public_works = "public_works"
    sanitation = "sanitation"
    utilities = "utilities"
    code_enforcement = "code_enforcement"
    parks = "parks"
    unassigned = "unassigned"


class Priority(str, Enum):
    low = "low"
    normal = "normal"
    high = "high"


class CallStatus(str, Enum):
    active = "active"
    completed = "completed"


class Sentiment(str, Enum):
    """How the caller sounds right now, as the agent reads it.

    Deliberately coarse. A supervisor scanning a wall of live calls needs to
    spot the distressed one, not to grade tone on a scale.
    """

    positive = "positive"
    neutral = "neutral"
    negative = "negative"


class LocationPrecision(str, Enum):
    """How much the recorded coordinates can be trusted.

    This is the honest part of a geocode and matters more than the numbers. A
    crew sent to a point labelled ``approximate`` knows to look around; one sent
    to a point that merely *looks* precise does not. ``unresolved`` means the
    caller's words are all the city has, which is a fact about the case, not an
    error to hide.
    """

    exact = "exact"
    approximate = "approximate"
    unresolved = "unresolved"


class CallPhase(str, Enum):
    """Where a live call has got to, for staff watching it happen.

    ``CallStatus`` answers "is this call still up?". ``CallPhase`` answers
    "what is the agent doing right now?", which is the question a supervisor
    watching the board actually has.
    """

    greeting = "greeting"
    gathering = "gathering"
    filed = "filed"
    wrapping = "wrapping"
    ended = "ended"


class Case(SQLModel, table=True):
    """One civic incident, no matter how many people report it."""

    id: int | None = Field(default=None, primary_key=True)
    case_number: str = Field(default_factory=new_case_number, index=True, unique=True)

    issue_type: IssueType | None = Field(default=None, index=True)
    # How sure the classifier was. Kept even when the classification was too
    # weak to apply, so the dashboard can say "still being classified" rather
    # than "nobody knows".
    issue_type_confidence: float | None = Field(default=None)
    department: Department = Field(default=Department.unassigned, index=True)

    # ``location`` is what everything already reads: search, deduplication, the
    # line the agent says back to the caller. The fields below hang off it.
    # ``location_text`` keeps the caller's own phrasing even after a staff
    # member tidies ``location`` up, and the rest are what the geocoder made of
    # it. They move together and are always rewritten as a set, so a pin can
    # never belong to a location the case no longer has.
    location: str | None = None
    location_text: str | None = None
    location_formatted: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    location_precision: LocationPrecision = Field(
        default=LocationPrecision.unresolved, index=True
    )
    # Where exactly on that street, in the caller's words: "right lane near the
    # crosswalk, curb side". No geocoder produces this and no map pin replaces
    # it - it is what stops a crew driving past the thing twice.
    location_detail: str | None = None

    description: str | None = None

    status: CaseStatus = Field(default=CaseStatus.new, index=True)
    priority: Priority = Field(default=Priority.normal)
    priority_score: int = Field(default=0, index=True)
    report_count: int = Field(default=0)

    escalated: bool = Field(default=False, index=True)
    escalation_reason: str | None = None

    # Details the residents on this case do not agree about, comma separated.
    # Recomputed from their reports every time one lands - see
    # ``triage.corroborate_locations``. A dispatcher needs to know that two
    # people put the pothole three blocks apart, because the alternative is a
    # crew sent to whichever account happened to arrive first. Serialized as
    # ``contested``, a list.
    contested_fields: str | None = None

    notes: str | None = None
    summary: str | None = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Report(SQLModel, table=True):
    """One resident's account of an incident, and how to reach them.

    Keyed by phone number within a case: one resident, one report, however many
    times they ring back. That is what makes ``Case.report_count`` a count of
    *people* rather than of calls, which is the whole basis of corroboration -
    one neighbour phoning three times is not three neighbours.

    A caller who will not leave a number cannot be keyed, so they get a fresh
    report each time. SQLite treats NULLs as distinct under a unique
    constraint, so that falls out of the constraint rather than needing a
    special case. See ``store.distinct_reporters``.

    Everything here is one resident's own account, including their own wording
    for where the problem is. It is supporting evidence: staff work the Case,
    and reach for a report when they need to ring somebody back.
    """

    __table_args__ = (
        UniqueConstraint("case_id", "reporter_phone", name="uq_report_case_phone"),
    )

    id: int | None = Field(default=None, primary_key=True)
    case_id: int = Field(foreign_key="case.id", index=True)
    call_id: int | None = Field(default=None, foreign_key="call.id", index=True)

    reporter_name: str | None = None
    reporter_phone: str | None = Field(default=None, index=True)
    description: str | None = None
    # This caller's own words for where the problem is. The case carries the
    # canonical location a crew is dispatched to; this is what one resident
    # said, kept so a later, vaguer caller cannot overwrite a sharper one and
    # so staff can promote a better account onto the case deliberately.
    location: str | None = None
    # And what this caller said the problem was. Stored as given, before the
    # confidence gate that decides what the *case* is classified as: that gate
    # is the city's policy about acting on a guess, not a reason to forget what
    # a resident actually said. Two residents agreeing is evidence; one saying
    # water leak where the case says pothole is worth a dispatcher's attention.
    issue_type: IssueType | None = None

    created_at: datetime = Field(default_factory=utcnow)


class Call(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    room: str = Field(index=True)
    case_id: int | None = Field(default=None, foreign_key="case.id", index=True)
    report_id: int | None = Field(default=None, index=True)

    status: CallStatus = Field(default=CallStatus.active, index=True)
    phase: CallPhase = Field(default=CallPhase.greeting, index=True)
    caller_phone: str | None = None
    summary: str | None = None

    # Who is on the line. Carried on the call itself, not only on the report,
    # so a console can render the caller before a report has been filed.
    caller_name: str | None = None
    caller_city: str | None = Field(default="Berkeley, CA")
    line_type: str | None = Field(default="Mobile")
    language: str | None = Field(default="English")

    sentiment: Sentiment = Field(default=Sentiment.neutral, index=True)
    # One short present-tense sentence: what the agent is doing right now.
    # ``phase`` says which stage the call is in; this says it in English.
    activity_line: str | None = None

    started_at: datetime = Field(default_factory=utcnow)
    ended_at: datetime | None = None


class Turn(SQLModel, table=True):
    """One FINAL line of transcript. ``role`` is 'caller' or 'agent'.

    Interim speech never lands here. A half-spoken sentence is not a fact about
    the call, so it is broadcast as a ``transcript.delta`` frame and forgotten.
    """

    __table_args__ = (UniqueConstraint("call_id", "turn_seq", name="uq_turn_call_seq"),)

    id: int | None = Field(default=None, primary_key=True)
    call_id: int = Field(foreign_key="call.id", index=True)
    # Per-call ordering, starting at 1. Wall-clock timestamps tie under load and
    # give the dashboard no stable key to replace a provisional line with.
    turn_seq: int = Field(default=1, index=True)
    role: str
    text: str
    created_at: datetime = Field(default_factory=utcnow)


class Event(SQLModel, table=True):
    """Audit trail entry. One row per field change or lifecycle moment."""

    id: int | None = Field(default=None, primary_key=True)
    case_id: int | None = Field(default=None, foreign_key="case.id", index=True)
    call_id: int | None = Field(default=None, foreign_key="call.id", index=True)

    # case.created | case.updated | note.added | call.started | call.ended
    # report.filed | report.merged | case.routed | case.escalated | priority.changed
    # call.phase | call.updated
    kind: str
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    actor: str = "voice_agent"  # voice_agent | staff | system

    created_at: datetime = Field(default_factory=utcnow)


class Outbox(SQLModel, table=True):
    """Every data frame the server has broadcast, in the order it broadcast them.

    The row is written before the frame goes out, so ``seq`` is assigned by the
    database and ordering survives a restart. ``frame`` holds the exact JSON
    text that was sent rather than a reference to the current row, because a
    replay is history: a client resuming at seq 97 wants what happened at 97,
    not what the case looks like now.
    """

    seq: int | None = Field(default=None, primary_key=True)
    type: str = Field(index=True)
    ts: datetime = Field(default_factory=utcnow)
    frame: str

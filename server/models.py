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
    location: str | None = None
    description: str | None = None

    status: CaseStatus = Field(default=CaseStatus.new, index=True)
    priority: Priority = Field(default=Priority.normal)
    priority_score: int = Field(default=0, index=True)
    report_count: int = Field(default=0)

    escalated: bool = Field(default=False, index=True)
    escalation_reason: str | None = None

    notes: str | None = None
    summary: str | None = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Report(SQLModel, table=True):
    """One resident's account of an incident, and how to reach them."""

    id: int | None = Field(default=None, primary_key=True)
    case_id: int = Field(foreign_key="case.id", index=True)
    call_id: int | None = Field(default=None, foreign_key="call.id", index=True)

    reporter_name: str | None = None
    reporter_phone: str | None = Field(default=None, index=True)
    description: str | None = None

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
    # call.phase
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

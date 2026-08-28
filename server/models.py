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
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from enum import Enum

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


class Case(SQLModel, table=True):
    """One civic incident, no matter how many people report it."""

    id: int | None = Field(default=None, primary_key=True)
    case_number: str = Field(default_factory=new_case_number, index=True, unique=True)

    issue_type: IssueType | None = Field(default=None, index=True)
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
    caller_phone: str | None = None
    summary: str | None = None

    started_at: datetime = Field(default_factory=utcnow)
    ended_at: datetime | None = None


class Turn(SQLModel, table=True):
    """One line of transcript. ``role`` is 'caller' or 'agent'."""

    id: int | None = Field(default=None, primary_key=True)
    call_id: int = Field(foreign_key="call.id", index=True)
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
    kind: str
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    actor: str = "voice_agent"  # voice_agent | staff | system

    created_at: datetime = Field(default_factory=utcnow)

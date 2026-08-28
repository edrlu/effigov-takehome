"""Data model for the case-management demo.

Three tables carry the whole flow:

* ``Case``  - the durable unit of work a staff member triages.
* ``Call``  - one voice session; may or may not end up attached to a case.
* ``Turn``  - a single transcript line inside a call.
* ``Event`` - an append-only audit log of everything that changed a case.

Every mutation goes through ``server.store``, which writes the row *and*
publishes an event on the websocket hub, so the dashboard never has to poll.
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


class Priority(str, Enum):
    low = "low"
    normal = "normal"
    high = "high"


class CallStatus(str, Enum):
    active = "active"
    completed = "completed"


class Case(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    case_number: str = Field(default_factory=new_case_number, index=True, unique=True)

    caller_name: str | None = None
    phone: str | None = Field(default=None, index=True)
    address: str | None = None

    issue_type: IssueType | None = None
    description: str | None = None

    status: CaseStatus = Field(default=CaseStatus.new, index=True)
    priority: Priority = Field(default=Priority.normal)
    notes: str | None = None
    summary: str | None = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Call(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    room: str = Field(index=True)
    case_id: int | None = Field(default=None, foreign_key="case.id", index=True)

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

    kind: str  # case.created | case.updated | call.started | call.ended | note.added
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    actor: str = "voice_agent"  # voice_agent | staff | system

    created_at: datetime = Field(default_factory=utcnow)

"""Request bodies. Responses are plain dicts from ``store.serialize``."""

from __future__ import annotations

from pydantic import BaseModel, Field

from server.models import (
    CallPhase,
    CaseStatus,
    Department,
    IssueType,
    LocationPrecision,
    Priority,
    Sentiment,
)


class CaseCreate(BaseModel):
    issue_type: IssueType | None = None
    issue_type_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    department: Department | None = None
    location: str | None = None
    location_detail: str | None = None
    description: str | None = None
    status: CaseStatus = CaseStatus.new
    notes: str | None = None


class CaseUpdate(BaseModel):
    issue_type: IssueType | None = None
    issue_type_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    department: Department | None = None
    location: str | None = None
    # ``location`` alone is enough: the geocoder fills the rest in. These are
    # here so staff can correct a pin the geocoder got wrong, and so seed and
    # rehearsal data can stand up a map without a live network call.
    location_text: str | None = None
    location_formatted: str | None = None
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    location_precision: LocationPrecision | None = None
    location_detail: str | None = None
    description: str | None = None
    status: CaseStatus | None = None
    priority: Priority | None = None
    summary: str | None = None


class NoteCreate(BaseModel):
    note: str


class EscalateRequest(BaseModel):
    reason: str


class ReportCreate(BaseModel):
    issue_type: IssueType | None = None
    issue_type_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    location: str | None = None
    description: str | None = None
    reporter_name: str | None = None
    reporter_phone: str | None = None
    call_id: int | None = None
    # Set when the caller named the case themselves. The report is pinned to it
    # instead of going back through the duplicate search - see ``file_report``.
    case_id: int | None = None


class ReportUpdate(BaseModel):
    reporter_name: str | None = None
    reporter_phone: str | None = None
    description: str | None = None


class CallCreate(BaseModel):
    room: str
    caller_phone: str | None = None


class CallUpdate(BaseModel):
    case_id: int | None = None
    report_id: int | None = None
    status: str | None = None
    phase: CallPhase | None = None
    summary: str | None = None
    caller_phone: str | None = None
    caller_name: str | None = None
    caller_city: str | None = None
    line_type: str | None = None
    language: str | None = None
    sentiment: Sentiment | None = None
    activity_line: str | None = None


class TurnCreate(BaseModel):
    role: str
    text: str


class InterimCreate(BaseModel):
    """A partial utterance. Broadcast, never stored."""

    role: str
    text: str


class TokenRequest(BaseModel):
    room: str | None = None
    identity: str | None = None

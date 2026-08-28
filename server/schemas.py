"""Request bodies. Responses are plain dicts from ``store.serialize``."""

from __future__ import annotations

from pydantic import BaseModel

from server.models import CaseStatus, IssueType, Priority


class CaseCreate(BaseModel):
    caller_name: str | None = None
    phone: str | None = None
    address: str | None = None
    issue_type: IssueType | None = None
    description: str | None = None
    status: CaseStatus = CaseStatus.new
    priority: Priority = Priority.normal
    notes: str | None = None


class CaseUpdate(BaseModel):
    caller_name: str | None = None
    phone: str | None = None
    address: str | None = None
    issue_type: IssueType | None = None
    description: str | None = None
    status: CaseStatus | None = None
    priority: Priority | None = None
    summary: str | None = None


class NoteCreate(BaseModel):
    note: str


class CallCreate(BaseModel):
    room: str
    caller_phone: str | None = None


class CallUpdate(BaseModel):
    case_id: int | None = None
    status: str | None = None
    summary: str | None = None
    caller_phone: str | None = None


class TurnCreate(BaseModel):
    role: str
    text: str


class TokenRequest(BaseModel):
    room: str | None = None
    identity: str | None = None

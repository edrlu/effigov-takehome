"""All writes funnel through here.

The invariant this module exists to hold: *every* change to a case writes an
``Event`` row and broadcasts the same change on the websocket hub. Handlers
never mutate a model directly, so the audit log and the live dashboard can
never drift from the database.
"""

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from server.hub import hub
from server.models import Call, CallStatus, Case, Event, Turn, utcnow

# Fields the voice agent and the dashboard are allowed to set on a case.
MUTABLE_CASE_FIELDS = {
    "caller_name",
    "phone",
    "address",
    "issue_type",
    "description",
    "status",
    "priority",
    "notes",
    "summary",
}


def serialize(obj: Any) -> dict[str, Any]:
    data = obj.model_dump()
    for key, value in data.items():
        if hasattr(value, "isoformat"):
            data[key] = value.isoformat()
        elif hasattr(value, "value"):
            data[key] = value.value
    return data


def _log(
    session: Session,
    *,
    kind: str,
    case_id: int | None = None,
    call_id: int | None = None,
    field: str | None = None,
    old: Any = None,
    new: Any = None,
    actor: str = "voice_agent",
) -> Event:
    event = Event(
        kind=kind,
        case_id=case_id,
        call_id=call_id,
        field=field,
        old_value=None if old is None else str(getattr(old, "value", old)),
        new_value=None if new is None else str(getattr(new, "value", new)),
        actor=actor,
    )
    session.add(event)
    return event


# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------


def create_case(session: Session, data: dict[str, Any], *, actor: str = "voice_agent") -> Case:
    case = Case(**{k: v for k, v in data.items() if k in MUTABLE_CASE_FIELDS})
    session.add(case)
    session.commit()
    session.refresh(case)

    _log(session, kind="case.created", case_id=case.id, new=case.case_number, actor=actor)
    session.commit()
    session.refresh(case)

    hub.publish("case.created", serialize(case))
    return case


def update_case(
    session: Session,
    case: Case,
    data: dict[str, Any],
    *,
    actor: str = "voice_agent",
) -> Case:
    """Apply a partial update, logging one event per field that actually moved."""
    changed: list[str] = []
    for field, value in data.items():
        if field not in MUTABLE_CASE_FIELDS or value is None:
            continue
        old = getattr(case, field)
        if old == value:
            continue
        setattr(case, field, value)
        changed.append(field)
        _log(
            session,
            kind="case.updated",
            case_id=case.id,
            field=field,
            old=old,
            new=value,
            actor=actor,
        )

    if not changed:
        return case

    case.updated_at = utcnow()
    session.add(case)
    session.commit()
    session.refresh(case)

    hub.publish("case.updated", {"case": serialize(case), "changed": changed})
    return case


def append_note(session: Session, case: Case, note: str, *, actor: str = "voice_agent") -> Case:
    stamped = f"[{utcnow().strftime('%Y-%m-%d %H:%M')}] {note}"
    case.notes = f"{case.notes}\n{stamped}" if case.notes else stamped
    case.updated_at = utcnow()
    session.add(case)
    _log(session, kind="note.added", case_id=case.id, field="notes", new=note, actor=actor)
    session.commit()
    session.refresh(case)

    hub.publish("case.updated", {"case": serialize(case), "changed": ["notes"]})
    return case


def find_case(session: Session, identifier: str) -> Case | None:
    """Look a case up by case number or phone number, whichever the caller gives."""
    normalized = identifier.strip()
    case = session.exec(select(Case).where(Case.case_number == normalized.upper())).first()
    if case:
        return case

    digits = "".join(ch for ch in normalized if ch.isdigit())
    if not digits:
        return None
    if len(digits) == 6:
        case = session.exec(select(Case).where(Case.case_number == f"SR-{digits}")).first()
        if case:
            return case
    return session.exec(
        select(Case).where(Case.phone == digits).order_by(Case.created_at.desc())
    ).first()


# --------------------------------------------------------------------------
# Calls and transcript
# --------------------------------------------------------------------------


def start_call(session: Session, room: str, caller_phone: str | None = None) -> Call:
    call = Call(room=room, caller_phone=caller_phone)
    session.add(call)
    session.commit()
    session.refresh(call)

    _log(session, kind="call.started", call_id=call.id, new=room, actor="system")
    session.commit()
    session.refresh(call)

    hub.publish("call.started", serialize(call))
    return call


def update_call(session: Session, call: Call, data: dict[str, Any]) -> Call:
    for field in ("case_id", "summary", "caller_phone"):
        if data.get(field) is not None:
            setattr(call, field, data[field])

    if data.get("status") == CallStatus.completed.value or data.get("status") == CallStatus.completed:
        call.status = CallStatus.completed
        call.ended_at = utcnow()
        _log(session, kind="call.ended", call_id=call.id, case_id=call.case_id, actor="system")

    session.add(call)
    session.commit()
    session.refresh(call)

    hub.publish("call.updated", serialize(call))
    return call


def add_turn(session: Session, call: Call, role: str, text: str) -> Turn:
    turn = Turn(call_id=call.id, role=role, text=text)
    session.add(turn)
    session.commit()
    session.refresh(turn)

    hub.publish("transcript.turn", serialize(turn))
    return turn

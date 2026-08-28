"""All writes funnel through here.

The invariant this module exists to hold: *every* change to a case writes an
``Event`` row and broadcasts the same change on the websocket hub. Handlers
never mutate a model directly, so the audit log and the live dashboard can
never drift from the database.
"""

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from server import triage
from server.hub import hub
from server.models import (
    Call,
    CallStatus,
    Case,
    CaseStatus,
    Event,
    IssueType,
    Report,
    Turn,
    utcnow,
)

# Fields the voice agent and the dashboard are allowed to set on a case.
MUTABLE_CASE_FIELDS = {
    "issue_type",
    "department",
    "location",
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
# Priority
# --------------------------------------------------------------------------


def _reprice(session: Session, case: Case, *, actor: str = "system") -> list[str]:
    """Recompute the queue position. Returns the field names that moved."""
    score = triage.priority_score(case)
    band = triage.priority_band(score)
    changed: list[str] = []

    if case.priority_score != score:
        case.priority_score = score
        changed.append("priority_score")
    if case.priority != band:
        _log(
            session,
            kind="priority.changed",
            case_id=case.id,
            field="priority",
            old=case.priority,
            new=band,
            actor=actor,
        )
        case.priority = band
        changed.append("priority")

    return changed


# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------


def create_case(session: Session, data: dict[str, Any], *, actor: str = "voice_agent") -> Case:
    case = Case(**{k: v for k, v in data.items() if k in MUTABLE_CASE_FIELDS})
    if case.department is None or data.get("department") is None:
        case.department = triage.route(case.issue_type)
    session.add(case)
    session.commit()
    session.refresh(case)

    _log(session, kind="case.created", case_id=case.id, new=case.case_number, actor=actor)
    _log(
        session,
        kind="case.routed",
        case_id=case.id,
        field="department",
        new=case.department,
        actor="system",
    )
    _reprice(session, case, actor=actor)
    session.add(case)
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

    # A corrected issue type re-routes the case. Routing is never typed by hand.
    if "issue_type" in changed and "department" not in data:
        department = triage.route(case.issue_type)
        if department != case.department:
            _log(
                session,
                kind="case.routed",
                case_id=case.id,
                field="department",
                old=case.department,
                new=department,
                actor="system",
            )
            case.department = department
            changed.append("department")

    if "issue_type" in changed:
        changed += _reprice(session, case, actor=actor)

    if not changed:
        return case

    case.updated_at = utcnow()
    session.add(case)
    session.commit()
    session.refresh(case)

    hub.publish("case.updated", {"case": serialize(case), "changed": changed})
    return case


def escalate(session: Session, case: Case, reason: str, *, actor: str = "voice_agent") -> Case:
    """Flag a case for immediate human review and pin it to the top of the queue."""
    case.escalated = True
    case.escalation_reason = reason
    _log(
        session,
        kind="case.escalated",
        case_id=case.id,
        field="escalated",
        old=False,
        new=reason,
        actor=actor,
    )
    _reprice(session, case, actor=actor)
    case.updated_at = utcnow()
    session.add(case)
    session.commit()
    session.refresh(case)

    hub.publish("case.escalated", serialize(case))
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
    """Look a case up by case number or by a reporter's phone number."""
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

    report = session.exec(
        select(Report)
        .where(Report.reporter_phone == digits)
        .order_by(Report.created_at.desc())
    ).first()
    return session.get(Case, report.case_id) if report else None


# --------------------------------------------------------------------------
# Reports: the deduplication path
# --------------------------------------------------------------------------


def file_report(
    session: Session,
    *,
    issue_type: IssueType | None,
    location: str | None,
    description: str | None,
    reporter_name: str | None = None,
    reporter_phone: str | None = None,
    call_id: int | None = None,
    actor: str = "voice_agent",
) -> tuple[Report, Case, bool]:
    """File a resident's report, attaching it to an existing case when the city
    already knows about this problem.

    Returns ``(report, case, merged)``. ``merged`` is what the agent reads back
    to the caller: "we already have that one, I have added your report to it".
    """
    open_cases = session.exec(
        select(Case).where(Case.status != CaseStatus.resolved).order_by(Case.created_at.desc())
    ).all()
    match = triage.find_duplicate(open_cases, issue_type, location)

    merged = match is not None
    if merged:
        case, similarity = match
    else:
        case = create_case(
            session,
            {
                "issue_type": issue_type,
                "location": location,
                "description": description,
            },
            actor=actor,
        )
        similarity = 1.0

    report = Report(
        case_id=case.id,
        call_id=call_id,
        reporter_name=reporter_name,
        reporter_phone=reporter_phone,
        description=description,
    )
    session.add(report)
    session.commit()
    session.refresh(report)

    case.report_count += 1
    case.updated_at = utcnow()
    _log(
        session,
        kind="report.merged" if merged else "report.filed",
        case_id=case.id,
        call_id=call_id,
        field="report_count",
        old=case.report_count - 1,
        new=case.report_count,
        actor=actor,
    )
    _reprice(session, case, actor=actor)
    session.add(case)
    session.commit()
    session.refresh(case)
    session.refresh(report)

    hub.publish(
        "report.filed",
        {
            "report": serialize(report),
            "case": serialize(case),
            "merged": merged,
            "similarity": round(similarity, 2),
        },
    )
    return report, case, merged


def update_report(session: Session, report: Report, data: dict[str, Any]) -> Report:
    for field in ("reporter_name", "reporter_phone", "description"):
        if data.get(field) is not None:
            setattr(report, field, data[field])
    session.add(report)
    session.commit()
    session.refresh(report)

    case = session.get(Case, report.case_id)
    hub.publish("report.updated", {"report": serialize(report), "case_id": report.case_id})
    if case:
        hub.publish("case.updated", {"case": serialize(case), "changed": []})
    return report


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
    for field in ("case_id", "report_id", "summary", "caller_phone"):
        if data.get(field) is not None:
            setattr(call, field, data[field])

    status = data.get("status")
    if status in (CallStatus.completed, CallStatus.completed.value):
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

"""All writes funnel through here.

The invariant this module exists to hold: *every* change to a case writes an
``Event`` row and broadcasts the same change on the websocket hub. Handlers
never mutate a model directly, so the audit log and the live dashboard can
never drift from the database.

Two rules make that broadcast trustworthy rather than merely present.

*Ordering is durable.* A frame is written to the ``Outbox`` and committed
before it is broadcast, and the outbox row's primary key is the frame's
``seq``. A client that reconnects replays the rows it missed instead of
guessing, and a restart of the process does not reset the counter.

*Silence means nothing happened.* Every update frame carries the list of fields
that actually moved, and an update where nothing moved publishes no frame at
all. The voice agent PATCHes the same case a dozen times a call; the dashboard
should flicker only when there is something to see.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from sqlmodel import Session, select

from server import triage
from server.hub import PROTOCOL_VERSION, hub
from server.models import (
    Call,
    CallPhase,
    CallStatus,
    Case,
    CaseStatus,
    Event,
    IssueType,
    LocationPrecision,
    Outbox,
    Report,
    Turn,
    utcnow,
)

# Fields the voice agent and the dashboard are allowed to set on a case.
MUTABLE_CASE_FIELDS = {
    "issue_type",
    "issue_type_confidence",
    "department",
    "location",
    "location_text",
    "location_formatted",
    "latitude",
    "longitude",
    "location_precision",
    "location_detail",
    "description",
    "status",
    "priority",
    "notes",
    "summary",
}

# What the geocoder owns. Moving ``location`` invalidates all of them at once,
# and a geocode rewrites all of them at once, because a formatted address from
# one lookup beside coordinates from another is not a location, it is a bug.
GEOCODED_CASE_FIELDS = ("location_formatted", "latitude", "longitude", "location_precision")

MUTABLE_REPORT_FIELDS = ("reporter_name", "reporter_phone", "description")

# Fields a PATCH on a call may set. ``phase`` and ``status`` are not here: they
# are lifecycle, handled explicitly above the loop that walks this tuple.
MUTABLE_CALL_FIELDS = (
    "case_id",
    "report_id",
    "summary",
    "caller_phone",
    "caller_name",
    "caller_city",
    "line_type",
    "language",
    "sentiment",
    "activity_line",
)

# The subset a supervisor is watching rather than plumbing, so each one is
# worth an audit row of its own.
AUDITED_CALL_FIELDS = frozenset(
    {"caller_name", "caller_city", "line_type", "language", "sentiment", "activity_line"}
)

# How much history a reconnecting dashboard can replay. Roughly an hour of a
# busy call centre: long enough that a laptop lid closed over lunch still
# resumes, short enough that the table stays small.
OUTBOX_RETENTION = 2000

# ``seq`` must be gap-free and strictly increasing, so reading the high-water
# mark and inserting the next row is one indivisible step.
_SEQ_LOCK = threading.Lock()


def serialize(obj: Any) -> dict[str, Any]:
    data = obj.model_dump()
    for key, value in data.items():
        if hasattr(value, "isoformat"):
            data[key] = value.isoformat()
        elif hasattr(value, "value"):
            data[key] = value.value
    if isinstance(obj, Call):
        # Formatted once, here, so every client renders the same number.
        data["caller_phone_display"] = format_phone(obj.caller_phone)
    return data


def format_phone(raw: str | None) -> str | None:
    """``5105551212`` -> ``+1 (510) 555-1212``. Anything else comes back as-is.

    Storage stays digits, because that is what lookups match on. This is
    presentation, and a number the city cannot parse is shown exactly as the
    caller gave it rather than mangled into a shape it does not have.
    """
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return raw
    return f"+1 ({digits[:3]}) {digits[3:6]}-{digits[6:]}"


# --------------------------------------------------------------------------
# The publish path
# --------------------------------------------------------------------------


def _emit(session: Session, frames: list[tuple[str, Any]]) -> list[dict[str, Any]]:
    """Persist each frame in the outbox, then broadcast it.

    Persist-then-broadcast, never the other way round: a frame a client saw but
    cannot replay is worse than one that is late.
    """
    if not frames:
        return []

    sent: list[dict[str, Any]] = []
    with _SEQ_LOCK:
        for type_, payload in frames:
            row = Outbox(type=type_, frame="")
            session.add(row)
            session.flush()  # the database assigns seq
            frame = {
                "v": PROTOCOL_VERSION,
                "seq": row.seq,
                "ts": row.ts.isoformat(),
                "type": type_,
                "payload": payload,
            }
            row.frame = json.dumps(frame)
            session.add(row)
            sent.append(frame)
        _trim_outbox(session)
        _commit_without_expiring(session)

    for frame in sent:
        hub.broadcast(frame)
    return sent


def _commit_without_expiring(session: Session) -> None:
    """Commit the outbox rows without invalidating the caller's objects.

    The domain change is already committed by the time we get here, so this
    commit is bookkeeping. Letting it expire the case the handler is about to
    serialize would make publishing a frame corrupt the response to the request
    that caused it.
    """
    previous = session.expire_on_commit
    session.expire_on_commit = False
    try:
        session.commit()
    finally:
        session.expire_on_commit = previous


def _trim_outbox(session: Session) -> None:
    """Keep only the most recent window. Old history helps nobody resume."""
    newest = session.exec(select(Outbox.seq).order_by(Outbox.seq.desc())).first()
    if newest is None or newest <= OUTBOX_RETENTION:
        return
    cutoff = newest - OUTBOX_RETENTION
    for row in session.exec(select(Outbox).where(Outbox.seq <= cutoff)).all():
        session.delete(row)


def publish(session: Session, type_: str, payload: Any) -> None:
    """Broadcast one domain frame, preceded by the audit rows that explain it.

    Audit rows go first so a dashboard applying frames in order sees the
    reasons before the result.
    """
    frames: list[tuple[str, Any]] = [
        ("event.appended", row) for row in _drain_events(session)
    ]
    frames.append((type_, payload))
    _emit(session, frames)


def _drain_events(session: Session) -> list[dict[str, Any]]:
    return session.info.pop("pending_events", [])


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
    # Flush to get the id, then keep a snapshot rather than the instance: the
    # caller's own commit would expire the object before it is ever published.
    session.flush()
    session.info.setdefault("pending_events", []).append(serialize(event))
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


def _gated_issue_type(data: dict[str, Any]) -> dict[str, Any]:
    """Drop a classification the classifier itself does not believe.

    The confidence still gets stored. A case the city knows it cannot yet
    categorise is a different thing from a case nobody has looked at, and the
    dashboard should be able to tell them apart.
    """
    payload = {k: v for k, v in data.items() if k in MUTABLE_CASE_FIELDS}
    if "issue_type" not in payload:
        return payload
    if not triage.classification_accepted(payload.get("issue_type_confidence")):
        payload.pop("issue_type")
    return payload


def create_case(session: Session, data: dict[str, Any], *, actor: str = "voice_agent") -> Case:
    case = Case(**_gated_issue_type(data))
    if case.department is None or data.get("department") is None:
        case.department = triage.route(case.issue_type)
    if case.location and not case.location_text:
        # Nobody has edited it yet, so what the caller said and what the case
        # records are the same string. They diverge the moment staff tidy one up.
        case.location_text = case.location
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

    publish(session, "case.created", serialize(case))
    return case


def update_case(
    session: Session,
    case: Case,
    data: dict[str, Any],
    *,
    actor: str = "voice_agent",
) -> Case:
    """Apply a partial update, logging one event per field that actually moved."""
    gated = _gated_issue_type(data)
    changed: list[str] = []
    for field, value in gated.items():
        if value is None:
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

    if "location" in changed:
        changed += _relocate(case, gated)

    # A corrected issue type re-routes the case. Routing is never typed by hand.
    if "issue_type" in changed and "department" not in gated:
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
        # Nothing moved. The agent re-sending what it already told us is not
        # news, so the dashboard hears nothing.
        return case

    case.updated_at = utcnow()
    session.add(case)
    session.commit()
    session.refresh(case)

    publish(session, "case.updated", {"case": serialize(case), "changed": changed})
    return case


def _relocate(case: Case, gated: dict[str, Any]) -> list[str]:
    """The location moved. Carry the caller's words across and drop the old pin.

    Coordinates are an answer to a question about a *particular* string. Once
    that string changes the old answer is not merely stale, it points somewhere
    the case is not, so it is cleared and the case goes back to ``unresolved``
    until the geocoder catches up. Anything the caller of this function set
    explicitly stands: a staff member correcting an address and its pin in one
    PATCH means both, not one overwriting the other.
    """
    moved: list[str] = []
    if "location_text" not in gated:
        case.location_text = case.location
        moved.append("location_text")
    for field in GEOCODED_CASE_FIELDS:
        if field in gated:
            continue
        blank = LocationPrecision.unresolved if field == "location_precision" else None
        if getattr(case, field) != blank:
            setattr(case, field, blank)
            moved.append(field)
    return moved


def apply_geocode(
    session: Session,
    case: Case,
    *,
    formatted: str | None,
    latitude: float | None,
    longitude: float | None,
    precision: LocationPrecision,
    actor: str = "system",
) -> Case:
    """Record what the geocoder made of this case's location.

    This is deliberately not a frame type of its own. A resolved location is
    the case changing, exactly like a corrected category is, so it rides
    ``case.updated`` with ``changed`` naming which of the location fields moved
    - and publishes nothing at all when the answer is the one already stored.
    """
    values = {
        "location_formatted": formatted,
        "latitude": latitude,
        "longitude": longitude,
        "location_precision": precision,
    }
    changed: list[str] = []
    for field, value in values.items():
        if getattr(case, field) == value:
            continue
        _log(
            session,
            kind="case.updated",
            case_id=case.id,
            field=field,
            old=getattr(case, field),
            new=value,
            actor=actor,
        )
        setattr(case, field, value)
        changed.append(field)

    if not changed:
        return case

    case.updated_at = utcnow()
    session.add(case)
    session.commit()
    session.refresh(case)

    publish(session, "case.updated", {"case": serialize(case), "changed": changed})
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

    publish(session, "case.escalated", serialize(case))
    return case


def append_note(session: Session, case: Case, note: str, *, actor: str = "voice_agent") -> Case:
    stamped = f"[{utcnow().strftime('%Y-%m-%d %H:%M')}] {note}"
    case.notes = f"{case.notes}\n{stamped}" if case.notes else stamped
    case.updated_at = utcnow()
    session.add(case)
    _log(session, kind="note.added", case_id=case.id, field="notes", new=note, actor=actor)
    session.commit()
    session.refresh(case)

    publish(session, "case.updated", {"case": serialize(case), "changed": ["notes"]})
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
    issue_type_confidence: float | None = None,
    reporter_name: str | None = None,
    reporter_phone: str | None = None,
    call_id: int | None = None,
    actor: str = "voice_agent",
) -> tuple[Report, Case, bool]:
    """File a resident's report, attaching it to an existing case when the city
    already knows about this problem.

    Returns ``(report, case, merged)``. ``merged`` is what the agent reads back
    to the caller: "we already have that one, I have added your report to it".

    A classification below the confidence threshold is not merged on. Guessing
    "pothole" at 0.3 and folding the caller into somebody else's pothole case
    would hide their report behind a coin flip.
    """
    if not triage.classification_accepted(issue_type_confidence):
        issue_type = None

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
                "issue_type_confidence": issue_type_confidence,
                "location": location,
                "location_text": location,
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

    publish(
        session,
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
    """Save corrected reporter details, and say which ones actually changed."""
    changed: list[str] = []
    for field in MUTABLE_REPORT_FIELDS:
        value = data.get(field)
        if value is None or getattr(report, field) == value:
            continue
        setattr(report, field, value)
        changed.append(field)

    if not changed:
        return report

    session.add(report)
    session.commit()
    session.refresh(report)

    publish(
        session,
        "report.updated",
        {"report": serialize(report), "case_id": report.case_id, "changed": changed},
    )
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

    publish(session, "call.started", serialize(call))
    return call


def set_phase(
    session: Session,
    call: Call,
    phase: CallPhase | str,
    *,
    actor: str = "voice_agent",
) -> Call:
    """Move a live call to its next phase, or do nothing if it is already there.

    A phase change is its own frame. Staff watching the board are reading one
    signal - what is happening on this call right now - and burying it in a
    multi-field update makes it something they have to go looking for.
    """
    new = CallPhase(phase)
    if call.phase == new:
        return call

    _log(
        session,
        kind="call.phase",
        call_id=call.id,
        case_id=call.case_id,
        field="phase",
        old=call.phase,
        new=new,
        actor=actor,
    )
    call.phase = new
    session.add(call)
    session.commit()
    session.refresh(call)

    publish(session, "call.updated", {"call": serialize(call), "changed": ["phase"]})
    return call


def update_call(
    session: Session,
    call: Call,
    data: dict[str, Any],
    *,
    actor: str = "voice_agent",
) -> Call:
    status = data.get("status")
    completing = status in (CallStatus.completed, CallStatus.completed.value)

    # Hanging up ends the call whatever else the caller of this function said.
    if data.get("phase") is not None:
        call = set_phase(session, call, data["phase"], actor=actor)
    if completing:
        call = set_phase(session, call, CallPhase.ended, actor="system")

    changed: list[str] = []
    for field in MUTABLE_CALL_FIELDS:
        value = data.get(field)
        if value is None or getattr(call, field) == value:
            continue
        if field in AUDITED_CALL_FIELDS:
            _log(
                session,
                kind="call.updated",
                call_id=call.id,
                case_id=call.case_id,
                field=field,
                old=getattr(call, field),
                new=value,
                actor=actor,
            )
        setattr(call, field, value)
        changed.append(field)

    if completing and call.status != CallStatus.completed:
        call.status = CallStatus.completed
        call.ended_at = utcnow()
        changed += ["status", "ended_at"]
        _log(session, kind="call.ended", call_id=call.id, case_id=call.case_id, actor="system")

    if not changed:
        return call

    session.add(call)
    session.commit()
    session.refresh(call)

    publish(session, "call.updated", {"call": serialize(call), "changed": changed})
    return call


def next_turn_seq(session: Session, call_id: int) -> int:
    """The number the next final turn on this call will carry.

    Interim frames are broadcast under it before the turn exists, which is what
    lets the dashboard replace a provisional line with the real one.
    """
    latest = session.exec(
        select(Turn.turn_seq).where(Turn.call_id == call_id).order_by(Turn.turn_seq.desc())
    ).first()
    return (latest or 0) + 1


def add_turn(session: Session, call: Call, role: str, text: str) -> Turn:
    turn = Turn(call_id=call.id, turn_seq=next_turn_seq(session, call.id), role=role, text=text)
    session.add(turn)
    session.commit()
    session.refresh(turn)

    publish(session, "transcript.turn", serialize(turn))
    return turn


def add_interim(session: Session, call: Call, role: str, text: str) -> dict[str, Any]:
    """Broadcast a half-spoken utterance without writing it down.

    Interim speech is a guess the recognizer is still revising, so it is
    streamed and forgotten. ``text`` is always the full utterance so far: the
    dashboard replaces the provisional line, it never concatenates, because a
    revised guess can be shorter than the one before it.
    """
    payload = {
        "call_id": call.id,
        "turn_seq": next_turn_seq(session, call.id),
        "role": role,
        "text": text,
        "final": False,
    }
    publish(session, "transcript.delta", payload)
    return payload

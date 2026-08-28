"""FastAPI app: case + call REST API, plus a websocket that streams every change.

Two clients talk to this service:

* the LiveKit voice agent, which creates and updates cases mid-conversation;
* the Next.js dashboard, which reads cases and subscribes to ``/ws``.
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from livekit import api as lkapi
from sqlmodel import Session, select

from server import geocode, store
from server.db import get_session, init_db
from server.hub import envelope as hub_envelope
from server.hub import hub
from server.models import Call, CallStatus, Case, Event, Outbox, Report, Turn
from server.schemas import (
    CallCreate,
    CallUpdate,
    CaseCreate,
    CaseUpdate,
    EscalateRequest,
    InterimCreate,
    NoteCreate,
    ReportCreate,
    ReportUpdate,
    TokenRequest,
    TurnCreate,
)

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    hub.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="Emma311 Case API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from server.analytics import router as stats_router  # noqa: E402  (kept local to one hunk)

app.include_router(stats_router)


def _case_or_404(session: Session, case_id: int) -> Case:
    case = session.get(Case, case_id)
    if not case:
        raise HTTPException(404, "case not found")
    return case


def _call_or_404(session: Session, call_id: int) -> Call:
    call = session.get(Call, call_id)
    if not call:
        raise HTTPException(404, "call not found")
    return call


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------


@app.post("/api/cases", status_code=201)
async def create_case(
    body: CaseCreate,
    background: BackgroundTasks,
    actor: str = "voice_agent",
    session: Session = Depends(get_session),
):
    case = store.create_case(session, body.model_dump(exclude_none=True), actor=actor)
    geocode.schedule(background, case)
    return store.serialize(case)


@app.get("/api/cases")
async def list_cases(
    q: str | None = None,
    status: str | None = None,
    session: Session = Depends(get_session),
):
    statement = select(Case).order_by(Case.priority_score.desc(), Case.updated_at.desc())
    if status:
        statement = statement.where(Case.status == status)
    cases = session.exec(statement).all()

    if q:
        needle = q.lower().strip()
        cases = [
            c
            for c in cases
            if needle
            in " ".join(
                filter(
                    None,
                    [
                        c.case_number,
                        c.location,
                        c.description,
                        c.issue_type.value if c.issue_type else None,
                        c.department.value if c.department else None,
                    ],
                )
            ).lower()
        ]
    return [store.serialize(c) for c in cases]


@app.get("/api/cases/lookup")
async def lookup_case(identifier: str, session: Session = Depends(get_session)):
    """Used by the voice agent when a caller asks about an existing request."""
    case = store.find_case(session, identifier)
    if not case:
        raise HTTPException(404, "case not found")
    return store.serialize(case)


@app.get("/api/cases/{case_id}")
async def get_case(case_id: int, session: Session = Depends(get_session)):
    return store.serialize(_case_or_404(session, case_id))


@app.patch("/api/cases/{case_id}")
async def update_case(
    case_id: int,
    body: CaseUpdate,
    background: BackgroundTasks,
    actor: str = "staff",
    session: Session = Depends(get_session),
):
    case = _case_or_404(session, case_id)
    case = store.update_case(session, case, body.model_dump(exclude_none=True), actor=actor)
    geocode.schedule(background, case)
    return store.serialize(case)


@app.post("/api/cases/{case_id}/notes", status_code=201)
async def add_note(
    case_id: int,
    body: NoteCreate,
    actor: str = "staff",
    session: Session = Depends(get_session),
):
    case = _case_or_404(session, case_id)
    return store.serialize(store.append_note(session, case, body.note, actor=actor))


@app.get("/api/cases/{case_id}/events")
async def case_events(case_id: int, session: Session = Depends(get_session)):
    events = session.exec(
        select(Event).where(Event.case_id == case_id).order_by(Event.created_at.asc())
    ).all()
    return [store.serialize(e) for e in events]


@app.get("/api/cases/{case_id}/calls")
async def case_calls(case_id: int, session: Session = Depends(get_session)):
    calls = session.exec(
        select(Call).where(Call.case_id == case_id).order_by(Call.started_at.asc())
    ).all()
    return [store.serialize(c) for c in calls]


@app.post("/api/cases/{case_id}/escalate")
async def escalate_case(
    case_id: int,
    body: EscalateRequest,
    actor: str = "voice_agent",
    session: Session = Depends(get_session),
):
    case = _case_or_404(session, case_id)
    return store.serialize(store.escalate(session, case, body.reason, actor=actor))


@app.get("/api/cases/{case_id}/reports")
async def case_reports(case_id: int, session: Session = Depends(get_session)):
    reports = session.exec(
        select(Report).where(Report.case_id == case_id).order_by(Report.created_at.desc())
    ).all()
    return [store.serialize(r) for r in reports]


# --------------------------------------------------------------------------
# Reports: filing one is what triggers deduplication
# --------------------------------------------------------------------------


@app.post("/api/reports", status_code=201)
async def file_report(
    body: ReportCreate,
    background: BackgroundTasks,
    actor: str = "voice_agent",
    session: Session = Depends(get_session),
):
    report, case, merged = store.file_report(
        session,
        issue_type=body.issue_type,
        issue_type_confidence=body.issue_type_confidence,
        location=body.location,
        description=body.description,
        reporter_name=body.reporter_name,
        reporter_phone=body.reporter_phone,
        call_id=body.call_id,
        actor=actor,
    )
    geocode.schedule(background, case)
    return {
        "report": store.serialize(report),
        "case": store.serialize(case),
        "merged": merged,
    }


@app.patch("/api/reports/{report_id}")
async def patch_report(
    report_id: int,
    body: ReportUpdate,
    session: Session = Depends(get_session),
):
    report = session.get(Report, report_id)
    if not report:
        raise HTTPException(404, "report not found")
    return store.serialize(store.update_report(session, report, body.model_dump(exclude_none=True)))


# --------------------------------------------------------------------------
# Calls and transcript
# --------------------------------------------------------------------------


@app.post("/api/calls", status_code=201)
async def create_call(body: CallCreate, session: Session = Depends(get_session)):
    call = store.start_call(session, body.room, body.caller_phone)
    return store.serialize(call)


@app.get("/api/calls")
async def list_calls(session: Session = Depends(get_session)):
    calls = session.exec(select(Call).order_by(Call.started_at.desc())).all()
    return [store.serialize(c) for c in calls]


@app.get("/api/calls/active")
async def active_calls(session: Session = Depends(get_session)):
    calls = session.exec(
        select(Call).where(Call.status == CallStatus.active).order_by(Call.started_at.desc())
    ).all()
    return [store.serialize(c) for c in calls]


@app.get("/api/calls/{call_id}")
async def get_call(call_id: int, session: Session = Depends(get_session)):
    return store.serialize(_call_or_404(session, call_id))


@app.patch("/api/calls/{call_id}")
async def patch_call(
    call_id: int,
    body: CallUpdate,
    actor: str = "voice_agent",
    session: Session = Depends(get_session),
):
    call = _call_or_404(session, call_id)
    return store.serialize(
        store.update_call(session, call, body.model_dump(exclude_none=True), actor=actor)
    )


@app.post("/api/calls/{call_id}/turns", status_code=201)
async def add_turn(call_id: int, body: TurnCreate, session: Session = Depends(get_session)):
    call = _call_or_404(session, call_id)
    return store.serialize(store.add_turn(session, call, body.role, body.text))


@app.get("/api/calls/{call_id}/turns")
async def list_turns(call_id: int, session: Session = Depends(get_session)):
    turns = session.exec(
        select(Turn).where(Turn.call_id == call_id).order_by(Turn.turn_seq.asc())
    ).all()
    return [store.serialize(t) for t in turns]


@app.post("/api/calls/{call_id}/interim", status_code=202)
async def add_interim(call_id: int, body: InterimCreate, session: Session = Depends(get_session)):
    """Stream a half-spoken utterance to the dashboard without storing it.

    202, not 201: nothing was created. The frame is the whole point.
    """
    call = _call_or_404(session, call_id)
    return store.add_interim(session, call, body.role, body.text)


# --------------------------------------------------------------------------
# LiveKit access token for the browser "start a call" button
# --------------------------------------------------------------------------


@app.post("/api/token")
async def livekit_token(body: TokenRequest):
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    if not api_key or not api_secret:
        raise HTTPException(500, "LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured")

    room = body.room or f"intake-{os.urandom(3).hex()}"
    identity = body.identity or f"resident-{os.urandom(3).hex()}"

    token = (
        lkapi.AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_name("Resident")
        .with_ttl(timedelta(hours=1))
        .with_grants(lkapi.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True))
    )
    return {
        "token": token.to_jwt(),
        "url": os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        "room": room,
        "identity": identity,
    }


# --------------------------------------------------------------------------
# Live updates
# --------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, since: int | None = None, session: Session = Depends(get_session)):
    """Live event stream, resumable.

    Connect with ``?since=<seq>`` and the server replays exactly what that
    client missed, from the outbox, byte-identical to what it broadcast the
    first time. Without a usable ``since`` it says so, and the client refetches
    over REST rather than sitting on state it cannot trust.
    """
    client = await hub.connect(ws)
    try:
        latest, replay = _resume_window(session, since)
        frames = None if replay is None else [row.frame for row in replay]
        # The database is only needed for the resume window. Holding the
        # request-scoped session open for the life of the socket would also
        # hold its pooled connection, so a handful of open dashboards would
        # exhaust the pool and every REST request would block behind them.
        session.close()

        client.skip_through = latest

        if frames is None:
            await ws.send_json(
                hub_envelope("hello", {"latest_seq": latest, "resume": False})
            )
        else:
            await ws.send_json(
                hub_envelope(
                    "hello",
                    {
                        "latest_seq": latest,
                        "resume": True,
                        "from": since + 1,
                        "to": latest,
                    },
                )
            )
            for frame in frames:
                await ws.send_text(frame)

        # Only now start the writer: anything published during the replay is
        # already queued, and the seq filter drops what the replay covered.
        hub.start_writer(client)

        while True:
            raw = await ws.receive_text()
            if _is_ping(raw):
                # Queued, not sent directly: one writer per socket means the
                # client can use a pong to fence everything published before it.
                client.offer(hub_envelope("pong", {}))
            # Anything else is ignored on purpose. An unknown frame from a
            # newer dashboard should not take the connection down.
    except WebSocketDisconnect:
        hub.disconnect(client)
    except Exception:
        hub.disconnect(client)


def _resume_window(session: Session, since: int | None) -> tuple[int, list[Outbox] | None]:
    """The high-water mark, and the rows to replay, or ``None`` for no resume.

    A resume is refused when ``since`` is absent, negative, ahead of the server
    (a stale client talking to a rebuilt database), or older than the retained
    window. In every one of those cases the client's local state is a guess,
    and a guess is what a resync exists to throw away.
    """
    latest = session.exec(select(Outbox.seq).order_by(Outbox.seq.desc())).first() or 0
    if since is None or since < 0 or since > latest:
        return latest, None

    oldest = session.exec(select(Outbox.seq).order_by(Outbox.seq.asc())).first()
    if oldest is not None and since < oldest - 1:
        return latest, None  # the frames it needs have been trimmed away

    rows = session.exec(
        select(Outbox).where(Outbox.seq > since).order_by(Outbox.seq.asc())
    ).all()
    return latest, list(rows)


def _is_ping(raw: str) -> bool:
    try:
        return json.loads(raw).get("type") == "ping"
    except (ValueError, AttributeError):
        return False

"""FastAPI app: case + call REST API, plus a websocket that streams every change.

Two clients talk to this service:

* the LiveKit voice agent, which creates and updates cases mid-conversation;
* the Next.js dashboard, which reads cases and subscribes to ``/ws``.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from livekit import api as lkapi
from sqlmodel import Session, select

from server import store
from server.db import get_session, init_db
from server.hub import hub
from server.models import Call, CallStatus, Case, Event, Turn
from server.schemas import (
    CallCreate,
    CallUpdate,
    CaseCreate,
    CaseUpdate,
    NoteCreate,
    TokenRequest,
    TurnCreate,
)

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    hub.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="EffiGov Case API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    actor: str = "voice_agent",
    session: Session = Depends(get_session),
):
    case = store.create_case(session, body.model_dump(exclude_none=True), actor=actor)
    return store.serialize(case)


@app.get("/api/cases")
async def list_cases(
    q: str | None = None,
    status: str | None = None,
    session: Session = Depends(get_session),
):
    statement = select(Case).order_by(Case.updated_at.desc())
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
                        c.caller_name,
                        c.phone,
                        c.address,
                        c.description,
                        c.issue_type.value if c.issue_type else None,
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
    actor: str = "staff",
    session: Session = Depends(get_session),
):
    case = _case_or_404(session, case_id)
    case = store.update_case(session, case, body.model_dump(exclude_none=True), actor=actor)
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
async def patch_call(call_id: int, body: CallUpdate, session: Session = Depends(get_session)):
    call = _call_or_404(session, call_id)
    return store.serialize(store.update_call(session, call, body.model_dump(exclude_none=True)))


@app.post("/api/calls/{call_id}/turns", status_code=201)
async def add_turn(call_id: int, body: TurnCreate, session: Session = Depends(get_session)):
    call = _call_or_404(session, call_id)
    return store.serialize(store.add_turn(session, call, body.role, body.text))


@app.get("/api/calls/{call_id}/turns")
async def list_turns(call_id: int, session: Session = Depends(get_session)):
    turns = session.exec(
        select(Turn).where(Turn.call_id == call_id).order_by(Turn.created_at.asc())
    ).all()
    return [store.serialize(t) for t in turns]


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
async def websocket_endpoint(ws: WebSocket):
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()  # client sends nothing; this just detects hangup
    except WebSocketDisconnect:
        hub.disconnect(ws)
    except Exception:
        hub.disconnect(ws)

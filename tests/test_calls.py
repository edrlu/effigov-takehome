"""Call -> Report -> Case: what a call is, and what it stops being.

A call is the record of one conversation that happened. While it is up
everything about it moves, because that live view is the product. Completion is
the line: after it, nothing may rewrite what was said or what state the call was
in. A resident who wants to correct something is amending their *report*.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from server.db import get_session
from server.main import app


@pytest.fixture()
def client():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


POTHOLE = {
    "issue_type": "pothole",
    "location": "Shattuck Avenue near University",
    "description": "Huge pothole in the eastbound lane.",
}


def _call(client, room="intake-1"):
    return client.post("/api/calls", json={"room": room}).json()


def test_a_live_call_still_moves(client):
    """The whole live-observability feature, which sealing must not break."""
    call = _call(client)

    for payload in (
        {"phase": "gathering", "activity_line": "Taking a report about a pothole."},
        {"sentiment": "negative"},
        {"caller_name": "Edward Lu"},
    ):
        assert client.patch(f"/api/calls/{call['id']}", json=payload).status_code == 200

    assert client.post(
        f"/api/calls/{call['id']}/turns", json={"role": "caller", "text": "There is a hole."}
    ).status_code == 201
    assert client.post(
        f"/api/calls/{call['id']}/interim", json={"role": "caller", "text": "There is a"}
    ).status_code == 202

    after = client.get(f"/api/calls/{call['id']}").json()
    assert after["phase"] == "gathering"
    assert after["sentiment"] == "negative"
    assert after["caller_name"] == "Edward Lu"


def test_completing_a_call_carries_its_summary(client):
    """The write that performs the transition is the transition, and is allowed."""
    call = _call(client)
    done = client.patch(
        f"/api/calls/{call['id']}",
        json={"status": "completed", "summary": "Pothole reported on Shattuck."},
    ).json()

    assert done["status"] == "completed"
    assert done["phase"] == "ended"
    assert done["ended_at"] is not None
    assert done["summary"] == "Pothole reported on Shattuck."


def test_a_completed_call_refuses_to_be_rewritten(client):
    call = _call(client)
    client.patch(f"/api/calls/{call['id']}", json={"status": "completed", "summary": "Done."})

    for payload in (
        {"summary": "Actually it was something else."},
        {"caller_name": "Somebody Else"},
        {"sentiment": "positive"},
        {"phase": "gathering"},
    ):
        response = client.patch(f"/api/calls/{call['id']}", json=payload)
        assert response.status_code == 409, payload
        assert "cannot be changed" in response.json()["detail"]

    unchanged = client.get(f"/api/calls/{call['id']}").json()
    assert unchanged["summary"] == "Done."
    assert unchanged["caller_name"] is None


def test_a_completed_calls_transcript_is_closed(client):
    call = _call(client)
    client.post(f"/api/calls/{call['id']}/turns", json={"role": "caller", "text": "Hello."})
    client.patch(f"/api/calls/{call['id']}", json={"status": "completed"})

    assert client.post(
        f"/api/calls/{call['id']}/turns", json={"role": "caller", "text": "One more thing."}
    ).status_code == 409
    assert client.post(
        f"/api/calls/{call['id']}/interim", json={"role": "caller", "text": "One more"}
    ).status_code == 409

    turns = client.get(f"/api/calls/{call['id']}/turns").json()
    assert [t["text"] for t in turns] == ["Hello."]


def test_re_sending_the_completion_is_not_an_error(client):
    """A retry after a dropped response must not look like tampering."""
    call = _call(client)
    body = {"status": "completed", "summary": "Done."}
    assert client.patch(f"/api/calls/{call['id']}", json=body).status_code == 200
    assert client.patch(f"/api/calls/{call['id']}", json=body).status_code == 200


def test_a_call_that_files_a_report_is_linked_to_it(client):
    """Written by the backend, not by a follow-up request that might not arrive."""
    call = _call(client)
    filed = client.post("/api/reports", json={**POTHOLE, "call_id": call["id"]}).json()

    linked = client.get(f"/api/calls/{call['id']}").json()
    assert linked["report_id"] == filed["report"]["id"]
    assert linked["case_id"] == filed["case"]["id"]
    assert linked["produced_report"] is True


def test_a_call_that_produced_no_report_says_so(client):
    """A hangup, or somebody who only wanted a status. Legitimate, not data loss."""
    call = _call(client)
    client.patch(f"/api/calls/{call['id']}", json={"status": "completed"})

    ended = client.get(f"/api/calls/{call['id']}").json()
    assert ended["report_id"] is None
    assert ended["produced_report"] is False


def test_a_caller_ringing_back_gets_a_new_call_on_the_same_report(client):
    """The old call keeps saying what was said on it; the report is amended."""
    first = _call(client, room="intake-1")
    filed = client.post(
        "/api/reports",
        json={**POTHOLE, "call_id": first["id"], "reporter_phone": "5105551212"},
    ).json()
    client.patch(f"/api/calls/{first['id']}", json={"status": "completed", "summary": "One."})

    second = _call(client, room="intake-2")
    again = client.post(
        "/api/reports",
        json={
            **POTHOLE,
            "call_id": second["id"],
            "reporter_phone": "5105551212",
            "description": "Still there a week later.",
        },
    ).json()

    assert again["repeat"] is True
    assert again["report"]["id"] == filed["report"]["id"]
    assert again["case"]["report_count"] == 1

    assert client.get(f"/api/calls/{second['id']}").json()["report_id"] == filed["report"]["id"]
    # The first call is untouched by any of it.
    assert client.get(f"/api/calls/{first['id']}").json()["summary"] == "One."

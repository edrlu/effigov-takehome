"""One pass over the write path that the voice agent actually uses."""

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


def test_a_report_opens_a_routed_case(client):
    body = client.post("/api/reports", json=POTHOLE).json()
    assert body["merged"] is False
    assert body["case"]["department"] == "public_works"
    assert body["case"]["report_count"] == 1
    assert body["case"]["case_number"].startswith("SR-")


def test_a_second_caller_joins_the_same_case_and_raises_its_priority(client):
    first = client.post("/api/reports", json=POTHOLE).json()
    second = client.post(
        "/api/reports",
        json={
            "issue_type": "pothole",
            "location": "University Ave and Shattuck",
            "description": "Giant pothole at that intersection.",
        },
    ).json()

    assert second["merged"] is True
    assert second["case"]["id"] == first["case"]["id"]
    assert second["case"]["report_count"] == 2
    assert first["case"]["priority"] == "normal"
    assert second["case"]["priority"] == "high"


def test_both_residents_survive_the_merge(client):
    first = client.post("/api/reports", json=POTHOLE).json()
    client.patch(
        f"/api/reports/{first['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )
    second = client.post(
        "/api/reports",
        json={"issue_type": "pothole", "location": "University and Shattuck", "description": "Same hole."},
    ).json()
    client.patch(
        f"/api/reports/{second['report']['id']}",
        json={"reporter_name": "Priya Raman", "reporter_phone": "5105550188"},
    )

    reports = client.get(f"/api/cases/{first['case']['id']}/reports").json()
    assert {r["reporter_name"] for r in reports} == {"Edward Lu", "Priya Raman"}


def test_the_agent_can_find_a_case_by_either_reporters_phone(client):
    first = client.post("/api/reports", json=POTHOLE).json()
    client.patch(
        f"/api/reports/{first['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )
    found = client.get("/api/cases/lookup", params={"identifier": "(510) 555-1212"}).json()
    assert found["case_number"] == first["case"]["case_number"]


def test_correcting_the_issue_type_re_routes_the_case(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    updated = client.patch(f"/api/cases/{case['id']}", json={"issue_type": "water_leak"}).json()
    assert updated["department"] == "utilities"


def test_escalation_pins_a_case_to_the_top_of_the_queue(client):
    quiet = client.post(
        "/api/reports",
        json={"issue_type": "graffiti", "location": "12 Oak St", "description": "Tagging."},
    ).json()["case"]
    client.post(f"/api/cases/{quiet['id']}/escalate", json={"reason": "Sparking line nearby"})

    queue = client.get("/api/cases").json()
    assert queue[0]["id"] == quiet["id"]
    assert queue[0]["escalated"] is True
    assert queue[0]["priority"] == "high"


def test_every_change_lands_in_the_audit_log(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    client.patch(f"/api/cases/{case['id']}", json={"status": "in_progress"})
    client.post(f"/api/cases/{case['id']}/notes", json={"note": "Crew scheduled for Thursday."})

    kinds = [e["kind"] for e in client.get(f"/api/cases/{case['id']}/events").json()]
    assert kinds[:3] == ["case.created", "case.routed", "report.filed"]
    assert "case.updated" in kinds and "note.added" in kinds


def test_phone_is_formatted_once_on_the_server(client):
    """The console renders the number the server formatted, never its own guess."""
    call = client.post("/api/calls", json={"room": "phone-1"}).json()
    assert call["caller_phone_display"] is None

    ten = client.patch(f"/api/calls/{call['id']}", json={"caller_phone": "4155550189"}).json()
    assert ten["caller_phone"] == "4155550189"  # storage stays digits
    assert ten["caller_phone_display"] == "+1 (415) 555-0189"

    eleven = client.patch(f"/api/calls/{call['id']}", json={"caller_phone": "14155550188"}).json()
    assert eleven["caller_phone_display"] == "+1 (415) 555-0188"

    # Not a number the city can parse: shown exactly as it was given.
    odd = client.patch(f"/api/calls/{call['id']}", json={"caller_phone": "switchboard"}).json()
    assert odd["caller_phone_display"] == "switchboard"

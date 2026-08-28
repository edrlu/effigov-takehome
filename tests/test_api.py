"""One pass over the write path that the voice agent actually uses."""

from __future__ import annotations

import os

import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from server.db import get_session
from server.main import app

os.environ["EFFIGOV_GEOCODE"] = "0"
os.environ["EFFIGOV_SUMMARY"] = "0"


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


def test_lookup_offers_the_last_four_digits_and_never_the_whole_number(client):
    """The agent verifies a caller against these, so this is the whole payload.

    Anyone who has a case number can ask about the case. If the lookup handed
    back a full phone number, the agent would be one prompt away from reading a
    resident's number to a stranger.
    """
    filed = client.post("/api/reports", json=POTHOLE).json()
    client.patch(
        f"/api/reports/{filed['report']['id']}",
        json={"reporter_name": "Priya Raman", "reporter_phone": "5105550188"},
    )

    found = client.get(
        "/api/cases/lookup", params={"identifier": filed["case"]["case_number"]}
    ).json()

    assert found["reporter"]["name"] == "Priya Raman"
    assert found["reporter"]["phone_last4"] == "0188"
    assert "5105550188" not in json.dumps(found)


def test_lookup_verifies_a_second_reporter_against_their_own_number(client):
    """Looked up by phone, the person on file is whoever that number belongs to.

    Verifying a second reporter against the *first* reporter's digits would
    fail every time and push them into filing a duplicate of their own report.
    """
    filed = client.post("/api/reports", json=POTHOLE).json()
    client.patch(
        f"/api/reports/{filed['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )
    second = client.post(
        "/api/reports",
        json={**POTHOLE, "reporter_name": "Priya Raman", "reporter_phone": "5105550188"},
    ).json()
    assert second["merged"] is True

    found = client.get("/api/cases/lookup", params={"identifier": "5105550188"}).json()
    assert found["reporter"]["name"] == "Priya Raman"
    assert found["reporter"]["phone_last4"] == "0188"


def test_lookup_says_nothing_to_verify_against_when_nobody_left_details(client):
    filed = client.post("/api/reports", json=POTHOLE).json()
    found = client.get(
        "/api/cases/lookup", params={"identifier": filed["case"]["case_number"]}
    ).json()
    assert found["reporter"] is None


def test_an_unverified_caller_joins_the_case_they_named_as_a_new_reporter(client):
    """A second person calling about SR-x is a new reporter on that incident.

    Pinning the report to the case they named keeps them off the duplicate
    search, which could otherwise land them on a different case or open one.
    """
    filed = client.post("/api/reports", json=POTHOLE).json()
    case = filed["case"]
    client.patch(
        f"/api/reports/{filed['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )

    joined = client.post(
        "/api/reports",
        json={
            "case_id": case["id"],
            "reporter_name": "Priya Raman",
            "reporter_phone": "5105550188",
            "description": "Still there this morning, someone nearly went into it.",
        },
    ).json()

    assert joined["merged"] is True
    assert joined["case"]["id"] == case["id"]
    assert joined["case"]["report_count"] == 2

    reports = client.get(f"/api/cases/{case['id']}/reports").json()
    assert {r["reporter_name"] for r in reports} == {"Edward Lu", "Priya Raman"}


def test_a_second_reporter_does_not_re_categorise_the_case_they_joined(client):
    """They are adding their account, not overruling the city's routing."""
    case = client.post("/api/reports", json=POTHOLE).json()["case"]

    client.post(
        "/api/reports",
        json={
            "case_id": case["id"],
            "issue_type": "graffiti",
            "issue_type_confidence": 0.99,
            "location": "Somewhere else entirely",
            "reporter_name": "Priya Raman",
            "reporter_phone": "5105550188",
        },
    )

    after = client.get(f"/api/cases/{case['id']}").json()
    assert after["issue_type"] == "pothole"
    assert after["location"] == POTHOLE["location"]


def test_filing_against_a_case_that_does_not_exist_is_a_404(client):
    response = client.post(
        "/api/reports", json={"case_id": 9999, "reporter_name": "Nobody"}
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------
# One report per resident: corroboration counts people, not calls
# --------------------------------------------------------------------------


def test_the_same_caller_ringing_back_does_not_inflate_corroboration(client):
    """One neighbour phoning three times is not three neighbours.

    This is the whole basis of the priority bump, so it has to count people.
    """
    first = client.post(
        "/api/reports", json={**POTHOLE, "reporter_phone": "5105551212"}
    ).json()
    case_id = first["case"]["id"]
    score = first["case"]["priority_score"]

    again = client.post(
        "/api/reports",
        json={
            **POTHOLE,
            "reporter_phone": "5105551212",
            "description": "Still there, and it has got worse.",
        },
    ).json()

    assert again["case"]["id"] == case_id
    assert again["repeat"] is True
    assert again["case"]["report_count"] == 1
    assert again["case"]["priority_score"] == score

    reports = client.get(f"/api/cases/{case_id}/reports").json()
    assert len(reports) == 1
    # Their latest account replaced the earlier one; it did not sit beside it.
    assert reports[0]["description"] == "Still there, and it has got worse."


def test_two_different_numbers_are_two_residents(client):
    first = client.post(
        "/api/reports", json={**POTHOLE, "reporter_phone": "5105551212"}
    ).json()
    second = client.post(
        "/api/reports", json={**POTHOLE, "reporter_phone": "5105550188"}
    ).json()

    assert second["case"]["id"] == first["case"]["id"]
    assert second["repeat"] is False
    assert second["case"]["report_count"] == 2
    assert second["case"]["priority_score"] > first["case"]["priority_score"]


def test_a_caller_who_leaves_no_number_gets_their_own_report(client):
    """Nobody we can recognise again is nobody we can key.

    Each anonymous account is its own report rather than being dropped or
    folded into whoever else is on the case.
    """
    first = client.post("/api/reports", json=POTHOLE).json()
    second = client.post("/api/reports", json=POTHOLE).json()

    assert second["case"]["id"] == first["case"]["id"]
    assert second["repeat"] is False
    assert second["case"]["report_count"] == 2


def test_a_callers_detail_lands_on_their_report_not_on_the_case(client):
    """A later, vaguer caller must not overwrite a sharper one at case level."""
    first = client.post(
        "/api/reports", json={**POTHOLE, "reporter_phone": "5105551212"}
    ).json()
    case = first["case"]

    second = client.post(
        "/api/reports",
        json={
            **POTHOLE,
            "reporter_phone": "5105550188",
            "description": "Big hole somewhere along there.",
            "location": "Somewhere on Shattuck",
        },
    ).json()

    assert second["report"]["description"] == "Big hole somewhere along there."
    assert second["report"]["location"] == "Somewhere on Shattuck"

    after = client.get(f"/api/cases/{case['id']}").json()
    assert after["description"] == POTHOLE["description"]
    assert after["location"] == POTHOLE["location"]


def test_a_number_arriving_late_folds_into_the_report_that_already_has_it(client):
    """The agent files early and learns the number a minute later.

    That number can turn out to belong to a report the case already holds - the
    same resident, discovered late. Their details are kept, not refused.
    """
    first = client.post(
        "/api/reports",
        json={**POTHOLE, "reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    ).json()
    case_id = first["case"]["id"]

    late = client.post("/api/reports", json={**POTHOLE, "case_id": case_id}).json()
    assert late["case"]["report_count"] == 2

    folded = client.patch(
        f"/api/reports/{late['report']['id']}",
        json={"reporter_phone": "5105551212", "description": "Worse than I first said."},
    ).json()

    assert folded["id"] == first["report"]["id"]
    assert folded["reporter_name"] == "Edward Lu"
    assert folded["description"] == "Worse than I first said."

    reports = client.get(f"/api/cases/{case_id}/reports").json()
    assert len(reports) == 1
    assert client.get(f"/api/cases/{case_id}").json()["report_count"] == 1


# --------------------------------------------------------------------------
# Staff work the case, not the pile of reports under it
# --------------------------------------------------------------------------


def test_staff_can_promote_a_reports_wording_onto_the_case(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    better = client.post(
        "/api/reports",
        json={
            "case_id": case["id"],
            "reporter_phone": "5105550188",
            "description": "Crater about a foot across in the eastbound bike lane.",
            "location": "Shattuck Avenue at Berkeley Way, eastbound",
        },
    ).json()["report"]

    promoted = client.post(
        f"/api/cases/{case['id']}/promote-report", json={"report_id": better["id"]}
    ).json()

    assert promoted["description"] == "Crater about a foot across in the eastbound bike lane."
    assert promoted["location"] == "Shattuck Avenue at Berkeley Way, eastbound"

    kinds = [e["field"] for e in client.get(f"/api/cases/{case['id']}/events").json()]
    assert "description" in kinds and "location" in kinds


def test_promoting_takes_only_the_fields_asked_for(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    report = client.post(
        "/api/reports",
        json={
            "case_id": case["id"],
            "reporter_phone": "5105550188",
            "description": "Crater in the bike lane.",
            "location": "Somewhere vaguer",
        },
    ).json()["report"]

    promoted = client.post(
        f"/api/cases/{case['id']}/promote-report",
        json={"report_id": report["id"], "fields": ["description"]},
    ).json()

    assert promoted["description"] == "Crater in the bike lane."
    assert promoted["location"] == POTHOLE["location"]


def test_a_report_cannot_be_promoted_onto_a_case_it_does_not_belong_to(client):
    mine = client.post("/api/reports", json=POTHOLE).json()
    other = client.post(
        "/api/reports",
        json={
            "issue_type": "water_leak",
            "location": "Somewhere else entirely",
            "description": "Water across the pavement.",
        },
    ).json()

    response = client.post(
        f"/api/cases/{mine['case']['id']}/promote-report",
        json={"report_id": other["report"]["id"]},
    )
    assert response.status_code == 400


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

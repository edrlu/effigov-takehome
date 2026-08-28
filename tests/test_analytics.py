"""Dashboard aggregations: the empty case, and the one that needs the audit log."""

from __future__ import annotations

from datetime import timedelta

from sqlmodel import Session

from server.models import Case, CaseStatus, Event, IssueType, utcnow


def test_empty_database_returns_zeroes_not_errors(client):
    """A freshly created database is a demo state, not an error state."""
    summary = client.get("/api/stats/summary").json()
    assert summary["open_cases"] == {"value": 0, "change": 0, "series": [0] * 7}
    assert summary["avg_resolution_days"]["value"] == 0.0
    assert summary["live_calls"]["series"] == [0] * 7
    assert summary["escalations"]["series"] == [0] * 7

    volume = client.get("/api/stats/call-volume").json()
    assert volume["total"] == 0
    # No divide-by-zero, and still one dense bucket per day.
    assert volume["change_pct"] == 0.0
    assert [b["count"] for b in volume["buckets"]] == [0] * 7

    assert client.get("/api/stats/cases-by-type").json() == {"total": 0, "slices": []}
    assert client.get("/api/stats/needs-attention").json()["total"] == 0


def test_resolution_time_comes_from_the_audit_event(client, memory_engine):
    """``updated_at`` moves for any edit; only the status event dates the fix.

    Two resolved cases, four and two days to close, plus one resolved case with
    no transition event - that one has to be excluded rather than guessed at.
    """
    now = utcnow()
    with Session(memory_engine) as session:
        for case_number, age_days, resolved_days_ago in [
            ("SR-100001", 6, 2),  # 4 days to resolve
            ("SR-100002", 3, 1),  # 2 days to resolve
        ]:
            case = Case(
                case_number=case_number,
                issue_type=IssueType.pothole,
                status=CaseStatus.resolved,
                created_at=now - timedelta(days=age_days),
                # Touched today by an unrelated edit: if the average read this
                # instead of the event, both cases would look same-day.
                updated_at=now,
            )
            session.add(case)
            session.commit()
            session.refresh(case)
            session.add(
                Event(
                    case_id=case.id,
                    kind="case.updated",
                    field="status",
                    new_value="resolved",
                    created_at=now - timedelta(days=resolved_days_ago),
                )
            )

        session.add(
            Case(
                case_number="SR-100003",
                status=CaseStatus.resolved,
                created_at=now - timedelta(days=30),
            )
        )
        session.commit()

    summary = client.get("/api/stats/summary").json()
    assert summary["resolved_sample"] == 2
    assert summary["avg_resolution_days"]["value"] == 3.0
    # Dense series: resolutions two days ago and one day ago, zero elsewhere.
    assert summary["avg_resolution_days"]["series"] == [0.0, 0.0, 0.0, 0.0, 4.0, 2.0, 0.0]
    # All three are resolved, so nothing is open now, but the backlog series
    # still remembers that they were open earlier in the week.
    assert summary["open_cases"]["value"] == 0
    assert summary["open_cases"]["series"][0] > 0


def test_case_mix_folds_the_tail_and_the_unclassified_into_other(client, memory_engine):
    now = utcnow()
    with Session(memory_engine) as session:
        for index in range(6):
            session.add(Case(case_number=f"SR-2000{index:02d}", issue_type=IssueType.pothole))
        for index in range(2):
            session.add(Case(case_number=f"SR-3000{index:02d}", issue_type=IssueType.graffiti))
        # Never classified with enough confidence to act on: an "Other" slice
        # from a dispatcher's point of view, not a category of its own.
        session.add(Case(case_number="SR-400000", issue_type=None, created_at=now))
        session.add(Case(case_number="SR-400001", issue_type=IssueType.other))
        session.commit()

    body = client.get("/api/stats/cases-by-type").json()
    assert body["total"] == 10
    by_label = {s["label"]: s for s in body["slices"]}
    assert by_label["Pothole"] == {
        "issue_type": "pothole",
        "label": "Pothole",
        "count": 6,
        "percentage": 60.0,
    }
    assert by_label["Other"]["count"] == 2
    assert sum(s["count"] for s in body["slices"]) == body["total"]

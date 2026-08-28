"""The triage rules are the part of the system a city would want to argue with,
so they are the part that is tested. No model calls, no database, no network."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from server import triage
from server.models import Case, CaseStatus, Department, IssueType, Priority


def make_case(**kwargs) -> Case:
    defaults = {
        "issue_type": IssueType.pothole,
        "location": "Shattuck Avenue near University",
        "status": CaseStatus.new,
        "report_count": 1,
        "created_at": datetime.now(timezone.utc),
    }
    return Case(**{**defaults, "id": 1, **kwargs})


# -- routing ---------------------------------------------------------------


@pytest.mark.parametrize(
    "issue, department",
    [
        (IssueType.pothole, Department.public_works),
        (IssueType.missed_collection, Department.sanitation),
        (IssueType.water_leak, Department.utilities),
        (IssueType.noise_complaint, Department.code_enforcement),
        (None, Department.unassigned),
    ],
)
def test_routing(issue, department):
    assert triage.route(issue) is department


# -- location matching -----------------------------------------------------


def test_intersection_word_order_does_not_matter():
    assert triage.location_similarity("Shattuck and University", "University and Shattuck") == 1.0


def test_street_suffixes_are_ignored():
    assert triage.location_similarity("Shattuck Ave", "Shattuck Avenue") == 1.0


def test_unrelated_locations_do_not_match():
    assert triage.location_similarity("1420 Chestnut St", "88 Marina Blvd") == 0.0


def test_empty_location_never_matches():
    assert triage.location_similarity(None, "Shattuck Ave") == 0.0


# -- deduplication ---------------------------------------------------------


def test_same_problem_same_place_is_a_duplicate():
    existing = make_case()
    match = triage.find_duplicate([existing], IssueType.pothole, "University Ave and Shattuck")
    assert match is not None and match[0] is existing


def test_a_different_problem_at_the_same_place_is_not_a_duplicate():
    existing = make_case()
    assert triage.find_duplicate([existing], IssueType.water_leak, "Shattuck and University") is None


def test_a_resolved_case_does_not_absorb_new_reports():
    existing = make_case(status=CaseStatus.resolved)
    assert triage.find_duplicate([existing], IssueType.pothole, "Shattuck and University") is None


def test_a_stale_case_does_not_absorb_new_reports():
    old = make_case(created_at=datetime.now(timezone.utc) - timedelta(days=60))
    assert triage.find_duplicate([old], IssueType.pothole, "Shattuck and University") is None


def test_a_report_with_no_location_is_never_merged():
    """Merging on issue type alone would collapse every pothole in the city."""
    existing = make_case()
    assert triage.find_duplicate([existing], IssueType.pothole, None) is None


def test_the_closest_match_wins():
    near = make_case(id=1, location="Shattuck and University")
    far = make_case(id=2, location="Shattuck and Dwight and Telegraph and Bancroft")
    match = triage.find_duplicate([far, near], IssueType.pothole, "University and Shattuck")
    assert match is not None and match[0] is near


# -- priority --------------------------------------------------------------


def test_a_second_reporter_raises_priority():
    one = triage.priority_score(make_case(report_count=1))
    two = triage.priority_score(make_case(report_count=2))
    assert triage.priority_band(one) is Priority.normal
    assert triage.priority_band(two) is Priority.high


def test_severity_matters_on_its_own():
    leak = triage.priority_score(make_case(issue_type=IssueType.water_leak))
    tag = triage.priority_score(make_case(issue_type=IssueType.graffiti))
    assert leak > tag
    assert triage.priority_band(tag) is Priority.low


def test_escalation_beats_everything_else():
    quiet = make_case(issue_type=IssueType.graffiti, escalated=True)
    assert triage.priority_band(triage.priority_score(quiet)) is Priority.high


def test_age_nudges_a_case_up_but_does_not_dominate():
    fresh = triage.priority_score(make_case())
    stale = triage.priority_score(make_case(created_at=datetime.now(timezone.utc) - timedelta(days=9)))
    corroborated = triage.priority_score(make_case(report_count=2))
    assert fresh < stale < corroborated

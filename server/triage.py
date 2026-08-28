"""Deterministic domain rules: routing, deduplication, and priority.

These are pure functions on purpose. The language model handles conversation
and intent; it never decides which department owns a pothole, whether two
callers are describing the same one, or how urgent the result is. Those are
policy decisions a city has to be able to read, argue with, and change, so they
live in code a staffer could review rather than inside a prompt.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from server.models import Case, CaseStatus, Department, IssueType, Priority

# --------------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------------

DEPARTMENT_BY_ISSUE: dict[IssueType, Department] = {
    IssueType.pothole: Department.public_works,
    IssueType.streetlight: Department.public_works,
    IssueType.graffiti: Department.public_works,
    IssueType.missed_collection: Department.sanitation,
    IssueType.water_leak: Department.utilities,
    IssueType.noise_complaint: Department.code_enforcement,
    IssueType.other: Department.unassigned,
}


def route(issue_type: IssueType | None) -> Department:
    if issue_type is None:
        return Department.unassigned
    return DEPARTMENT_BY_ISSUE.get(issue_type, Department.unassigned)


# --------------------------------------------------------------------------
# Deduplication
# --------------------------------------------------------------------------

# Dropped before comparing locations, so "Shattuck Ave" and "Shattuck Avenue"
# and "Shattuck" all reduce to the same token.
_STREET_SUFFIXES = {
    "st", "street", "ave", "av", "avenue", "blvd", "boulevard", "rd", "road",
    "dr", "drive", "ln", "lane", "way", "ct", "court", "pl", "place", "hwy",
    "highway", "pkwy", "parkway", "ter", "terrace", "cir", "circle",
    "n", "s", "e", "w", "north", "south", "east", "west",
}
_FILLER = {
    "the", "a", "an", "and", "at", "on", "in", "near", "by", "of", "to",
    "corner", "block", "intersection", "between", "around", "outside",
    "front", "side", "my", "our", "there", "here",
}

DEDUPE_WINDOW = timedelta(days=30)
DEDUPE_THRESHOLD = 0.5


def location_tokens(location: str | None) -> set[str]:
    """Reduce a spoken address to the words that actually identify a place."""
    if not location:
        return set()
    cleaned = "".join(ch if ch.isalnum() else " " for ch in location.lower())
    return {
        word
        for word in cleaned.split()
        if word not in _STREET_SUFFIXES and word not in _FILLER and len(word) > 1
    }


def location_similarity(a: str | None, b: str | None) -> float:
    """Jaccard overlap of identifying words. Order independent by construction,
    so "Shattuck and University" matches "University and Shattuck" exactly."""
    left, right = location_tokens(a), location_tokens(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def find_duplicate(
    candidates: list[Case],
    issue_type: IssueType | None,
    location: str | None,
) -> tuple[Case, float] | None:
    """Best open case describing the same problem in the same place, if any.

    Conservative by design: same issue type, still open, reported recently, and
    a strong location overlap. A false merge is much worse than a false split,
    because a merged case hides a second resident's report.
    """
    if issue_type is None or not location_tokens(location):
        return None

    cutoff = datetime.now(timezone.utc) - DEDUPE_WINDOW
    best: tuple[Case, float] | None = None

    for case in candidates:
        if case.issue_type != issue_type:
            continue
        if case.status == CaseStatus.resolved:
            continue
        created = case.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < cutoff:
            continue

        score = location_similarity(case.location, location)
        if score >= DEDUPE_THRESHOLD and (best is None or score > best[1]):
            best = (case, score)

    return best


# --------------------------------------------------------------------------
# Priority
# --------------------------------------------------------------------------

_SEVERITY: dict[IssueType, int] = {
    IssueType.water_leak: 4,
    IssueType.pothole: 2,
    IssueType.streetlight: 2,
    IssueType.missed_collection: 1,
    IssueType.noise_complaint: 1,
    IssueType.graffiti: 1,
    IssueType.other: 1,
}

CORROBORATION_WEIGHT = 15
MAX_AGE_BONUS = 10
ESCALATION_WEIGHT = 50


def priority_score(case: Case) -> int:
    """How far up the queue this belongs.

    Three inputs a public works supervisor would actually accept: how bad the
    category is, how many separate residents have reported it, and how long it
    has been sitting there.
    """
    severity = _SEVERITY.get(case.issue_type, 1) if case.issue_type else 1
    corroboration = max(case.report_count - 1, 0) * CORROBORATION_WEIGHT

    created = case.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - created).days
    age = min(age_days, MAX_AGE_BONUS)

    escalation = ESCALATION_WEIGHT if case.escalated else 0
    return severity * 10 + corroboration + age + escalation


def priority_band(score: int) -> Priority:
    if score >= 35:
        return Priority.high
    if score >= 15:
        return Priority.normal
    return Priority.low

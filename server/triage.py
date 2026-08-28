"""Deterministic domain rules: routing, deduplication, and priority.

These are pure functions on purpose. The language model handles conversation
and intent; it never decides which department owns a pothole, whether two
callers are describing the same one, or how urgent the result is. Those are
policy decisions a city has to be able to read, argue with, and change, so they
live in code a staffer could review rather than inside a prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

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
# Classification confidence
# --------------------------------------------------------------------------

# Below this, a guess at the category is not worth acting on. Dispatching a
# sanitation crew to a water leak costs more than leaving a case unclassified
# for another minute, so a hesitant classifier is treated as no classifier.
ISSUE_TYPE_CONFIDENCE_THRESHOLD = 0.6


def classification_accepted(confidence: float | None) -> bool:
    """Whether a proposed issue type is sure enough to act on.

    ``None`` means the caller of the API did not measure confidence at all -
    a staff member typing a category by hand, or the seed script. Their
    judgement is taken at face value; only a stated low confidence is refused.
    """
    if confidence is None:
        return True
    return confidence >= ISSUE_TYPE_CONFIDENCE_THRESHOLD


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


# How alike two words have to be before they count as the same one.
#
# Every location this compares was transcribed from speech, and a street name
# is exactly what a recognizer half-hears: "Carleton" comes back as "Carlton",
# "Shattuck" as "Shatuck". Under exact token matching those are different
# streets, so the same caller reporting the same pothole twice opened two
# cases - which is the bug this exists to fix.
#
# 0.85 is tight enough that genuinely different streets stay different -
# "Carleton"/"Bancroft" is 0.17, "Dwight"/"Bancroft" is 0.29 - and loose enough
# to absorb a dropped or swapped letter. Note that this *loosens* matching, so
# ``DEDUPE_THRESHOLD`` deliberately does not move with it: a false merge is
# still worse than a false split, and only one of the two knobs should give.
WORD_SIMILARITY = 0.85


def same_word(a: str, b: str) -> bool:
    """Whether two transcribed words are the same word, spelling drift aside."""
    if a == b:
        return True
    # A length gap this wide is a different word, not a misheard one, and
    # skipping the ratio keeps the pairwise loop below cheap.
    if abs(len(a) - len(b)) > 2:
        return False
    return SequenceMatcher(None, a, b).ratio() >= WORD_SIMILARITY


def _overlap(left: set[str], right: set[str]) -> int:
    """How many words the two sets share, counting near-identical ones as shared.

    A greedy one-to-one pairing over sorted tokens: each word on the left
    claims at most one partner on the right, so "shattuck" cannot match both
    "shatuck" and "shattuck" and inflate the overlap past the set size. Sorted
    because a set has no order and this has to answer the same way every time.
    """
    unclaimed = sorted(right)
    shared = 0
    for word in sorted(left):
        for index, other in enumerate(unclaimed):
            if same_word(word, other):
                del unclaimed[index]
                shared += 1
                break
    return shared


def location_similarity(a: str | None, b: str | None) -> float:
    """Jaccard overlap of identifying words, compared fuzzily.

    Order independent by construction, so "Shattuck and University" matches
    "University and Shattuck" exactly - and spelling independent within reason,
    so "Carleton Street" matches "Carlton Street", which transcription produces
    constantly and which used to score 0.0.
    """
    left, right = location_tokens(a), location_tokens(b)
    if not left or not right:
        return 0.0
    shared = _overlap(left, right)
    return shared / (len(left) + len(right) - shared)


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
# Corroboration: what several residents' accounts agree on, and what they do not
# --------------------------------------------------------------------------
#
# Independent residents describing the same problem is evidence, and where they
# disagree a dispatcher needs to know rather than be handed one account picked
# arbitrarily. Two people saying "Shattuck and Dwight" and "Shattuck and
# Bancroft" are three blocks apart; averaging them sends a crew to neither.
#
# Deterministic and pure, like routing and deduplication above, for the same
# reason: this is policy a city should be able to read and argue with, and it
# has to be testable without a model call.


@dataclass(frozen=True)
class Agreement:
    """How several accounts of one detail line up."""

    field: str
    # The account the largest group gives, or ``None`` when nobody agrees with
    # anybody. Never a blend of two: a made-up middle is the one answer no
    # resident actually reported.
    consensus: str | None
    agreeing: int
    total: int
    # Every distinct account, in the order they were reported, so staff can
    # read the disagreement instead of being told there is one.
    accounts: list[str]

    @property
    def contested(self) -> bool:
        """Two or more residents gave accounts that do not describe the same thing."""
        return len(self.accounts) > 1

    @property
    def confirmed(self) -> bool:
        """More than one resident independently gave the same account."""
        return self.agreeing > 1 and not self.contested


def _cluster(values: list[str], same) -> list[list[str]]:
    """Group accounts that describe the same thing, in the order given.

    Single-link and order-stable: an account joins the first existing group it
    matches, so the same reports in the same order always produce the same
    grouping. No thresholds beyond the one ``same`` applies.
    """
    groups: list[list[str]] = []
    for value in values:
        for group in groups:
            if same(group[0], value):
                group.append(value)
                break
        else:
            groups.append([value])
    return groups


def _agreement(field: str, values: list[str | None], same) -> Agreement:
    present = [v.strip() for v in values if v and v.strip()]
    groups = _cluster(present, same)
    groups.sort(key=lambda g: (-len(g), present.index(g[0])))
    return Agreement(
        field=field,
        consensus=groups[0][0] if groups else None,
        agreeing=len(groups[0]) if groups else 0,
        total=len(present),
        accounts=[g[0] for g in groups],
    )


def corroborate_locations(accounts: list[str | None]) -> Agreement:
    """Do the residents on this case agree about where the problem is?

    Compared with the same token overlap that decides whether two reports are
    the same incident at all, so "Shattuck Ave" and "Shattuck Avenue" are one
    account and "Shattuck and Dwight" and "Shattuck and Bancroft" are two.
    """
    return _agreement(
        "location",
        accounts,
        lambda a, b: location_similarity(a, b) >= DEDUPE_THRESHOLD,
    )


def corroborate_issue_types(accounts: list[str | None]) -> Agreement:
    """Do they agree about what kind of problem it is? Exact match; it is an enum."""
    return _agreement("issue_type", accounts, lambda a, b: a == b)


def contested_fields(*agreements: Agreement) -> list[str]:
    """The details residents do not agree on, for the case to carry."""
    return [a.field for a in agreements if a.contested]


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

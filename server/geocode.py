"""Turn what a caller said about *where* into a point on the Berkeley map.

Three things make this trustworthy enough to draw a pin from.

*It is bounded to the service area.* Every query is constrained to a viewbox
around Berkeley with ``bounded=1``, so Nominatim can only answer with somewhere
the city could actually send a crew. A confident match on a Shattuck Avenue in
another state is not a useful answer, it is a wrong one, and a wrong pin is
worse than no pin.

*It says how sure it is.* ``LocationPrecision`` is derived from Nominatim's own
classification of what it matched - a house number or an intersection is
``exact``, a supermarket the caller mentioned in passing is ``approximate`` -
never from how confident the phrasing sounded. The dashboard labels the
difference rather than letting a rough point pass as a precise one.

*It cannot break intake.* Geocoding is a network call to somebody else's free
service, so it never runs on the request path and never raises into a caller.
Unreachable, slow, or empty all land in the same place: keep the caller's
words, mark the case ``unresolved``, log it, carry on. A resident on the phone
must never wait on OpenStreetMap, and a case must never fail to open because it
was down.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass

import httpx
from fastapi import BackgroundTasks
from sqlmodel import Session

from server.models import Case, LocationPrecision

logger = logging.getLogger("effigov.geocode")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Nominatim's usage policy requires an identifiable application. Requests
# without one are rejected, and rightly so: this is a free service run for
# everyone and an anonymous flood of queries is how it stops being one.
USER_AGENT = (
    "Emma311Intake/1.0 (City of Berkeley 311 voice intake demo; "
    "+https://github.com/edrlu/effigov-takehome)"
)

# Two opposite corners of Berkeley, as ``lon,lat,lon,lat``, padded a little so
# an address on the city line still resolves. With ``bounded=1`` this is a hard
# filter rather than a hint: outside it, Nominatim returns nothing at all.
BERKELEY_VIEWBOX = "-122.3350,37.9060,-122.2340,37.8340"
COUNTRY_CODES = "us"

# What a bare street or intersection needs before it is a question anybody can
# answer. "17th St & Valencia St" on its own is not a query.
SERVICE_AREA_SUFFIX = ", Berkeley, CA"

REQUEST_TIMEOUT = 5.0

# Nominatim's published ceiling is one request a second. We hold to it in
# process rather than trusting ourselves not to burst.
MIN_SECONDS_BETWEEN_REQUESTS = 1.0

# Callers describe places; they do not type queries. "near the Safeway on
# Shattuck" is three ideas - a landmark, a street, and a word joining them -
# and Nominatim wants those as comma-separated parts. It also has one syntax
# for a corner, ``A & B``, and understands nothing else as one.
_LEADING_PROSE_RE = re.compile(
    r"^(?:right\s+)?(?:near|by|outside|in front of|across from|around|"
    r"somewhere on|over on|corner of|at|on)\s+(?:the\s+)?",
    re.IGNORECASE,
)
_INTERSECTION_JOIN_RE = re.compile(r"\s*(?:&|/|\band\b)\s*", re.IGNORECASE)
_PROXIMITY_JOIN_RE = re.compile(
    r"\s+(?:near|next to|beside|behind|opposite|across from|by|off|on|at)\s+(?:the\s+)?",
    re.IGNORECASE,
)

# Nominatim names a crossing "Ashby Avenue & Sacramento Street". A plain street
# match is named just "Shattuck Avenue". That difference is the whole test.
_CROSSING_RE = re.compile(r"\s&\s")


@dataclass(frozen=True)
class GeocodeResult:
    """What the geocoder made of one location string.

    ``unresolved`` carries no coordinates by construction, so there is no way
    to render a pin for an answer the geocoder did not actually give.
    """

    precision: LocationPrecision
    formatted: str | None = None
    latitude: float | None = None
    longitude: float | None = None

    @property
    def resolved(self) -> bool:
        return self.precision is not LocationPrecision.unresolved


UNRESOLVED = GeocodeResult(precision=LocationPrecision.unresolved)


# --------------------------------------------------------------------------
# Query construction
# --------------------------------------------------------------------------


def normalize(text: str) -> str:
    """Collapse a location string to its cache key.

    Keyed on the query rather than the wording, so "Telegraph and Dwight" and
    "Telegraph & Dwight" are recognised as the one question they are and the
    city only ever asks it once.
    """
    return build_query(text).lower()


def build_query(text: str) -> str:
    """The string actually sent to Nominatim, in the city it belongs to.

    Two jobs. Turn the way a resident talks about a place into the shape a
    gazetteer can answer - a corner as ``A & B``, a landmark and its street as
    two comma-separated parts - and put it in Berkeley, because a bare street
    or intersection is not a question anybody can answer.
    """
    cleaned = " ".join(text.split()).strip(" ,.")
    cleaned = _LEADING_PROSE_RE.sub("", cleaned, count=1)
    cleaned = _INTERSECTION_JOIN_RE.sub(" & ", cleaned)
    cleaned = _PROXIMITY_JOIN_RE.sub(", ", cleaned)
    cleaned = " ".join(cleaned.split()).strip(" ,.")

    if not cleaned:
        return text.strip()
    if "berkeley" in cleaned.lower():
        return cleaned
    return cleaned + SERVICE_AREA_SUFFIX


def search_params(text: str) -> dict[str, str]:
    """Every parameter of a Berkeley-bounded lookup, in one inspectable place."""
    return {
        "q": build_query(text),
        "format": "json",
        "addressdetails": "1",
        "limit": "1",
        "countrycodes": COUNTRY_CODES,
        "viewbox": BERKELEY_VIEWBOX,
        "bounded": "1",
    }


# --------------------------------------------------------------------------
# Precision
# --------------------------------------------------------------------------


def classify(raw: dict, query: str) -> LocationPrecision:
    """How precise Nominatim's own answer is, by its own account of it.

    Two things earn ``exact``, and both are properties of the match rather than
    of how confident the caller sounded.

    *The house number asked for is the house number found.* Nominatim happily
    returns a building's street number for a query that never mentioned one -
    "near the Safeway on Shattuck" comes back as 1444 Shattuck Avenue - and
    treating that as a doorstep would put a precise-looking pin on a shop the
    caller only used as a landmark. So the number has to answer the question,
    not merely accompany the answer.

    *A crossing is a place you can stand.* Nominatim names one "A & B"; a plain
    street match is named just "Shattuck Avenue", and a whole street is not a
    location. Everything else resolved is ``approximate``, and the dashboard
    labels it that way rather than pretending.
    """
    address = raw.get("address") or {}
    house_number = str(address.get("house_number") or "").strip()
    if house_number and re.search(rf"\b{re.escape(house_number)}\b", query):
        return LocationPrecision.exact

    addresstype = str(raw.get("addresstype") or "").lower()
    category = str(raw.get("class") or "").lower()
    on_a_street = category == "highway" or addresstype == "road"
    name = str(raw.get("name") or raw.get("display_name") or "")
    if on_a_street and _CROSSING_RE.search(name.split(",")[0]):
        return LocationPrecision.exact

    return LocationPrecision.approximate


# --------------------------------------------------------------------------
# The network call, rate limited and cached
# --------------------------------------------------------------------------

_cache: dict[str, GeocodeResult] = {}
_cache_lock = threading.Lock()

# Held across the whole request, so the rate limit bounds requests in flight as
# well as the gap between them.
_request_lock = threading.Lock()
_last_request_at = 0.0


def enabled() -> bool:
    """Set ``EFFIGOV_GEOCODE=0`` to keep a process off the network entirely."""
    return os.getenv("EFFIGOV_GEOCODE", "1").lower() not in ("0", "false", "no")


def cache_clear() -> None:
    with _cache_lock:
        _cache.clear()


def _fetch(text: str) -> list[dict]:
    """One rate-limited call to Nominatim. Raises like any other HTTP call."""
    global _last_request_at
    with _request_lock:
        wait = MIN_SECONDS_BETWEEN_REQUESTS - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        try:
            response = httpx.get(
                NOMINATIM_URL,
                params=search_params(text),
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=REQUEST_TIMEOUT,
            )
        finally:
            _last_request_at = time.monotonic()
    response.raise_for_status()
    return response.json()


def resolve(text: str | None) -> GeocodeResult:
    """Geocode one location string. Never raises; never asks the same thing twice.

    Failure is a result, not an exception: the caller's words are still the
    truth of the case, and every way this can go wrong - down, slow, throttled,
    no match inside Berkeley - means the same thing to a dispatcher.
    """
    if not text or not text.strip():
        return UNRESOLVED

    key = normalize(text)
    with _cache_lock:
        cached = _cache.get(key)
    if cached is not None:
        return cached

    if not enabled():
        return UNRESOLVED

    try:
        results = _fetch(text)
    except Exception as exc:  # network, timeout, throttling, malformed JSON
        # Deliberately not cached: this says nothing about the address, only
        # about the network, and the next call may well succeed.
        logger.warning("geocode failed for %r: %s", text, exc)
        return UNRESOLVED

    result = _first_match(results, text)
    with _cache_lock:
        _cache[key] = result
    if not result.resolved:
        logger.info("geocode found nothing in Berkeley for %r", text)
    return result


def _first_match(results: list[dict], text: str) -> GeocodeResult:
    if not results:
        return UNRESOLVED
    raw = results[0]
    try:
        latitude = float(raw["lat"])
        longitude = float(raw["lon"])
    except (KeyError, TypeError, ValueError):
        logger.warning("geocode returned a result without usable coordinates: %r", raw)
        return UNRESOLVED
    return GeocodeResult(
        precision=classify(raw, build_query(text)),
        formatted=raw.get("display_name"),
        latitude=latitude,
        longitude=longitude,
    )


# --------------------------------------------------------------------------
# Wiring: off the request path, written back through the store
# --------------------------------------------------------------------------


def schedule(background: BackgroundTasks, case: Case | None) -> None:
    """Queue a geocode for this case to run after the response has been sent.

    Nothing on the voice agent's path waits for this. Starlette runs the task
    once the response is out, on a worker thread, so a slow or unreachable
    Nominatim delays a pin appearing and nothing else.
    """
    if case is None or case.id is None or not case.location or not enabled():
        return
    background.add_task(resolve_case_location, case.id, case.location)


def resolve_case_location(case_id: int, text: str) -> None:
    """Resolve one case's location and write the answer back. Never raises.

    Opens its own sessions, and holds neither across the network call: by the
    time this runs the request that triggered it is finished, and a lookup that
    can take seconds has no business sitting on a database connection.

    The same question is asked twice, before and after the call, because the
    world moves while we are out. A staff member correcting the pin by hand, or
    seed data standing a demo up offline, must not be overwritten by an answer
    that arrived late - least of all by an empty one.
    """
    from server.db import engine  # imported here to keep this module importable alone

    try:
        if not _needs_geocoding(engine, case_id, text):
            return
        result = resolve(text)
        with Session(engine) as session:
            case = session.get(Case, case_id)
            if case is None or case.location != text:
                # Deleted, or the location moved again while this was queued. A
                # later run is on its way with the newer text and should win.
                return
            if case.location_precision is not LocationPrecision.unresolved:
                return
            apply_result(session, case, result)
    except Exception:
        logger.exception("could not store geocode for case %s", case_id)


def _needs_geocoding(engine, case_id: int, text: str) -> bool:
    """Whether this case still has an unanswered question about where it is.

    Any change to ``location`` clears the geocoded fields, so a case that
    already carries a precision has been answered for the wording it now has.
    """
    with Session(engine) as session:
        case = session.get(Case, case_id)
        return (
            case is not None
            and case.location == text
            and case.location_precision is LocationPrecision.unresolved
        )


def apply_result(session: Session, case: Case, result: GeocodeResult) -> Case:
    """Write a geocode through the store, so it audits and broadcasts like anything else."""
    from server import store  # circular at import time: store imports nothing from here

    return store.apply_geocode(
        session,
        case,
        formatted=result.formatted,
        latitude=result.latitude,
        longitude=result.longitude,
        precision=result.precision,
    )

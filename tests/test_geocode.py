"""Geocoding: the query it asks, the honesty of the answer, and the failure path.

Deliberately three tests. Everything worth pinning down here is either a pure
function or a promise about what happens when somebody else's free service is
down, and neither needs the network to prove.
"""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel

from server import geocode, store
from server.models import Case, LocationPrecision


@pytest.fixture(autouse=True)
def clean_cache():
    geocode.cache_clear()
    yield
    geocode.cache_clear()


def test_query_is_bounded_to_berkeley():
    """A bare intersection is not a question, and Berkeley is the only answer."""
    params = geocode.search_params("17th St & Valencia St")

    assert params["q"] == "17th St & Valencia St, Berkeley, CA"
    assert params["countrycodes"] == "us"
    assert params["bounded"] == "1"
    assert params["viewbox"] == geocode.BERKELEY_VIEWBOX

    # A caller who already said the city does not get told it twice.
    assert geocode.build_query("2100 Milvia St, Berkeley") == "2100 Milvia St, Berkeley"
    # Residents describe places rather than typing queries. A corner has one
    # syntax Nominatim understands, and prose around a landmark is parts.
    assert geocode.build_query("Sacramento St and Ashby") == "Sacramento St & Ashby, Berkeley, CA"
    assert geocode.build_query("near the Safeway on Shattuck") == "Safeway, Shattuck, Berkeley, CA"


# Trimmed from real Nominatim responses to the fields the classifier reads.
@pytest.mark.parametrize(
    "raw, text, expected",
    [
        # The number asked for is the number found: a doorstep.
        (
            {
                "addresstype": "building",
                "class": "amenity",
                "name": "Martin Luther King Jr. Civic Center Building",
                "address": {"house_number": "2180", "road": "Milvia Street"},
            },
            "2180 Milvia St",
            LocationPrecision.exact,
        ),
        # A named crossing is a place you can stand.
        (
            {
                "addresstype": "highway",
                "class": "highway",
                "type": "bus_stop",
                "name": "Ashby Avenue & Sacramento Street",
                "address": {},
            },
            "Sacramento St and Ashby",
            LocationPrecision.exact,
        ),
        # A landmark the caller only pointed with. Nominatim volunteers the
        # shop's own street number; nobody asked for it, so it says nothing
        # about where the problem actually is.
        (
            {
                "addresstype": "supermarket",
                "class": "shop",
                "type": "supermarket",
                "name": "Safeway",
                "address": {"house_number": "1444", "road": "Shattuck Avenue"},
            },
            "near the Safeway on Shattuck",
            LocationPrecision.approximate,
        ),
        # A whole street is not an address, however confidently it was said.
        (
            {
                "addresstype": "road",
                "class": "highway",
                "type": "tertiary",
                "name": "Shattuck Avenue",
                "address": {},
            },
            "somewhere on Shattuck Avenue",
            LocationPrecision.approximate,
        ),
    ],
)
def test_precision_comes_from_what_nominatim_matched(raw, text, expected):
    assert geocode.classify(raw, geocode.build_query(text)) == expected


def test_a_geocode_failure_leaves_the_case_usable(memory_engine, monkeypatch):
    """Nominatim being down is not an error the caller ever sees."""
    monkeypatch.setenv("EFFIGOV_GEOCODE", "1")
    monkeypatch.setattr(
        geocode, "_fetch", lambda text: (_ for _ in ()).throw(TimeoutError("nominatim is down"))
    )
    SQLModel.metadata.create_all(memory_engine)

    with Session(memory_engine) as session:
        case = store.create_case(
            session,
            {"location": "Telegraph Ave & Dwight Way", "description": "Deep pothole."},
        )
        geocode.apply_result(session, case, geocode.resolve(case.location))

        stored = session.get(Case, case.id)
        assert stored.location == "Telegraph Ave & Dwight Way"
        assert stored.location_text == "Telegraph Ave & Dwight Way"
        assert stored.location_precision is LocationPrecision.unresolved
        assert stored.latitude is None and stored.longitude is None
        # Still a case a crew can be sent to on the words alone.
        assert stored.case_number.startswith("SR-")
        assert stored.department.value == "unassigned"

    # A failure says nothing about the address, so it is never cached as an answer.
    assert geocode.normalize("Telegraph Ave & Dwight Way") not in geocode._cache

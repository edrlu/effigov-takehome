"""The additive migration, over a database written before the current rules.

``effigov.db`` is gitignored but it is also the demo's memory, so a schema
change has to leave an existing file working rather than asking anyone to
delete it. The interesting case is the one this change introduces: a database
that already holds the same resident twice on one case, which the new unique
index would refuse to build over.
"""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlmodel import SQLModel, create_engine
from sqlmodel.pool import StaticPool

from server.db import migrate


def _legacy_engine():
    """A database with the old report table: no location, no unique index."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE report"))
        conn.execute(
            text(
                """
                CREATE TABLE report (
                    id INTEGER PRIMARY KEY,
                    case_id INTEGER NOT NULL,
                    call_id INTEGER,
                    reporter_name VARCHAR,
                    reporter_phone VARCHAR,
                    description VARCHAR,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
    return engine


def _case(conn, *, case_id: int, report_count: int) -> None:
    conn.execute(
        text(
            """
            INSERT INTO "case" (id, case_number, department, location_precision,
                                status, priority, priority_score, report_count,
                                escalated, created_at, updated_at)
            VALUES (:id, :number, 'public_works', 'unresolved', 'new', 'normal',
                    0, :count, 0, '2026-08-01 00:00:00', '2026-08-01 00:00:00')
            """
        ),
        {"id": case_id, "number": f"SR-10000{case_id}", "count": report_count},
    )


def _report(conn, **row) -> None:
    conn.execute(
        text(
            """
            INSERT INTO report (id, case_id, call_id, reporter_name, reporter_phone,
                                description, created_at)
            VALUES (:id, :case_id, :call_id, :name, :phone, :description, :created_at)
            """
        ),
        row,
    )


def test_an_older_database_gains_the_column_and_the_index():
    engine = _legacy_engine()
    migrate(engine)

    columns = {c["name"] for c in inspect(engine).get_columns("report")}
    assert "location" in columns

    indexes = {i["name"] for i in inspect(engine).get_indexes("report")}
    assert "uq_report_case_phone" in indexes


def test_one_resident_twice_on_a_case_is_folded_into_their_newest_account():
    """Keep the newest row, and never drop a resident's details.

    The older rows are that resident's earlier accounts of the same incident,
    so the newest wins - but anything only an older row knows is carried
    across, and any call pointing at a folded row is repointed.
    """
    engine = _legacy_engine()
    with engine.begin() as conn:
        _case(conn, case_id=1, report_count=3)
        # Same number, three calls. The newest has no name on it; the oldest
        # does, and that is the detail that must survive.
        _report(conn, id=1, case_id=1, call_id=11, name="Edward Lu", phone="5105551212",
                description="First account.", created_at="2026-08-01 09:00:00")
        _report(conn, id=2, case_id=1, call_id=12, name=None, phone="5105551212",
                description="Second account.", created_at="2026-08-02 09:00:00")
        _report(conn, id=3, case_id=1, call_id=13, name=None, phone="5105551212",
                description="Latest account.", created_at="2026-08-03 09:00:00")

    migrate(engine)

    with engine.begin() as conn:
        rows = conn.execute(
            text("SELECT id, reporter_name, description, call_id FROM report")
        ).fetchall()
        assert len(rows) == 1
        kept = rows[0]
        assert kept[0] == 3
        assert kept[1] == "Edward Lu"
        assert kept[2] == "Latest account."
        assert kept[3] == 13

        count = conn.execute(text('SELECT report_count FROM "case" WHERE id = 1')).scalar()
        assert count == 1


def test_folding_leaves_separate_residents_and_anonymous_accounts_alone():
    engine = _legacy_engine()
    with engine.begin() as conn:
        _case(conn, case_id=1, report_count=4)
        _report(conn, id=1, case_id=1, call_id=None, name="Edward Lu", phone="5105551212",
                description="One.", created_at="2026-08-01 09:00:00")
        _report(conn, id=2, case_id=1, call_id=None, name="Priya Raman", phone="5105550188",
                description="Two.", created_at="2026-08-02 09:00:00")
        # Two callers who left no number. Nobody we can recognise again is
        # nobody we can merge, and SQLite counts NULLs as distinct under the
        # unique index, so both survive.
        _report(conn, id=3, case_id=1, call_id=None, name=None, phone=None,
                description="Three.", created_at="2026-08-03 09:00:00")
        _report(conn, id=4, case_id=1, call_id=None, name=None, phone=None,
                description="Four.", created_at="2026-08-04 09:00:00")

    migrate(engine)

    with engine.begin() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM report")).scalar() == 4
        assert conn.execute(
            text('SELECT report_count FROM "case" WHERE id = 1')
        ).scalar() == 4


def _call(conn, *, call_id: int, case_id=None, report_id=None) -> None:
    conn.execute(
        text(
            """
            INSERT INTO call (id, room, case_id, report_id, status, phase, sentiment,
                              caller_city, line_type, language, started_at)
            VALUES (:id, :room, :case_id, :report_id, 'completed', 'ended', 'neutral',
                    'Berkeley, CA', 'Mobile', 'English', '2026-08-01 09:00:00')
            """
        ),
        {"id": call_id, "room": f"room-{call_id}", "case_id": case_id, "report_id": report_id},
    )


def test_older_calls_are_pointed_at_the_report_they_produced():
    """``Report.call_id`` has always held the link; this reads it back.

    A call that no report points at keeps a null, because that is the true
    answer: somebody hung up, or only wanted a status update.
    """
    engine = _legacy_engine()
    with engine.begin() as conn:
        _case(conn, case_id=1, report_count=1)
        _call(conn, call_id=11, case_id=1)
        _call(conn, call_id=12, case_id=1)  # produced nothing
        _report(conn, id=1, case_id=1, call_id=11, name="Edward Lu", phone="5105551212",
                description="One.", created_at="2026-08-01 09:00:00")

    migrate(engine)

    with engine.begin() as conn:
        rows = dict(conn.execute(text("SELECT id, report_id FROM call")).fetchall())
        assert rows[11] == 1
        assert rows[12] is None


def test_a_call_pointing_at_a_folded_report_is_repointed_not_orphaned():
    engine = _legacy_engine()
    with engine.begin() as conn:
        _case(conn, case_id=1, report_count=2)
        _call(conn, call_id=11, case_id=1, report_id=1)
        _call(conn, call_id=12, case_id=1, report_id=2)
        _report(conn, id=1, case_id=1, call_id=11, name="Edward Lu", phone="5105551212",
                description="One.", created_at="2026-08-01 09:00:00")
        _report(conn, id=2, case_id=1, call_id=12, name=None, phone="5105551212",
                description="Two.", created_at="2026-08-02 09:00:00")

    migrate(engine)

    with engine.begin() as conn:
        survivors = {r[0] for r in conn.execute(text("SELECT id FROM report")).fetchall()}
        assert len(survivors) == 1
        pointed = {r[1] for r in conn.execute(text("SELECT id, report_id FROM call")).fetchall()}
        assert pointed <= survivors, "a call is pointing at a report that no longer exists"


def test_migrating_twice_is_a_no_op():
    engine = _legacy_engine()
    with engine.begin() as conn:
        _case(conn, case_id=1, report_count=2)
        _report(conn, id=1, case_id=1, call_id=None, name="Edward Lu", phone="5105551212",
                description="One.", created_at="2026-08-01 09:00:00")
        _report(conn, id=2, case_id=1, call_id=None, name="Edward Lu", phone="5105551212",
                description="Two.", created_at="2026-08-02 09:00:00")

    migrate(engine)
    migrate(engine)

    with engine.begin() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM report")).scalar() == 1

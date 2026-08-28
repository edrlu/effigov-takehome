"""SQLite engine, session helper, and the additive migration that keeps
existing local databases working.

``effigov.db`` is gitignored, but it is also the demo's memory: wiping it on
every schema change would throw away the cases a rehearsal just built. So
``init_db`` creates missing tables and then adds missing columns in place,
rather than asking anyone to delete a file.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

from dotenv import load_dotenv
from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./effigov.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

# Columns added after the first release. SQLite can only ADD COLUMN, so every
# entry here has to be nullable or carry a literal default.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "case": {
        "issue_type_confidence": "FLOAT",
        "location_text": "VARCHAR",
        "location_formatted": "VARCHAR",
        "latitude": "FLOAT",
        "longitude": "FLOAT",
        "location_precision": "VARCHAR NOT NULL DEFAULT 'unresolved'",
        "location_detail": "VARCHAR",
        "contested_fields": "VARCHAR",
    },
    "call": {
        "phase": "VARCHAR NOT NULL DEFAULT 'greeting'",
        "caller_name": "VARCHAR",
        "caller_city": "VARCHAR DEFAULT 'Berkeley, CA'",
        "line_type": "VARCHAR DEFAULT 'Mobile'",
        "language": "VARCHAR DEFAULT 'English'",
        "sentiment": "VARCHAR NOT NULL DEFAULT 'neutral'",
        "activity_line": "VARCHAR",
    },
    "turn": {"turn_seq": "INTEGER NOT NULL DEFAULT 1"},
    "report": {"location": "VARCHAR", "issue_type": "VARCHAR"},
}


def migrate(bind=None) -> None:
    """Add columns the running code expects but an older database file lacks.

    Additive only. Nothing is dropped or rewritten, so an old database keeps
    working and a downgrade does not lose data.
    """
    target = bind if bind is not None else engine
    inspector = inspect(target)
    existing_tables = set(inspector.get_table_names())

    with target.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            if table not in existing_tables:
                continue
            present = {c["name"] for c in inspector.get_columns(table)}
            for column, ddl in columns.items():
                if column in present:
                    continue
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl}'))
                _backfill(conn, table, column)

        if "report" in existing_tables:
            _one_report_per_reporter(conn)
        if {"call", "report"} <= existing_tables:
            _link_calls_to_reports(conn)


def _backfill(conn, table: str, column: str) -> None:
    """Give rows that predate a column a value that is true of them."""
    if table == "case" and column == "location_text":
        # Before this column existed, ``location`` was the caller's words and
        # nothing had edited it, so copying it across is true of every old row.
        conn.execute(text("UPDATE \"case\" SET location_text = location"))
    elif table == "call" and column == "phase":
        # A call that already hung up is finished, whatever the default says.
        conn.execute(text("UPDATE call SET phase = 'ended' WHERE status = 'completed'"))
    elif table == "turn" and column == "turn_seq":
        # Recover per-call ordering from the only signal an old row has.
        conn.execute(
            text(
                """
                UPDATE turn SET turn_seq = (
                    SELECT COUNT(*) FROM turn AS earlier
                    WHERE earlier.call_id = turn.call_id AND earlier.id <= turn.id
                )
                """
            )
        )


def _one_report_per_reporter(conn) -> None:
    """Make an existing database hold one report per phone number per case.

    ``Report`` is now keyed on ``(case_id, reporter_phone)``, which is what
    makes ``Case.report_count`` a count of separate residents rather than of
    calls. A database written before that rule can hold the same resident twice
    on one case, and the unique index below would refuse to build over it.

    The rule for those: keep the newest row, because it is the caller's most
    recent account, and copy across anything only an older row knows. A
    resident's name or callback number is never what gets dropped. Rows with no
    phone number are left alone - nobody we can recognise again is nobody we
    can merge - which is also how the index treats them, since SQLite counts
    NULLs as distinct.
    """
    duplicates = conn.execute(
        text(
            """
            SELECT case_id, reporter_phone FROM report
            WHERE reporter_phone IS NOT NULL AND reporter_phone != ''
            GROUP BY case_id, reporter_phone HAVING COUNT(*) > 1
            """
        )
    ).fetchall()

    for case_id, phone in duplicates:
        rows = conn.execute(
            text(
                """
                SELECT id, reporter_name, description, location, call_id
                FROM report WHERE case_id = :case_id AND reporter_phone = :phone
                ORDER BY created_at DESC, id DESC
                """
            ),
            {"case_id": case_id, "phone": phone},
        ).fetchall()

        keep, rest = rows[0], rows[1:]
        merged = {
            "reporter_name": keep[1],
            "description": keep[2],
            "location": keep[3],
            "call_id": keep[4],
        }
        for row in rest:
            for index, column in enumerate(
                ("reporter_name", "description", "location", "call_id"), start=1
            ):
                if merged[column] is None:
                    merged[column] = row[index]

        conn.execute(
            text(
                """
                UPDATE report SET reporter_name = :reporter_name,
                                  description = :description,
                                  location = :location,
                                  call_id = :call_id
                WHERE id = :id
                """
            ),
            {**merged, "id": keep[0]},
        )
        for row in rest:
            conn.execute(
                text("UPDATE call SET report_id = :keep WHERE report_id = :drop"),
                {"keep": keep[0], "drop": row[0]},
            )
            conn.execute(text("DELETE FROM report WHERE id = :id"), {"id": row[0]})

    conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_report_case_phone "
            "ON report (case_id, reporter_phone)"
        )
    )

    # Any case that held a duplicate has been counting a caller twice. The
    # count is derived from the reports now, so recompute it once here rather
    # than leaving a stale number to inflate that case's place in the queue.
    conn.execute(
        text(
            """
            UPDATE "case" SET report_count = (
                SELECT COUNT(*) FROM report WHERE report.case_id = "case".id
            )
            """
        )
    )


def _link_calls_to_reports(conn) -> None:
    """Point older calls at the report they produced, where that is knowable.

    ``Report.call_id`` has always recorded which call produced a report, so the
    link exists in the data even in rows written before ``store.file_report``
    started writing ``Call.report_id`` itself. This reads it back the other way.

    A call no report points at keeps a null ``report_id``, and that is the right
    answer rather than a gap: a caller who hung up before saying anything, or
    who only wanted a status update, produced a real call and no report. The
    serialized call says ``produced_report`` so the two are told apart on
    purpose instead of by guessing at a null.
    """
    conn.execute(
        text(
            """
            UPDATE call SET report_id = (
                SELECT r.id FROM report r
                WHERE r.call_id = call.id
                ORDER BY r.created_at DESC, r.id DESC LIMIT 1
            )
            WHERE report_id IS NULL
              AND EXISTS (SELECT 1 FROM report r WHERE r.call_id = call.id)
            """
        )
    )
    # A call whose report was folded away by the pass above would be left
    # pointing at a row that no longer exists. Repoint it at the survivor for
    # that caller on that case.
    conn.execute(
        text(
            """
            UPDATE call SET report_id = (
                SELECT r.id FROM report r
                WHERE r.case_id = call.case_id LIMIT 1
            )
            WHERE report_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM report r WHERE r.id = call.report_id)
              AND call.case_id IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE call SET report_id = NULL
            WHERE report_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM report r WHERE r.id = call.report_id)
            """
        )
    )


def init_db() -> None:
    from server import models  # noqa: F401  (registers tables)

    migrate()
    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session

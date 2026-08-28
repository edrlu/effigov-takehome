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
    "case": {"issue_type_confidence": "FLOAT"},
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


def _backfill(conn, table: str, column: str) -> None:
    """Give rows that predate a column a value that is true of them."""
    if table == "call" and column == "phase":
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


def init_db() -> None:
    from server import models  # noqa: F401  (registers tables)

    migrate()
    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session

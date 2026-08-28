"""Shared plumbing: an app wired to a throwaway database."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from server.db import get_session
from server.main import app

# Geocoding is a live call to a free public service. The suite stubs it where
# it tests it; everywhere else it must not reach the network, nor write to the
# developer's own database from a background thread. Read at call time, so
# setting it here covers every test.
os.environ["EFFIGOV_GEOCODE"] = "0"


def client_for(engine) -> Iterator[TestClient]:
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def memory_engine():
    return create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )


@pytest.fixture()
def client(memory_engine):
    yield from client_for(memory_engine)

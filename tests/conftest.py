"""Shared plumbing: an app wired to a throwaway database."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from server.db import get_session
from server.main import app


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

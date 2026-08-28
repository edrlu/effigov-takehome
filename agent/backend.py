"""Thin async client for the case API.

The voice agent owns no state of its own: every fact it collects is written
straight through to the backend, which is also what the dashboard reads. That
is what makes the dashboard update mid-call without any extra plumbing.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


class CaseAPI:
    def __init__(self, base_url: str = BASE_URL) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=10.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    # -- calls ------------------------------------------------------------
    async def start_call(self, room: str) -> dict[str, Any]:
        r = await self._client.post("/api/calls", json={"room": room})
        r.raise_for_status()
        return r.json()

    async def update_call(self, call_id: int, **fields: Any) -> dict[str, Any]:
        r = await self._client.patch(f"/api/calls/{call_id}", json=fields)
        r.raise_for_status()
        return r.json()

    async def add_turn(self, call_id: int, role: str, text: str) -> None:
        await self._client.post(f"/api/calls/{call_id}/turns", json={"role": role, "text": text})

    # -- cases ------------------------------------------------------------
    async def create_case(self, **fields: Any) -> dict[str, Any]:
        r = await self._client.post(
            "/api/cases",
            params={"actor": "voice_agent"},
            json={k: v for k, v in fields.items() if v is not None},
        )
        r.raise_for_status()
        return r.json()

    async def update_case(self, case_id: int, **fields: Any) -> dict[str, Any]:
        r = await self._client.patch(
            f"/api/cases/{case_id}",
            params={"actor": "voice_agent"},
            json={k: v for k, v in fields.items() if v is not None},
        )
        r.raise_for_status()
        return r.json()

    async def add_note(self, case_id: int, note: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/cases/{case_id}/notes",
            params={"actor": "voice_agent"},
            json={"note": note},
        )
        r.raise_for_status()
        return r.json()

    async def lookup_case(self, identifier: str) -> dict[str, Any] | None:
        r = await self._client.get("/api/cases/lookup", params={"identifier": identifier})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

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
        r = await self._client.patch(
            f"/api/calls/{call_id}", json={k: v for k, v in fields.items() if v is not None}
        )
        r.raise_for_status()
        return r.json()

    async def add_turn(self, call_id: int, role: str, text: str) -> None:
        await self._client.post(f"/api/calls/{call_id}/turns", json={"role": role, "text": text})

    async def add_interim(self, call_id: int, role: str, text: str) -> None:
        """Stream a partial utterance. Best effort: a dropped delta is invisible,
        because the final turn that follows carries the whole thing anyway."""
        await self._client.post(
            f"/api/calls/{call_id}/interim", json={"role": role, "text": text}
        )

    async def set_phase(
        self, call_id: int, phase: str, activity_line: str | None = None
    ) -> dict[str, Any]:
        return await self.update_call(call_id, phase=phase, activity_line=activity_line)

    # -- reports ----------------------------------------------------------
    async def file_report(self, **fields: Any) -> dict[str, Any]:
        """Returns {report, case, merged, repeat}. The backend decides whether this
        is a new incident or another resident reporting one the city already knows,
        and ``repeat`` says this caller already had a report on it."""
        r = await self._client.post(
            "/api/reports",
            params={"actor": "voice_agent"},
            json={k: v for k, v in fields.items() if v is not None},
        )
        r.raise_for_status()
        return r.json()

    async def update_report(self, report_id: int, **fields: Any) -> dict[str, Any]:
        r = await self._client.patch(
            f"/api/reports/{report_id}",
            json={k: v for k, v in fields.items() if v is not None},
        )
        r.raise_for_status()
        return r.json()

    async def case_reports(self, case_id: int) -> list[dict[str, Any]]:
        """Every resident's account on one case, oldest first."""
        r = await self._client.get(f"/api/cases/{case_id}/reports")
        r.raise_for_status()
        return r.json()

    async def escalate(self, case_id: int, reason: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/api/cases/{case_id}/escalate",
            params={"actor": "voice_agent"},
            json={"reason": reason},
        )
        r.raise_for_status()
        return r.json()

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
        """The case, plus a ``reporter`` block carrying the name on file and the
        last four digits of their number - deliberately never the whole one."""
        r = await self._client.get("/api/cases/lookup", params={"identifier": identifier})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

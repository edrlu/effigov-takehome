"""Drop a few realistic cases into the database so the dashboard is not empty."""

from __future__ import annotations

import httpx

CASES = [
    {
        "caller_name": "Marcus Webb",
        "phone": "5105550142",
        "address": "1420 Chestnut St",
        "issue_type": "missed_collection",
        "description": "Green waste bin was not emptied on Tuesday, third week in a row.",
        "status": "in_progress",
    },
    {
        "caller_name": "Priya Raman",
        "phone": "5105550188",
        "address": "Corner of 7th and Oak",
        "issue_type": "pothole",
        "description": "Deep pothole in the eastbound lane, a cyclist went down last week.",
        "priority": "high",
    },
    {
        "caller_name": "Dana Ortiz",
        "phone": "4155550119",
        "address": "88 Marina Blvd",
        "issue_type": "streetlight",
        "description": "Streetlight out in front of the building, whole block is dark.",
        "status": "resolved",
    },
]

with httpx.Client(base_url="http://localhost:8000", timeout=10) as client:
    for case in CASES:
        r = client.post("/api/cases", params={"actor": "staff"}, json=case)
        r.raise_for_status()
        print("created", r.json()["case_number"])

"""Drop a few realistic reports into the database so the dashboard is not empty.

Filed through /api/reports rather than /api/cases so the seeded data exercises
the same deduplication path a real call would.
"""

from __future__ import annotations

import os

import httpx

# Same variable the voice agent and the rehearsal use.
BASE = os.getenv("BACKEND_URL", "http://localhost:8000")

REPORTS = [
    {
        "reporter_name": "Marcus Webb",
        "reporter_phone": "5105550142",
        "location": "1420 Chestnut St",
        "issue_type": "missed_collection",
        "description": "Green waste bin was not emptied on Tuesday, third week in a row.",
    },
    {
        "reporter_name": "Dana Ortiz",
        "reporter_phone": "4155550119",
        "location": "88 Marina Blvd",
        "issue_type": "streetlight",
        "description": "Streetlight out in front of the building, the whole block is dark.",
    },
    {
        "reporter_name": "Priya Raman",
        "reporter_phone": "5105550188",
        "location": "Telegraph Ave and Dwight Way",
        "issue_type": "graffiti",
        "description": "Tagging across the side of the transit shelter.",
    },
]

with httpx.Client(base_url=BASE, timeout=10) as client:
    for report in REPORTS:
        r = client.post("/api/reports", params={"actor": "staff"}, json=report)
        r.raise_for_status()
        body = r.json()
        verb = "merged into" if body["merged"] else "opened"
        print(f"{verb} {body['case']['case_number']}  {body['case']['department']}")

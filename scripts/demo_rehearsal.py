"""Drives the two-call demo against the running backend, without a microphone.

Useful as a pre-demo smoke test: if this prints a merged case, a raised
priority, and a full audit trail, the story you are about to tell on the call
actually works.

    uv run python scripts/demo_rehearsal.py
"""

from __future__ import annotations

import asyncio
import json

import httpx
import websockets

BASE = "http://localhost:8000"


async def main() -> None:
    events: list[dict] = []

    async with websockets.connect("ws://localhost:8000/ws") as ws:

        async def listen() -> None:
            async for message in ws:
                events.append(json.loads(message))

        listener = asyncio.create_task(listen())
        await asyncio.sleep(0.3)

        async with httpx.AsyncClient(base_url=BASE, timeout=10) as client:
            # Call 1: first resident reports a pothole.
            call1 = (await client.post("/api/calls", json={"room": "rehearsal-1"})).json()
            first = (
                await client.post(
                    "/api/reports",
                    json={
                        "issue_type": "pothole",
                        "location": "Shattuck Avenue near University",
                        "description": "Huge pothole in the eastbound lane.",
                        "call_id": call1["id"],
                    },
                )
            ).json()
            await client.patch(
                f"/api/reports/{first['report']['id']}",
                json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
            )
            print(
                f"call 1  {first['case']['case_number']}  merged={first['merged']}  "
                f"{first['case']['department']}  {first['case']['priority']} "
                f"({first['case']['priority_score']})  reports={first['case']['report_count']}"
            )

            # Call 2: a different resident, the same pothole, the words reversed.
            call2 = (await client.post("/api/calls", json={"room": "rehearsal-2"})).json()
            second = (
                await client.post(
                    "/api/reports",
                    json={
                        "issue_type": "pothole",
                        "location": "University Ave and Shattuck",
                        "description": "There is a giant pothole at that intersection.",
                        "call_id": call2["id"],
                    },
                )
            ).json()
            print(
                f"call 2  {second['case']['case_number']}  merged={second['merged']}  "
                f"{second['case']['priority']} ({second['case']['priority_score']})  "
                f"reports={second['case']['report_count']}"
            )
            assert second["merged"], "deduplication did not fire"
            assert second["case"]["id"] == first["case"]["id"]

            # Call 3: a hazard, escalated to a human.
            third = (
                await client.post(
                    "/api/reports",
                    json={
                        "issue_type": "other",
                        "location": "Sacramento St and Ashby",
                        "description": "A power line is down and sparking in the road.",
                    },
                )
            ).json()
            escalated = (
                await client.post(
                    f"/api/cases/{third['case']['id']}/escalate",
                    json={"reason": "Downed power line sparking, danger to the public"},
                )
            ).json()
            print(
                f"call 3  {escalated['case_number']}  escalated={escalated['escalated']}  "
                f"{escalated['priority']} ({escalated['priority_score']})"
            )

            print("\nqueue, highest priority first")
            for case in (await client.get("/api/cases")).json():
                flag = "  ESCALATED" if case["escalated"] else ""
                print(
                    f"  {case['priority_score']:>3}  {case['case_number']}  "
                    f"{case['priority']:<6} {str(case['issue_type']):<17} "
                    f"{case['report_count']} report(s){flag}"
                )

            print(f"\naudit trail for {first['case']['case_number']}")
            for event in (await client.get(f"/api/cases/{first['case']['id']}/events")).json():
                print(
                    f"  {event['created_at'][11:19]}  {event['kind']:<16} "
                    f"{event['field'] or '':<13} {event['old_value'] or '-'} -> "
                    f"{event['new_value'] or '-'}  ({event['actor']})"
                )

        await asyncio.sleep(0.7)
        listener.cancel()

    print("\nwebsocket messages seen:", ", ".join(sorted({e["type"] for e in events})))


if __name__ == "__main__":
    asyncio.run(main())

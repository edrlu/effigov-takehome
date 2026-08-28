"""Drives the demo against the running backend, without a microphone.

Two things this is for. It is a pre-demo smoke test: if it prints a merged
case, a raised priority, a classification that arrives late, and a gap-free
event stream, the story you are about to tell actually works. It is also how
the dashboard gets exercised - open http://localhost:3000 beside it and watch
the board move.

    uv run python scripts/demo_rehearsal.py
"""

from __future__ import annotations

import asyncio
import json

import httpx
import websockets

BASE = "http://localhost:8000"
WS = "ws://localhost:8000/ws"

# Slow enough that a human watching the dashboard can follow it.
BEAT = 0.35


class Stream:
    """Everything the server has broadcast since we connected."""

    def __init__(self) -> None:
        self.frames: list[dict] = []
        self.hello: dict | None = None

    @property
    def seqs(self) -> list[int]:
        return [f["seq"] for f in self.frames if f["seq"] is not None]

    def of(self, type_: str) -> list[dict]:
        return [f for f in self.frames if f["type"] == type_]


async def collect(ws, stream: Stream) -> None:
    async for message in ws:
        frame = json.loads(message)
        if frame["type"] == "hello":
            stream.hello = frame
            continue
        stream.frames.append(frame)


async def utterance(client: httpx.AsyncClient, call_id: int, role: str, text: str) -> None:
    """Say one line the way a recognizer does: in pieces, then all at once.

    The dashboard should show the words appearing and then settle, with the
    provisional line replaced rather than a duplicate left behind.
    """
    words = text.split()
    for cut in range(2, len(words), 2):
        await client.post(
            f"/api/calls/{call_id}/interim",
            json={"role": role, "text": " ".join(words[:cut])},
        )
        await asyncio.sleep(0.12)
    await client.post(f"/api/calls/{call_id}/turns", json={"role": role, "text": text})
    await asyncio.sleep(0.12)


async def phase(client: httpx.AsyncClient, call_id: int, name: str) -> None:
    await client.patch(f"/api/calls/{call_id}", json={"phase": name})
    await asyncio.sleep(BEAT)


async def main() -> None:
    stream = Stream()

    async with websockets.connect(WS) as ws:
        listener = asyncio.create_task(collect(ws, stream))
        await asyncio.sleep(0.3)

        async with httpx.AsyncClient(base_url=BASE, timeout=10) as client:
            first = await call_one(client)
            await call_two(client, first)
            third = await call_three(client)

            await report_queue(client)
            await report_audit(client, first)

        await asyncio.sleep(0.7)
        listener.cancel()

    await verify_resume(stream)
    report_stream(stream)


# --------------------------------------------------------------------------
# Call 1: a vague caller. The case opens unclassified and is categorised later.
# --------------------------------------------------------------------------


async def call_one(client: httpx.AsyncClient) -> dict:
    call = (await client.post("/api/calls", json={"room": "rehearsal-1"})).json()
    await phase(client, call["id"], "gathering")
    await utterance(
        client, call["id"], "caller",
        "There is something wrong with the road on Shattuck near University.",
    )

    # The agent is not sure what this is yet, and says so. Below the threshold
    # the city leaves the case unclassified rather than routing it on a guess.
    filed = (
        await client.post(
            "/api/reports",
            json={
                "issue_type": "pothole",
                "issue_type_confidence": 0.35,
                "location": "Shattuck Avenue near University",
                "description": "Something wrong with the road surface.",
                "call_id": call["id"],
            },
        )
    ).json()
    case = filed["case"]
    await phase(client, call["id"], "filed")
    print(
        f"call 1  {case['case_number']}  confidence=0.35  "
        f"issue_type={case['issue_type']}  {case['department']}  "
        "(held back on purpose)"
    )
    assert case["issue_type"] is None, "the confidence gate did not hold"
    assert case["department"] == "unassigned"

    await utterance(
        client, call["id"], "agent",
        "Can you tell me a bit more? Is it a hole in the surface, or standing water?",
    )
    await utterance(
        client, call["id"], "caller",
        "It is a deep hole, my front wheel dropped right into it.",
    )

    # Now it is clear. The classification lands and the case routes itself.
    case = (
        await client.patch(
            f"/api/cases/{case['id']}",
            json={
                "issue_type": "pothole",
                "issue_type_confidence": 0.94,
                "description": "Deep pothole in the eastbound lane, damaging wheels.",
            },
        )
    ).json()
    print(
        f"        confidence=0.94  issue_type={case['issue_type']}  "
        f"{case['department']}  {case['priority']} ({case['priority_score']})"
    )
    assert case["issue_type"] == "pothole"
    assert case["department"] == "public_works"

    await client.patch(
        f"/api/reports/{filed['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )
    # The agent re-sending what it already saved must be silent.
    await client.patch(
        f"/api/reports/{filed['report']['id']}",
        json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
    )

    await phase(client, call["id"], "wrapping")
    await utterance(
        client, call["id"], "agent",
        f"Your case number is {case['case_number']}. Anything else today?",
    )
    await client.patch(f"/api/calls/{call['id']}", json={"status": "completed"})
    return case


# --------------------------------------------------------------------------
# Call 2: a different resident, the same pothole, the words reversed.
# --------------------------------------------------------------------------


async def call_two(client: httpx.AsyncClient, first: dict) -> None:
    call = (await client.post("/api/calls", json={"room": "rehearsal-2"})).json()
    await phase(client, call["id"], "gathering")
    await utterance(
        client, call["id"], "caller",
        "There is a giant pothole at University Ave and Shattuck.",
    )

    second = (
        await client.post(
            "/api/reports",
            json={
                "issue_type": "pothole",
                "issue_type_confidence": 0.91,
                "location": "University Ave and Shattuck",
                "description": "There is a giant pothole at that intersection.",
                "call_id": call["id"],
            },
        )
    ).json()
    await phase(client, call["id"], "filed")
    case = second["case"]
    print(
        f"call 2  {case['case_number']}  merged={second['merged']}  "
        f"{case['priority']} ({case['priority_score']})  "
        f"reports={case['report_count']}"
    )
    assert second["merged"], "deduplication did not fire"
    assert case["id"] == first["id"]
    await client.patch(f"/api/calls/{call['id']}", json={"status": "completed"})


# --------------------------------------------------------------------------
# Call 3: a hazard, escalated to a human.
# --------------------------------------------------------------------------


async def call_three(client: httpx.AsyncClient) -> dict:
    call = (await client.post("/api/calls", json={"room": "rehearsal-3"})).json()
    await phase(client, call["id"], "gathering")
    await utterance(
        client, call["id"], "caller",
        "A power line is down and sparking in the road at Sacramento and Ashby.",
    )
    third = (
        await client.post(
            "/api/reports",
            json={
                "issue_type": "other",
                "issue_type_confidence": 0.8,
                "location": "Sacramento St and Ashby",
                "description": "A power line is down and sparking in the road.",
                "call_id": call["id"],
            },
        )
    ).json()
    await phase(client, call["id"], "filed")
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
    await client.patch(f"/api/calls/{call['id']}", json={"status": "completed"})
    return escalated


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


async def report_queue(client: httpx.AsyncClient) -> None:
    print("\nqueue, highest priority first")
    for case in (await client.get("/api/cases")).json():
        flag = "  ESCALATED" if case["escalated"] else ""
        print(
            f"  {case['priority_score']:>3}  {case['case_number']}  "
            f"{case['priority']:<6} {str(case['issue_type']):<17} "
            f"{case['report_count']} report(s){flag}"
        )


async def report_audit(client: httpx.AsyncClient, case: dict) -> None:
    print(f"\naudit trail for {case['case_number']}")
    for event in (await client.get(f"/api/cases/{case['id']}/events")).json():
        print(
            f"  {event['created_at'][11:19]}  {event['kind']:<16} "
            f"{event['field'] or '':<13} {event['old_value'] or '-'} -> "
            f"{event['new_value'] or '-'}  ({event['actor']})"
        )


async def verify_resume(stream: Stream) -> None:
    """Reconnect halfway through the run and check we get exactly the rest.

    This is the claim the dashboard depends on, so the rehearsal proves it
    rather than asserting it in a README.
    """
    seqs = stream.seqs
    if len(seqs) < 4:
        print("\nnot enough traffic to test resume")
        return

    midpoint = seqs[len(seqs) // 2]
    expected = [f for f in stream.frames if f["seq"] is not None and f["seq"] > midpoint]

    async with websockets.connect(f"{WS}?since={midpoint}") as ws:
        hello = json.loads(await ws.recv())
        replayed = [json.loads(await ws.recv()) for _ in expected]

    assert hello["payload"]["resume"] is True, "server refused to resume"
    assert hello["payload"]["from"] == midpoint + 1
    assert replayed == expected, "replay was not byte-identical to the live stream"
    print(
        f"\nresume    reconnected at seq {midpoint}, replayed "
        f"{len(replayed)} frames, byte-identical"
    )


def report_stream(stream: Stream) -> None:
    seqs = stream.seqs
    assert seqs == list(range(seqs[0], seqs[0] + len(seqs))), "the sequence has a gap"

    phases = [
        f["payload"]["call"]["phase"]
        for f in stream.of("call.updated")
        if f["payload"]["changed"] == ["phase"]
    ]
    silent = [f for f in stream.frames if not f["payload"].get("changed", ["x"])]

    print(f"sequence  {seqs[0]}..{seqs[-1]}, {len(seqs)} frames, no gaps")
    print(f"phases    {' -> '.join(phases)}")
    print(f"deltas    {len(stream.of('transcript.delta'))} interim, "
          f"{len(stream.of('transcript.turn'))} final")
    print(f"audit     {len(stream.of('event.appended'))} rows streamed live")
    assert not silent, "a frame claimed a change without naming a field"
    print("frames    " + ", ".join(sorted({f["type"] for f in stream.frames})))


if __name__ == "__main__":
    asyncio.run(main())

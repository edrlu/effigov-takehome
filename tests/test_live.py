"""The live stream's promises, tested as promises.

A dashboard trusts four things about this server: that it never skips a frame,
that it can be told exactly what it missed, that it is never lied to about a
field having changed, and that another client's bad network is not its problem.
Each of those is a test here.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from sqlmodel import create_engine

from server import hub as hub_module
from server import store
from server.hub import Client, Hub
from tests.conftest import client_for

POTHOLE = {
    "issue_type": "pothole",
    "location": "Shattuck Avenue near University",
    "description": "Huge pothole in the eastbound lane.",
}


def drain(ws, count: int) -> list[dict]:
    return [ws.receive_json() for _ in range(count)]


def read_until_quiet(ws, limit: int = 500) -> list[dict]:
    """Every frame published so far, fenced by a ping.

    The pong goes through the same per-client queue as the data frames, so it
    can only arrive after everything already queued. That makes "read what is
    pending" a definite operation rather than a race with a sleep in it.
    """
    ws.send_text(json.dumps({"type": "ping"}))
    frames: list[dict] = []
    for _ in range(limit):
        frame = ws.receive_json()
        if frame["type"] == "pong":
            return frames
        frames.append(frame)
    raise AssertionError("never saw the fence")


# --------------------------------------------------------------------------
# Sequencing
# --------------------------------------------------------------------------


def test_every_frame_is_sequenced_and_no_number_is_skipped(client):
    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["seq"] is None
        assert hello["payload"]["resume"] is False

        client.post("/api/reports", json=POTHOLE)
        client.post("/api/reports", json={**POTHOLE, "location": "12 Oak St"})

        frames = read_until_quiet(ws)

    seqs = [f["seq"] for f in frames]
    assert seqs == list(range(1, len(seqs) + 1))
    assert all(f["v"] == 1 for f in frames)
    assert all(f["ts"].endswith("+00:00") for f in frames)


def test_control_frames_carry_no_sequence_number(client):
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["seq"] is None  # hello
        ws.send_text(json.dumps({"type": "ping"}))
        pong = ws.receive_json()
        assert pong["type"] == "pong"
        assert pong["seq"] is None


def test_an_unknown_client_frame_is_ignored_rather_than_fatal(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_text("not json at all")
        ws.send_text(json.dumps({"type": "from_a_newer_dashboard"}))
        assert read_until_quiet(ws) == []


def test_the_sequence_survives_a_restart_of_the_api(tmp_path):
    """The outbox is the counter. Restarting the process must not rewind it."""
    url = f"sqlite:///{tmp_path/'restart.db'}"
    engine = create_engine(url, connect_args={"check_same_thread": False})

    first = client_for(engine)
    api = next(first)
    api.post("/api/reports", json=POTHOLE)
    with api.websocket_connect("/ws") as ws:
        before = ws.receive_json()["payload"]["latest_seq"]
    assert before > 0
    for _ in first:
        pass

    engine.dispose()
    reborn = create_engine(url, connect_args={"check_same_thread": False})
    second = client_for(reborn)
    api2 = next(second)
    api2.post("/api/reports", json={**POTHOLE, "location": "9 Elm St"})
    with api2.websocket_connect("/ws") as ws:
        after = ws.receive_json()["payload"]["latest_seq"]
    assert after > before
    for _ in second:
        pass


# --------------------------------------------------------------------------
# Resume and resync
# --------------------------------------------------------------------------


def test_resuming_replays_exactly_the_missed_frames_in_order(client):
    client.post("/api/reports", json=POTHOLE)
    with client.websocket_connect("/ws") as ws:
        watermark = ws.receive_json()["payload"]["latest_seq"]
        client.post("/api/reports", json={**POTHOLE, "location": "12 Oak St"})
        missed = read_until_quiet(ws)

    with client.websocket_connect(f"/ws?since={watermark}") as ws:
        hello = ws.receive_json()
        assert hello["payload"]["resume"] is True
        assert hello["payload"]["from"] == watermark + 1
        assert hello["payload"]["to"] == hello["payload"]["latest_seq"]
        replayed = drain(ws, len(missed))

    assert replayed == missed  # byte-identical history, not a fresh snapshot


def test_resuming_at_the_high_water_mark_replays_nothing(client):
    client.post("/api/reports", json=POTHOLE)
    with client.websocket_connect("/ws") as ws:
        latest = ws.receive_json()["payload"]["latest_seq"]

    with client.websocket_connect(f"/ws?since={latest}") as ws:
        hello = ws.receive_json()
        assert hello["payload"]["resume"] is True
        assert hello["payload"]["from"] > hello["payload"]["to"]
        assert read_until_quiet(ws) == []  # nothing was replayed


def test_a_since_older_than_the_retained_window_refuses_to_resume(client, monkeypatch):
    monkeypatch.setattr(store, "OUTBOX_RETENTION", 3)
    for i in range(6):
        client.post("/api/reports", json={**POTHOLE, "location": f"{i} Trim St"})

    with client.websocket_connect("/ws?since=1") as ws:
        hello = ws.receive_json()
        assert hello["payload"]["resume"] is False
        assert "from" not in hello["payload"] and "to" not in hello["payload"]


def test_a_since_ahead_of_the_server_refuses_to_resume(client):
    """A dashboard holding seq from a database that has since been rebuilt."""
    client.post("/api/reports", json=POTHOLE)
    with client.websocket_connect("/ws?since=9999") as ws:
        assert ws.receive_json()["payload"]["resume"] is False


def test_a_garbled_since_refuses_to_resume(client):
    with client.websocket_connect("/ws?since=-4") as ws:
        assert ws.receive_json()["payload"]["resume"] is False


# --------------------------------------------------------------------------
# Backpressure
# --------------------------------------------------------------------------


class StalledSocket:
    """A client that has stopped reading. Its writer never completes a send."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, frame: dict) -> None:
        await asyncio.sleep(3600)


@pytest.mark.asyncio
async def test_a_slow_client_is_told_to_resync_without_taking_the_others_down(monkeypatch):
    monkeypatch.setattr(hub_module, "CLIENT_QUEUE_LIMIT", 4)
    board = Hub()
    slow, healthy = Client(StalledSocket()), Client(StalledSocket())
    board._clients.update({slow, healthy})

    for seq in range(1, 20):
        board.broadcast({"v": 1, "seq": seq, "ts": "t", "type": "case.updated", "payload": {}})
        healthy.queue.get_nowait()  # this one keeps up

    backlog = []
    while not slow.queue.empty():
        backlog.append(slow.queue.get_nowait())

    assert backlog[0]["type"] == "resync_required"
    assert backlog[0]["payload"] == {"reason": "slow_consumer"}
    assert backlog[0]["seq"] is None
    assert slow in board._clients  # told to resync, not hung up on
    assert healthy.queue.empty() and healthy in board._clients


@pytest.mark.asyncio
async def test_the_replay_and_the_live_stream_do_not_overlap(monkeypatch):
    """Frames queued during a replay are dropped if the replay already sent them."""
    client = Client(StalledSocket())
    client.skip_through = 10
    delivered: list[int] = []

    async def record(frame):
        delivered.append(frame["seq"])

    client.ws.send_json = record
    for seq in (9, 10, 11, 12):
        client.queue.put_nowait({"v": 1, "seq": seq, "ts": "t", "type": "x", "payload": {}})

    task = asyncio.create_task(Hub()._drain(client))
    for _ in range(20):
        if delivered == [11, 12]:
            break
        await asyncio.sleep(0)
    task.cancel()
    assert delivered == [11, 12]


# --------------------------------------------------------------------------
# changed accuracy
# --------------------------------------------------------------------------


def test_an_update_that_moves_nothing_publishes_nothing(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()  # hello
        client.patch(f"/api/cases/{case['id']}", json={"location": POTHOLE["location"]})
        # Nothing in front of the fence is the assertion: the repeated PATCH was
        # silent rather than flickering the dashboard.
        assert read_until_quiet(ws) == []


def test_a_case_update_names_every_field_that_moved(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch(f"/api/cases/{case['id']}", json={"issue_type": "water_leak"})
        frames = [f for f in read_until_quiet(ws) if f["type"] == "case.updated"]

    changed = frames[-1]["payload"]["changed"]
    assert changed  # never empty
    assert "issue_type" in changed and "department" in changed
    assert frames[-1]["payload"]["case"]["department"] == "utilities"


def test_a_report_update_names_its_own_changed_fields(client):
    filed = client.post("/api/reports", json=POTHOLE).json()
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch(
            f"/api/reports/{filed['report']['id']}",
            json={"reporter_name": "Edward Lu", "reporter_phone": "5105551212"},
        )
        frames = read_until_quiet(ws)

    updates = [f for f in frames if f["type"] == "report.updated"]
    assert len(updates) == 1
    assert sorted(updates[0]["payload"]["changed"]) == ["reporter_name", "reporter_phone"]
    # Nothing about the case moved, so the case is not republished.
    assert not [f for f in frames if f["type"] == "case.updated"]


def test_re_sending_the_same_reporter_details_is_silent(client):
    filed = client.post("/api/reports", json=POTHOLE).json()
    details = {"reporter_name": "Edward Lu", "reporter_phone": "5105551212"}
    client.patch(f"/api/reports/{filed['report']['id']}", json=details)

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch(f"/api/reports/{filed['report']['id']}", json=details)
        assert read_until_quiet(ws) == []


# --------------------------------------------------------------------------
# Call phase
# --------------------------------------------------------------------------


def test_a_call_starts_in_greeting_and_each_phase_change_is_one_frame(client):
    call = client.post("/api/calls", json={"room": "phase-test"}).json()
    assert call["phase"] == "greeting"

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch(f"/api/calls/{call['id']}", json={"phase": "gathering"})
        frames = read_until_quiet(ws)

    updates = [f for f in frames if f["type"] == "call.updated"]
    assert len(updates) == 1
    assert updates[0]["payload"]["changed"] == ["phase"]
    assert updates[0]["payload"]["call"]["phase"] == "gathering"

    kinds = [f["payload"]["kind"] for f in frames if f["type"] == "event.appended"]
    assert "call.phase" in kinds


def test_repeating_a_phase_is_silent(client):
    call = client.post("/api/calls", json={"room": "phase-test"}).json()
    client.patch(f"/api/calls/{call['id']}", json={"phase": "gathering"})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch(f"/api/calls/{call['id']}", json={"phase": "gathering"})
        assert read_until_quiet(ws) == []


def test_hanging_up_ends_the_phase_as_well_as_the_status(client):
    call = client.post("/api/calls", json={"room": "phase-test"}).json()
    done = client.patch(f"/api/calls/{call['id']}", json={"status": "completed"}).json()
    assert done["status"] == "completed"
    assert done["phase"] == "ended"


# --------------------------------------------------------------------------
# Confidence gate
# --------------------------------------------------------------------------


def test_a_confident_classification_is_applied_and_routed(client):
    case = client.post(
        "/api/reports", json={**POTHOLE, "issue_type_confidence": 0.6}
    ).json()["case"]
    assert case["issue_type"] == "pothole"
    assert case["department"] == "public_works"
    assert case["issue_type_confidence"] == 0.6


def test_a_hesitant_classification_is_withheld_but_remembered(client):
    case = client.post(
        "/api/reports", json={**POTHOLE, "issue_type_confidence": 0.59}
    ).json()["case"]
    assert case["issue_type"] is None
    assert case["department"] == "unassigned"
    assert case["issue_type_confidence"] == 0.59


def test_an_unclassified_case_routes_the_moment_it_becomes_confident(client):
    case = client.post(
        "/api/reports", json={**POTHOLE, "issue_type_confidence": 0.3}
    ).json()["case"]
    assert case["department"] == "unassigned"

    updated = client.patch(
        f"/api/cases/{case['id']}",
        json={"issue_type": "water_leak", "issue_type_confidence": 0.9},
    ).json()
    assert updated["issue_type"] == "water_leak"
    assert updated["department"] == "utilities"


def test_a_hesitant_correction_does_not_overwrite_a_known_category(client):
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    updated = client.patch(
        f"/api/cases/{case['id']}",
        json={"issue_type": "graffiti", "issue_type_confidence": 0.2},
    ).json()
    assert updated["issue_type"] == "pothole"
    assert updated["issue_type_confidence"] == 0.2


def test_an_unclassified_case_is_never_merged_into(client):
    """Guessing a category at 0.3 must not hide a resident behind a coin flip."""
    client.post("/api/reports", json=POTHOLE)
    second = client.post(
        "/api/reports", json={**POTHOLE, "issue_type_confidence": 0.1}
    ).json()
    assert second["merged"] is False


def test_a_hand_typed_category_needs_no_confidence(client):
    """Staff and the seed script state a category outright. Only a measured low
    confidence is refused, never the absence of a measurement."""
    case = client.post("/api/reports", json=POTHOLE).json()["case"]
    assert case["issue_type"] == "pothole"
    assert case["issue_type_confidence"] is None


# --------------------------------------------------------------------------
# Transcript
# --------------------------------------------------------------------------


def test_turn_seq_counts_up_from_one_per_call(client):
    a = client.post("/api/calls", json={"room": "a"}).json()
    b = client.post("/api/calls", json={"room": "b"}).json()

    for i in range(3):
        client.post(f"/api/calls/{a['id']}/turns", json={"role": "caller", "text": f"a{i}"})
    client.post(f"/api/calls/{b['id']}/turns", json={"role": "caller", "text": "b0"})

    assert [t["turn_seq"] for t in client.get(f"/api/calls/{a['id']}/turns").json()] == [1, 2, 3]
    assert [t["turn_seq"] for t in client.get(f"/api/calls/{b['id']}/turns").json()] == [1]


def test_an_interim_delta_carries_the_seq_its_final_turn_will_use(client):
    call = client.post("/api/calls", json={"room": "delta"}).json()
    client.post(f"/api/calls/{call['id']}/turns", json={"role": "caller", "text": "hello"})

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.post(
            f"/api/calls/{call['id']}/interim",
            json={"role": "caller", "text": "there is a pothole on"},
        )
        client.post(
            f"/api/calls/{call['id']}/turns",
            json={"role": "caller", "text": "There is a pothole on Shattuck."},
        )
        frames = read_until_quiet(ws)

    delta = next(f for f in frames if f["type"] == "transcript.delta")
    final = next(f for f in frames if f["type"] == "transcript.turn")
    assert delta["payload"]["final"] is False
    assert delta["payload"]["turn_seq"] == final["payload"]["turn_seq"] == 2
    assert delta["payload"]["call_id"] == call["id"]


def test_interim_speech_is_never_written_down(client):
    call = client.post("/api/calls", json={"room": "delta"}).json()
    client.post(f"/api/calls/{call['id']}/interim", json={"role": "caller", "text": "half a"})
    assert client.get(f"/api/calls/{call['id']}/turns").json() == []


# --------------------------------------------------------------------------
# Audit streaming
# --------------------------------------------------------------------------


def test_the_audit_log_streams_instead_of_being_refetched(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        case = client.post("/api/reports", json=POTHOLE).json()["case"]
        frames = read_until_quiet(ws)

    streamed = [f["payload"] for f in frames if f["type"] == "event.appended"]
    stored = client.get(f"/api/cases/{case['id']}/events").json()
    assert [e["id"] for e in streamed if e["case_id"] == case["id"]] == [e["id"] for e in stored]
    assert [e["kind"] for e in stored][:3] == ["case.created", "case.routed", "report.filed"]


def test_a_caller_identity_patch_names_only_the_fields_that_moved(client):
    """Caller identity rides the existing call.updated frame, honestly."""
    call = client.post("/api/calls", json={"room": "identity-1"}).json()
    assert call["caller_city"] == "Berkeley, CA"
    assert call["line_type"] == "Mobile"
    assert call["language"] == "English"
    assert call["sentiment"] == "neutral"

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()  # hello

        client.patch(
            f"/api/calls/{call['id']}",
            json={
                "caller_name": "Edward Lu",
                "caller_city": "Berkeley, CA",  # already true, so not news
                "sentiment": "negative",
                "activity_line": "Handling request about pothole on Oak Street.",
            },
        )
        updates = [f for f in read_until_quiet(ws) if f["type"] == "call.updated"]

    assert len(updates) == 1
    payload = updates[0]["payload"]
    assert sorted(payload["changed"]) == ["activity_line", "caller_name", "sentiment"]
    assert payload["call"]["caller_name"] == "Edward Lu"
    assert payload["call"]["sentiment"] == "negative"

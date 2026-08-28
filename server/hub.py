"""In-process fan-out of case/call events to every connected dashboard.

Deliberately tiny: one process, one set of websockets, no broker. What makes it
trustworthy rather than merely small is two rules.

*One slow client cannot stall the others.* Each connection owns a bounded queue
drained by its own writer task, so a dashboard on a bad network backs up alone.
When its queue overflows the server drops that client's backlog, tells it to
resync, and keeps the socket open - a dropped frame is recoverable, a stalled
broadcast is not.

*Ordering is decided before the frame goes out.* ``seq`` is assigned by
``server.store`` when it writes the outbox row, and this module only carries
what it is handed. Control frames (``hello``, ``pong``, ``resync_required``)
carry ``seq: null`` because they describe the connection, not the world, and
replaying them would mean nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import WebSocket

from server.models import utcnow

PROTOCOL_VERSION = 1

# One dashboard's worth of slack. Large enough to ride out a garbage collection
# pause or a browser tab regaining focus, small enough that a client that has
# genuinely stopped reading is caught in seconds rather than exhausting memory.
CLIENT_QUEUE_LIMIT = 256


def envelope(type_: str, payload: Any, seq: int | None = None) -> dict[str, Any]:
    """The one frame shape every websocket message uses."""
    return {
        "v": PROTOCOL_VERSION,
        "seq": seq,
        "ts": utcnow().isoformat(),
        "type": type_,
        "payload": payload,
    }


class Client:
    """One websocket, its backlog, and the task that drains it."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=CLIENT_QUEUE_LIMIT)
        self.task: asyncio.Task | None = None
        # Frames at or below this seq were already delivered by the replay, so
        # the writer drops them instead of showing them twice.
        self.skip_through: int = 0

    def offer(self, frame: dict[str, Any]) -> None:
        """Hand a frame to this client without ever blocking the broadcaster."""
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            self._demand_resync()

    def _demand_resync(self) -> None:
        """This client is too far behind to catch up. Cut it loose, not off.

        Dropping the backlog is the point: replaying a stale queue to a client
        that has to refetch anyway just delays it further.
        """
        while not self.queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(
                envelope("resync_required", {"reason": "slow_consumer"})
            )


class Hub:
    def __init__(self) -> None:
        self._clients: set[Client] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # -- connection lifecycle ---------------------------------------------

    async def connect(self, ws: WebSocket) -> Client:
        """Accept the socket and start queueing for it immediately.

        Queueing starts before the caller has read the outbox, so a frame
        published during the handshake is held rather than lost. The writer is
        only started once ``skip_through`` is known, which is what keeps the
        replay and the live stream from overlapping.
        """
        await ws.accept()
        client = Client(ws)
        self._clients.add(client)
        return client

    def start_writer(self, client: Client) -> None:
        client.task = asyncio.create_task(self._drain(client))

    async def _drain(self, client: Client) -> None:
        try:
            while True:
                frame = await client.queue.get()
                seq = frame.get("seq")
                if seq is not None and seq <= client.skip_through:
                    continue  # already delivered by the replay
                await client.ws.send_json(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.disconnect(client)

    def disconnect(self, client: Client) -> None:
        self._clients.discard(client)
        if client.task is not None:
            client.task.cancel()
            client.task = None

    # -- publishing --------------------------------------------------------

    def broadcast(self, frame: dict[str, Any]) -> None:
        """Offer one already-sequenced frame to every client. Never blocks.

        Safe from the event loop or a worker thread: writes always happen on
        the loop, because ``asyncio.Queue`` is not thread-safe.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            if self._loop is not None:
                with contextlib.suppress(RuntimeError):
                    self._loop.call_soon_threadsafe(self._offer_all, frame)
            return
        self._offer_all(frame)

    def _offer_all(self, frame: dict[str, Any]) -> None:
        for client in list(self._clients):
            client.offer(frame)


hub = Hub()

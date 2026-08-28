"""In-process fan-out of case/call events to every connected dashboard.

Deliberately tiny: one process, one set of websockets, no broker. Every
mutation in ``server.store`` calls ``hub.publish`` with a JSON-serializable
envelope, and the dashboard applies it to local state.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for ws in list(self._clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    def publish(self, type_: str, payload: Any) -> None:
        """Fire-and-forget broadcast. Safe from the event loop or a worker thread."""
        message = {"type": type_, "payload": payload}
        try:
            asyncio.get_running_loop().create_task(self.broadcast(message))
            return
        except RuntimeError:
            pass
        if self._loop is not None:
            with contextlib.suppress(RuntimeError):
                asyncio.run_coroutine_threadsafe(self.broadcast(message), self._loop)


hub = Hub()

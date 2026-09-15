"""Doubles for the authorization-flow registry tests: an empty registry and tab sockets."""

from __future__ import annotations

import json


class FakeSocket:
    """A tab's WebSocket that records every message it is sent."""

    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, message: str) -> None:
        self.sent.append(json.loads(message))


def reset_flow_registry(monkeypatch):
    """Empty the flow registry and the open-socket table; returns the websocket module."""
    import flow_sdk.server.routes.websocket as websocket
    from flow_sdk.core.oauth import flows

    monkeypatch.setattr(flows, "_flows", flows.OrderedDict())
    monkeypatch.setattr(websocket, "_active_connections", {})
    return websocket


def connect_tab(websocket, connection_id: str) -> FakeSocket:
    """Open a tab connection under ``connection_id`` and return its socket."""
    socket = FakeSocket()
    websocket._active_connections[connection_id] = websocket.ConnectionInfo(ws=socket, is_tab=True)
    return socket

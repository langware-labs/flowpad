"""``ui_command`` — the server→client directive envelope, built in ONE place.

A ``ui_command`` tells a connected UI to do something (navigate, open a file,
show a desktop notification). Every such frame has the identical envelope
``{message_type, message_id, kind, **fields}``; the two delivery modes differ
only in reach:

* :func:`send_ui_command`      — targeted at a single tab (navigate/* routes).
* :func:`broadcast_ui_command` — fanned to every window (desktop notifications,
  so a *backgrounded* window still receives it).

Both build the frame through :func:`build_ui_command`, so the envelope shape
lives here and nowhere else. Transport (``broadcast`` / ``send_personal_message``)
is owned by the WS endpoint and referenced late so this module carries no import
cycle and stays trivially monkeypatch-testable.
"""

from __future__ import annotations

import json
from uuid import uuid4


def build_ui_command(kind: str, **fields) -> str:
    """Serialize a ``ui_command`` frame. THE one place the envelope is shaped."""
    return json.dumps(
        {"message_type": "ui_command", "message_id": str(uuid4()), "kind": kind, **fields}
    )


async def send_ui_command(ws, kind: str, **fields) -> None:
    """Send a ``ui_command`` to a single connection (targeted delivery)."""
    from flow_sdk.server.routes import websocket as _transport  # noqa: PLC0415

    await _transport.send_personal_message(build_ui_command(kind, **fields), ws)


async def broadcast_ui_command(kind: str, **fields) -> None:
    """Broadcast a ``ui_command`` to ALL connected clients (fanned delivery)."""
    from flow_sdk.server.routes import websocket as _transport  # noqa: PLC0415

    await _transport.broadcast(build_ui_command(kind, **fields))

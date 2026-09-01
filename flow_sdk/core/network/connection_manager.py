"""WebSocket connection management."""

import contextvars
import json
import logging
from typing import Callable, Optional

from flow_sdk.core.network.connection import ConnectionHandler
from flow_sdk.fs_store.type_id import TypeId

_active_connection_handlers: list[ConnectionHandler] = []

# External connection lookup callback (for minihub integration)
_external_connection_lookup: Optional[Callable[[str], Optional[ConnectionHandler]]] = None


def set_external_connection_lookup(lookup_fn: Callable[[str], Optional[ConnectionHandler]]):
    """Register an external connection lookup function.

    Used by minihub to allow the SDK to find connections stored externally.
    """
    global _external_connection_lookup
    _external_connection_lookup = lookup_fn


def get_connection_handler(connection_typeid: TypeId) -> Optional[ConnectionHandler]:
    """Get a connection handler by its TypeId.

    Args:
        connection_typeid: The TypeId of the connection

    Returns:
        ConnectionHandler if found, None otherwise
    """
    # First check SDK's internal handlers
    for handler in _active_connection_handlers:
        if handler.connection.typeid == connection_typeid:
            return handler

    # Fallback to external lookup (minihub)
    if _external_connection_lookup:
        return _external_connection_lookup(connection_typeid.id)

    return None


async def send_personal_message(message: str, websocket):
    """Send a message to a specific WebSocket client."""
    await websocket.send_text(message)


async def broadcast(message: str, websocket):
    """Broadcast a message to all connected clients except sender."""
    for handler in _active_connection_handlers:
        if handler.websocket == websocket:
            continue
        await handler.websocket.send_text(message)

"""
WebSocket connection registry.

This module maintains a global registry of active WebSocket connections.
Routes add/remove connections, and the notification system retrieves them
without creating circular dependencies.
"""

import logging
from typing import Dict, Optional
from starlette.websockets import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)


def is_client_gone(exc: Exception) -> bool:
    """True when an exception just means the client already disconnected.

    A send/receive that fails because the peer closed the socket is normal
    (e.g. a browser tab closing mid-stream), not a server error — callers
    log it at debug and stop, rather than ERROR + a doomed error-response send
    or an unretrieved fire-and-forget task exception.
    """
    if isinstance(exc, WebSocketDisconnect):
        return True
    msg = str(exc).lower()
    return (
        "close message has been sent" in msg
        or "websocket.close" in msg
        or "after sending" in msg
        or "disconnect" in msg
    )


class ConnectionRegistry:
    """Global registry of active WebSocket connections."""

    def __init__(self):
        self._connections: Dict[str, WebSocket] = {}

    def add_connection(self, connection_id: str, websocket: WebSocket) -> None:
        self._connections[connection_id] = websocket
        logger.debug(f"Added connection {connection_id}")

    def remove_connection(self, connection_id: str) -> None:
        if connection_id in self._connections:
            del self._connections[connection_id]
            logger.debug(f"Removed connection {connection_id}")

    def get_connection(self, connection_id: str) -> Optional[WebSocket]:
        return self._connections.get(connection_id)

    def get_all_connections(self) -> Dict[str, WebSocket]:
        return dict(self._connections)

    def clear(self) -> None:
        """Clear all connections (useful for testing)."""
        self._connections.clear()
        logger.debug("Cleared all connections")


# Global connection registry instance
_registry = ConnectionRegistry()


def add_connection(connection_id: str, websocket: WebSocket) -> None:
    _registry.add_connection(connection_id, websocket)


def remove_connection(connection_id: str) -> None:
    _registry.remove_connection(connection_id)


def get_connection(connection_id: str) -> Optional[WebSocket]:
    return _registry.get_connection(connection_id)


def get_all_connections() -> Dict[str, WebSocket]:
    return _registry.get_all_connections()

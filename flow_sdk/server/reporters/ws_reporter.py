"""
WebSocket reporter - broadcasts hook events to connected clients.
"""

from typing import Dict, Any, List
from fastapi import WebSocket
from .base import BaseReporter


class WebSocketReporter(BaseReporter):
    """
    Reporter that broadcasts hook events to WebSocket clients.

    Features:
    - Manages list of connected WebSocket clients
    - Broadcasts events to all connected clients
    - Automatically removes disconnected clients
    """

    def __init__(self):
        """Initialize the WebSocket reporter."""
        self._connections: List[WebSocket] = []

    async def report(self, event: Dict[str, Any]) -> None:
        """
        Broadcast event to all connected WebSocket clients.

        Args:
            event: Hook event data dictionary
        """
        disconnected = []

        for ws in self._connections:
            try:
                await ws.send_json({
                    "type": "hook_output",
                    "output": event
                })
            except Exception:
                disconnected.append(ws)

        # Remove disconnected clients
        for ws in disconnected:
            self.remove_connection(ws)

    async def get_recent(self) -> list:
        """
        WebSocket reporter doesn't store events.

        Returns:
            Empty list (WebSocket reporter doesn't maintain history)
        """
        return []

    def add_connection(self, websocket: WebSocket) -> None:
        """
        Add a WebSocket connection.

        Args:
            websocket: WebSocket connection to add
        """
        if websocket not in self._connections:
            self._connections.append(websocket)

    def remove_connection(self, websocket: WebSocket) -> None:
        """
        Remove a WebSocket connection.

        Args:
            websocket: WebSocket connection to remove
        """
        if websocket in self._connections:
            self._connections.remove(websocket)

    @property
    def connection_count(self) -> int:
        """Get number of connected clients."""
        return len(self._connections)

    async def send_initial(self, websocket: WebSocket, outputs: List[Dict[str, Any]]) -> None:
        """
        Send initial data to a newly connected client.

        Args:
            websocket: The WebSocket connection
            outputs: List of initial outputs to send
        """
        if outputs:
            await websocket.send_json({
                "type": "initial",
                "outputs": outputs
            })

    async def cleanup(self) -> None:
        """Close all WebSocket connections."""
        for ws in self._connections:
            try:
                await ws.close()
            except Exception:
                pass
        self._connections.clear()

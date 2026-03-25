"""WebSocket connection management."""

from typing import Any, Optional

from starlette.websockets import WebSocket

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Notification(Entity):
    type: str = APIField(default="notification")

    def after_create(self, create_data: dict):
        pass


class Connection(Entity):
    agent: Optional[str] = None
    client_type: Optional[str] = None
    type: str = APIField(default=BuiltinEntityType.CONNECTION.value)


class ConnectionHandler:
    def __init__(self, user: Any, connection: Connection, websocket: WebSocket, user_foreign_key: str):
        self.user: Any = user
        self.user_foreign_key = user_foreign_key
        self.connection: Connection = connection
        self.websocket: WebSocket = websocket

    async def send_message(self, message: str | dict):
        import json
        if isinstance(message, dict):
            message = json.dumps(message)
        await self.websocket.send_text(message)

    async def receive_message(self) -> str:
        return await self.websocket.receive_text()

    async def close(self):
        await self.websocket.close()

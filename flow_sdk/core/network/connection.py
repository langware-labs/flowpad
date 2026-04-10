"""WebSocket connection management."""

from typing import Any, ClassVar, Dict, Optional

from starlette.websockets import WebSocket

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums.entity_enums import (
    CrudAction,
    DeliveryMethod,
    NotificationStatus,
    NotificationType,
)


class Notification(Entity):
    type: str = APIField(default="notification")

    # Classification
    notification_type: str = APIField(default=NotificationType.RESOURCE_ACTION)
    notification_subtype: str = APIField(default=CrudAction.CREATE)

    # Addressing
    recipient_id: str = APIField(default="")
    sender_id: Optional[str] = APIField(None)

    # Target — TypeId string, e.g. "task-@<uuid>"
    notification_target: Optional[str] = APIField(None)

    # Delivery
    delivery_method: str = APIField(default=DeliveryMethod.EMAIL)
    notification_status: str = APIField(default=NotificationStatus.PENDING)
    message: Optional[str] = APIField(None)

    # Extra context (project_url, spec_id, sender_name, etc.)
    metadata: Optional[Dict[str, Any]] = APIField(None)

    _api_visible: ClassVar[bool] = True

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

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
from flow_sdk.fs_store.type_id import TypeId

class Notification(Entity):
    type: str = APIField(default="notification")

    # Classification
    notification_type: str = APIField(default=NotificationType.RESOURCE_ACTION)
    notification_subtype: str = APIField(default=CrudAction.CREATE)

    # Addressing
    recipient_id: str = APIField(default="")
    sender_id: Optional[str] = APIField(None)

    # Target — TypeId for the entity this notification is about.
    notification_target: Optional[TypeId] = APIField(None)

    # Delivery
    delivery_method: str = APIField(default=DeliveryMethod.EMAIL)
    notification_status: str = APIField(default=NotificationStatus.PENDING)
    message: Optional[str] = APIField(None)

    # Extra context (git_origin, spec_id, sender_name, etc.)
    metadata: Optional[Dict[str, Any]] = APIField(None)

    def after_create(self, create_data: dict):
        pass

    @classmethod
    def from_envelope(cls, envelope: "NotificationEnvelope") -> "Notification":
        """Build a Notification row from a NotificationEnvelope (hub-side).

        Lazy import of NotificationEnvelope to avoid pulling pydantic into
        every Connection import; this method is only called from the hub.
        """
        return cls.model_validate({
            "notification_type": envelope.notification_type,
            "notification_subtype": envelope.notification_subtype,
            "notification_target": envelope.target,
            "sender_id": envelope.sender_id,
            "recipient_id": envelope.recipient_id,
            "message": envelope.body_text,
            "metadata": envelope.metadata,
        })


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

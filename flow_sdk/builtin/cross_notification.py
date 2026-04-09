from __future__ import annotations
from datetime import datetime
from flow_sdk._compat import StrEnum
from typing import ClassVar, Optional
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.flowpad_types.enums.entity_enums import CrudAction

class DeliveryMethod(StrEnum):
    EMAIL = "email"
    SLACK = "slack"
    JIRA = "jira"

class NotificationStatus(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    RECEIVED = "received"

class CrossUserNotification(Entity):
    type: str = APIField(default="cross_notification")
    recipient_id: str = APIField("")
    sender_id: Optional[str] = APIField(None)
    project_url: str = APIField("")
    target_type_id: Optional[str] = APIField(None)
    action: str = APIField(CrudAction.CREATE)
    spec_id: Optional[str] = APIField(None)
    target_id: Optional[str] = APIField(None)
    delivery_method: str = APIField(DeliveryMethod.EMAIL)
    sent_at: Optional[datetime] = APIField(None)
    status: str = APIField(NotificationStatus.PENDING)
    message: Optional[str] = APIField(None)
    _api_visible: ClassVar[bool] = True

"""NotificationEnvelope — single struct projected onto WS and email payloads.

Producers build one envelope and dispatch it through ``as_ws_payload`` and/or
``as_email_payload``. Both projections derive from the same source so the WS
sync and the recipient's email cannot drift apart. The WS shape is byte-
compatible with the hand-built ``send_resource_sync`` envelope at
``discovery/notify.py`` so the frontend wire format is preserved.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from flow_sdk.fs_store.type_id import TypeId


class NotificationEnvelope(BaseModel):
    """Cross-channel notification payload.

    Versioned via ``schema_version`` so we can roll out new fields across
    the flowpad-oss / flowpad-hub repo boundary without breaking older
    consumers.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    schema_version: int = Field(default=1)
    notification_type: str
    notification_subtype: str
    target: TypeId

    sender_id: Optional[str] = None
    recipient_id: Optional[str] = None

    title: str = ""
    body_text: str = ""
    body_html: Optional[str] = None

    metadata: dict[str, Any] = Field(default_factory=dict)
    occurred_at: str = ""

    def as_ws_payload(self) -> dict:
        """Build the WS sync envelope.

        Shape preserves the dict that ``send_resource_sync(...)`` produces
        today so the frontend wire format is unchanged.
        """
        return {
            "type": self.target.type,
            "id": self.target.id,
            "operation": self.notification_subtype,
            "data": {
                "event_data": {
                    "notification_type": self.notification_type,
                    "notification_subtype": self.notification_subtype,
                    "target": str(self.target),
                    "sender_id": self.sender_id,
                    "recipient_id": self.recipient_id,
                    "title": self.title,
                    "body_text": self.body_text,
                    "body_html": self.body_html,
                    "metadata": self.metadata,
                    "occurred_at": self.occurred_at,
                    "schema_version": self.schema_version,
                },
            },
        }

    def as_email_payload(self) -> dict:
        """Build the email payload for the hub email provider.

        Hub-side providers consume ``subject`` / ``to`` / ``body_text`` /
        ``body_html`` / ``metadata`` directly.
        """
        return {
            "subject": self.title,
            "to_recipient_id": self.recipient_id,
            "from_sender_id": self.sender_id,
            "body_text": self.body_text,
            "body_html": self.body_html,
            "metadata": {
                **self.metadata,
                "target": str(self.target),
                "notification_type": self.notification_type,
                "notification_subtype": self.notification_subtype,
                "occurred_at": self.occurred_at,
                "schema_version": self.schema_version,
            },
        }

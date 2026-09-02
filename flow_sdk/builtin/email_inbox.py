"""Read-only SDK projection of the Hub's formal EmailInbox entity."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.core import Entity
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.types import EntityType


class EmailInbox(Entity):
    """The public descriptor of one server-minted Hub mailbox."""

    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.EMAIL_INBOX.value)
    address: str = APIField()
    display_name: str | None = APIField(default=None)
    provider: str = APIField()
    provider_inbox_id: str = APIField()
    status: str = APIField()
    agent_typeid: TypeId = APIField()

    def is_file_backed(self) -> bool:
        return False

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    @classmethod
    def from_hub_descriptor(
        cls,
        descriptor: Mapping[str, Any],
        *,
        agent_typeid: TypeId,
    ) -> "EmailInbox":
        """Adopt and validate the Hub identity carried by an inbox descriptor."""
        inbox_typeid = TypeId(str(descriptor.get("typeid") or ""))
        if (
            inbox_typeid.type != EntityType.EMAIL_INBOX.value
            or not inbox_typeid.id
            or not is_valid_entity_id(inbox_typeid.id)
        ):
            raise ValueError(f"Invalid Hub EmailInbox TypeId: {inbox_typeid}")

        linked_agent = TypeId(str(descriptor.get("agent_typeid") or ""))
        if (
            linked_agent.type != EntityType.AGENT.value
            or not linked_agent.id
            or not is_valid_entity_id(linked_agent.id)
            or linked_agent != agent_typeid
        ):
            raise ValueError(
                f"EmailInbox belongs to {linked_agent}, expected {agent_typeid}"
            )

        return cls(
            id=inbox_typeid.id,
            address=descriptor.get("address"),
            display_name=descriptor.get("display_name"),
            provider=descriptor.get("provider"),
            provider_inbox_id=descriptor.get("provider_inbox_id"),
            status=descriptor.get("status"),
            agent_typeid=linked_agent,
        )


__all__ = ["EmailInbox"]

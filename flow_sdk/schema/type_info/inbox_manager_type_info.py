"""Type metadata for INBOX_MANAGER — the @local unread-projection singleton."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

INBOX_MANAGER = TypeMetadata(
    type=EntityType.INBOX_MANAGER,
    icon="Inbox",
    api_visible=True,
    creatable=False,
)

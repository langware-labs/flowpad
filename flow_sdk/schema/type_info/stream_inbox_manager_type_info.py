"""Type metadata for INBOX_MANAGER — the @local unread-projection singleton."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

INBOX_MANAGER = TypeInfo(
    type_name=EntityType.INBOX_MANAGER,
    icon="Inbox",
    api_visible=True,
    creatable=False,
)

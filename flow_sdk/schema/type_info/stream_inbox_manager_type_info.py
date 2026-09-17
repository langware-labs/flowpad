"""Type metadata for STREAM_INBOX_MANAGER — the @local unread-projection singleton."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

STREAM_INBOX_MANAGER = TypeInfo(
    type_name=EntityType.STREAM_INBOX_MANAGER,
    icon="Inbox",
    api_visible=True,
    creatable=False,
)

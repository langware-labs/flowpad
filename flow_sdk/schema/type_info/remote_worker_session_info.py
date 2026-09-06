"""Type metadata for REMOTE_WORKER_SESSION."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

REMOTE_WORKER_SESSION = TypeInfo(
    type_name=EntityType.REMOTE_WORKER_SESSION,
    api_visible=True,
    icon="ScreenShare",
)

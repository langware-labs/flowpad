"""Type metadata for REMOTE_WORKER_SESSION."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

REMOTE_WORKER_SESSION = TypeMetadata(
    type=EntityType.REMOTE_WORKER_SESSION,
    api_visible=True,
    icon="ScreenShare",
)

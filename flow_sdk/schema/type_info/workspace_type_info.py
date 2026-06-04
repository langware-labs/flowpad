"""Type metadata for WORKSPACE."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

WORKSPACE = TypeMetadata(type=EntityType.WORKSPACE, icon="Users", api_visible=True)

"""Type metadata for DEPLOYMENT."""

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

DEPLOYMENT = TypeInfo(
    type_name=EntityType.DEPLOYMENT,
    api_visible=True,
    icon="Cloud",
    display_name="Deployments",
)

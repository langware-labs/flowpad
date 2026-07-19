"""Type metadata for DEPLOYMENT."""

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

DEPLOYMENT = TypeMetadata(
    type=EntityType.DEPLOYMENT,
    api_visible=True,
    icon="Cloud",
    displayName="Deployments",
)

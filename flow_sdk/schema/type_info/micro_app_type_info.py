"""Type metadata for MICRO_APP."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

# MicroApp is an Entity but had no TypeMetadata, so the registry could not see
# it: no icon, no display name, absent from the bootstrap schema the frontend
# queries through. Registering it is what lets an app's delivery row be read
# from the UI at all — the same treatment its sibling companion Deployment and
# its subject Artifact already have.
MICRO_APP = TypeMetadata(
    type=EntityType.MICRO_APP,
    api_visible=True,
    icon="AppWindow",
    displayName="Apps",
)

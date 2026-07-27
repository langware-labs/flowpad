"""Type metadata for ARTIFACT."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

ARTIFACT = TypeMetadata(
    type=EntityType.ARTIFACT,
    api_visible=True,
    icon="Package",
    displayName="Artifacts",
    # On receive, an artifact is set up (cloned/served/built + shown in Vibe) by
    # the built-in ``artifact-setup`` skill running in a headless Vibe session.
    setup_skill="artifact-setup",
    reception_verb="Set up",
)

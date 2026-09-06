"""Type metadata for ARTIFACT."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

ARTIFACT = TypeInfo(
    type_name=EntityType.ARTIFACT,
    api_visible=True,
    icon="Package",
    display_name="Artifacts",
    # On receive, an artifact is set up (cloned/served/built + shown in Vibe) by
    # the built-in ``artifact-setup`` skill running in a headless Vibe session.
    setup_skill="artifact-setup",
    reception_verb="Set up",
)

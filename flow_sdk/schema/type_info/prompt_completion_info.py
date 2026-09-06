"""Type metadata for PROMPT_COMPLETION."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

PROMPT_COMPLETION = TypeInfo(
    type_name=EntityType.PROMPT_COMPLETION,
    api_visible=True,
    icon="MessageSquareReply",
)

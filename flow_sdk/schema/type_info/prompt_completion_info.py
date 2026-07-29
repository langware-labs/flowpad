"""Type metadata for PROMPT_COMPLETION."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

PROMPT_COMPLETION = TypeMetadata(
    type=EntityType.PROMPT_COMPLETION,
    api_visible=True,
    icon="MessageSquareReply",
)

"""Type metadata for PROMPT_RESULT."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

PROMPT_RESULT = TypeMetadata(
    type=EntityType.PROMPT_RESULT,
    api_visible=True,
    icon="MessageSquareReply",
)

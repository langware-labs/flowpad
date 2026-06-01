"""Type metadata for GIT_REPO."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

GIT_REPO = TypeMetadata(type=EntityType.GIT_REPO, icon="GitBranch", api_visible=True)

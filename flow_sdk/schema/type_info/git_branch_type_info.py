from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

GIT_BRANCH = TypeMetadata(
    type=EntityType.GIT_BRANCH,
    icon="GitBranch",
    api_visible=True,
    # Sharing a snapshot also advertises its deterministic GitRemote parent
    # on the share rail; the receive path re-mints the parent locally.
    parent_share_on_default=True,
)

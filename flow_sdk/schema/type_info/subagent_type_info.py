"""Type metadata for SUBAGENT — Claude Code's provider-owned ``.claude/agents/*.md``."""
from flow_sdk.builtin.subagent import SubAgentSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, frontmatter_id
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

SUBAGENT = TypeMetadata(
    type=EntityType.SUBAGENT,
    displayName="Sub-agents",
    fts_content=("name", "description", "prompt"),
    name_from_path=True,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(frontmatter_id),
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    api_visible=True,
    icon="Bot",
    index_fields=["description"],
    asset_class="shared",
    family="agents",
    asset_spec=SubAgentSpec,
)

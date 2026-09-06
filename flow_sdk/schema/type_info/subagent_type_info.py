"""Type metadata for SUBAGENT — Claude Code's provider-owned ``.claude/agents/*.md``."""
from flow_sdk.builtin.subagent import SubAgentSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Walk
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

SUBAGENT = TypeInfo(
    type_name=EntityType.SUBAGENT,
    shape=File(ext=".md"),
    editor="subagent",
    display_name="Sub-agents",
    fts_content=("name", "description", "prompt"),
    name_from_path=True,
    identity_carrier=frontmatter_identity(),
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    api_visible=True,
    icon="Bot",
    index_fields=["description"],
    asset_class="shared",
    family="agents",
    # ``<prefix>/agents/*.md`` under EVERY harness dot-dir (the class is
    # shared: a codex-default machine writes ``.agents/agents``), so the read
    # side agrees with wherever placement may write.
    walk=Walk(roots=("user_home_folder", "real_project_cwd", "cwd_root", "system_root")),
    asset_spec=SubAgentSpec,
)

"""Type metadata for CLAUDE_RULES."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    frontmatter_identity,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.claude_rules import (
    extract_claude_rules,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Walk
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CLAUDE_RULES = TypeInfo(
    type_name=EntityType.CLAUDE_RULES,
    shape=File(ext=".md"),
    editor="markdown",
    icon="Shield",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    asset_class="harness",
    harness="claude",
    family="rules",
    # ``.claude/rules/*.md`` (mount derived from placement) at user + both project roots.
    walk=Walk(roots=("user_home_folder", "real_project_cwd", "cwd_root")),
    from_disk_fn=extract_claude_rules,
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=resolved_path_key,
)

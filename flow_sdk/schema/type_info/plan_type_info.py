"""Type metadata for PLAN."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    frontmatter_identity,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.claude_plan import extract_claude_plan
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Walk
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

PLAN = TypeInfo(
    type_name=EntityType.PLAN,
    shape=File(ext=".md"),
    editor="markdown",
    icon="FileText",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    asset_class="repo",
    family="plan",
    # Harness INGEST, not placement: ``~/.claude/plans/`` is Claude Code's own
    # plan-mode output directory, read the way ``~/.claude/projects/`` is —
    # hence the explicit mount and the user root only. Flowpad's OWN plans are
    # repo assets (``agentic-assets/plan/``, the placement above) and are found
    # by the repo-assets walker.
    walk=Walk(roots=("user_home_folder",), mounts=(".claude/plans",)),
    from_disk_fn=extract_claude_plan,
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=resolved_path_key,
)

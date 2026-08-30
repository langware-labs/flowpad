"""Type metadata for MARKDOWN."""
from flow_sdk.builtin.claude_memory_entities import MarkdownSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, frontmatter_identity
from flow_sdk.fs_store.indexer.functions.markdown import derive_markdown
from flow_sdk.fs_store.operations.markdown import reconcile_folder_doc_edges
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

MARKDOWN = TypeMetadata(
    hub_main_file="document.md",
    type=EntityType.MARKDOWN,
    icon="FileText",
    displayName="Documents",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["title", "tags", "links"],
    asset_class="docs",
    family="docs",
    fts_content=("body", "links"),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(),
    post_sync_fn=reconcile_folder_doc_edges,
    # ``owns_main_ref`` stays False: a create materializes the .md when absent
    # and never clobbers hand edits. Identity lives in the capsule, not the
    # frontmatter; a fresh doc renders an empty header.
    asset_spec=MarkdownSpec,
    derive_fields_fn=derive_markdown,
    # On receive, a note has no setup agent — it just opens (setup_skill=None).
    reception_verb="Open",
)

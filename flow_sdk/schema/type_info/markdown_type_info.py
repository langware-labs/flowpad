"""Type metadata for MARKDOWN."""
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_id, write_frontmatter
from flow_sdk.fs_store.indexer.functions.markdown import (
    extract_markdown,
)
from flow_sdk.fs_store.operations.markdown import reconcile_folder_doc_edges
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


def _markdown_default_body(entity) -> str:
    """Markdown written to docs/<name>.md on create.

    Mirrors Skill/Agent/Workflow: without a default-body writer, create persists
    the entity + asset_ref but never materializes the .md, so opening the brand-new
    doc hits a missing file. ``owns_main_ref`` is False, so this only writes when
    the file is absent (``upsert_main_ref``) — it never clobbers hand edits. Title
    is carried by the filename stem, so a bare heading round-trips cleanly.
    """
    name = (getattr(entity, "title", None) or getattr(entity, "name", None) or "Untitled").strip()
    return render_entity_frontmatter(entity, {}) + f"\n\n# {name}\n"


MARKDOWN = TypeMetadata(
    type=EntityType.MARKDOWN,
    icon="WikiW",
    displayName="Documents",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["title", "tags", "links"],
    asset_class="internal",
    family="docs",
    from_disk_fn=extract_markdown,
    id_from_file_fn=frontmatter_id,
    id_write_fn=write_frontmatter,
    post_sync_fn=reconcile_folder_doc_edges,
    default_body_fn=_markdown_default_body,
    # On receive, a note has no setup agent — it just opens (setup_skill=None).
    reception_verb="Open",
)

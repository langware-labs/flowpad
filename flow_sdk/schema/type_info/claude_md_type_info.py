"""Type metadata for CLAUDE_MD."""
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_id, write_frontmatter
from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

# NOTE: no `main_subdir` on purpose. CLAUDE_MD's filename is the fixed
# `CLAUDE.md` (not name-derived), which is incompatible with compute_asset_ref's
# `<main_subdir>/<safe_name>` model — so it is deliberately excluded from the
# shareable file-backed asset family (the `main_subdir is not None` predicate).
CLAUDE_MD = TypeMetadata(
    type=EntityType.CLAUDE_MD,
    icon="BookOpen",
    api_visible=True,
    from_disk_fn=extract_markdown,
    id_from_file_fn=frontmatter_id,
    id_write_fn=write_frontmatter,
)

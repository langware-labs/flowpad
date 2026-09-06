"""Type metadata for CLAUDE_MD."""
from flow_sdk.builtin.claude_memory_entities import ClaudeMdSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.indexer.functions.markdown import derive_claude_md
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File
from flow_sdk.schema.types import EntityType

# NOTE: no `main_subdir` on purpose. CLAUDE_MD's filename is the fixed
# `CLAUDE.md` (not name-derived), which is incompatible with compute_asset_ref's
# `<main_subdir>/<safe_name>` model — so it is deliberately excluded from the
# shareable file-backed asset family (the `main_subdir is not None` predicate).
CLAUDE_MD = TypeInfo(
    type_name=EntityType.CLAUDE_MD,
    # Claimed by NAME, never by extension. Discovery stays bespoke
    # (``claude_md.py``): the names sit at two depths and which spellings each
    # root reads is not a mount list (``<project>/.claude/CLAUDE.local.md`` is
    # deliberately not one).
    shape=File(ext=".md", names=("CLAUDE.md", "CLAUDE.local.md")),
    editor="markdown",
    icon="BookOpen",
    api_visible=True,
    fts_content=("body", "links"),
    identity_carrier=frontmatter_identity(),
    asset_spec=ClaudeMdSpec,
    derive_fields_fn=derive_claude_md,
)

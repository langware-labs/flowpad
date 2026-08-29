"""Type metadata for PROMPT (docs/prompt-library.md)."""
from flow_sdk.builtin.prompt import PromptSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    capsule_identity,
    frontmatter_id,
    resolved_path_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

PROMPT = TypeMetadata(
    type=EntityType.PROMPT,
    fts_content=("text",),
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(frontmatter_id),
    id_stable_key_fn=resolved_path_key,
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    # quick-create/registry.ts carries the `prompt` descriptor. Quick-create opens
    # PromptEditDialog (a prompt needs its text at create time, and `main_subdir`
    # already fixes the location, so the generic name+path form has nothing to
    # ask); the AssetsPage "+" is name-only and creates an empty-text prompt.
    creatable=True,
    icon="BookMarked",
    api_visible=True,
    index_fields=["name", "group_id"],
    asset_class="repo",
    family="prompt",
    asset_spec=PromptSpec,
    # The frontmatter ``name`` falls back to the file stem.
    name_from_path=True,
    # The edit dialog is the prompt's only editor in v1 — entity saves
    # re-render the .md so frontmatter/body never diverge from the entity.
    owns_main_ref=True,
)

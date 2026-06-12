"""Type metadata for PROMPT (docs/prompt-library.md)."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.prompt import (
    extract_prompt,
    prompt_gen_id,
)


class PromptMeta(BaseMeta):
    icon: Optional[str] = None
    color: Optional[str] = None
    use_count: Optional[int] = None
    last_used_at: Optional[str] = None


def _prompt_default_body(entity) -> str:
    """Markdown written to the prompt's asset_ref on create.

    Mirrors Workflow: without a default-body writer, create persists the
    entity + asset_ref but never materializes the backing .md. Frontmatter
    matches what ``extract_prompt`` parses back (id/name/icon/color/group_id);
    the body is the prompt text. ``_render_frontmatter`` yaml-quotes emoji
    icon values safely.
    """
    fields = {"name": getattr(entity, "name", "") or ""}
    for key in ("icon", "color", "group_id"):
        value = getattr(entity, key, None)
        if value:
            fields[key] = value
    # Usage tracking (parsed back by extract_prompt — a reindex must not
    # reset it). Only written once non-zero so fresh prompts stay minimal.
    use_count = getattr(entity, "use_count", 0) or 0
    if use_count:
        fields["use_count"] = int(use_count)
    last_used_at = getattr(entity, "last_used_at", None)
    if last_used_at:
        fields["last_used_at"] = last_used_at
    text = (getattr(entity, "text", None) or "").strip()
    return render_entity_frontmatter(entity, fields) + "\n\n" + text + ("\n" if text else "")


PROMPT = TypeMetadata(
    type=EntityType.PROMPT,
    from_disk_fn=extract_prompt,
    gen_id_fn=prompt_gen_id,
    indexed_by_default=True,
    browseable=True,
    # v1: creation lives in the Prompt Library menu (PromptEditDialog with the
    # generic pickers); the AssetsPage quick-create path needs a descriptor in
    # quick-create/registry.ts before this flips on.
    creatable=False,
    icon="BookMarked",
    api_visible=True,
    index_fields=["name", "group_id"],
    main_subdir="prompts",
    default_body_fn=_prompt_default_body,
    # The edit dialog is the prompt's only editor in v1 — entity saves
    # re-render the .md so frontmatter/body never diverge from the entity.
    owns_main_ref=True,
    meta_model=PromptMeta,
)

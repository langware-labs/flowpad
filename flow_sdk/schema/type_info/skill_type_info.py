"""Type metadata for SKILL."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.skill import (
    extract_skill,
    skill_asset_hash,
    skill_gen_id,
)

def _skill_default_body(entity) -> str:
    """SKILL.md written to the skill's main_ref on create.

    Mirrors Spec/Workflow: without a default-body writer (and a ``main_file``
    pointing the asset_ref at the inner SKILL.md), create persists the entity +
    folder asset_ref but never materializes SKILL.md, leaving a dangling pointer
    the editor reports as "file not found".
    """
    from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter  # noqa: PLC0415

    name = (getattr(entity, "name", None) or "Untitled Skill").strip()
    desc = (getattr(entity, "description", None) or "").strip()
    return _render_frontmatter({"name": name, "description": desc}) + f"\n\n# {name}\n\n{desc}\n"


SKILL = TypeMetadata(
    type=EntityType.SKILL,
    icon="Sparkles",
    browseable=True,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    main_subdir=".claude/skills",
    main_layout="folder",
    main_file="SKILL.md",
    from_disk_fn=extract_skill,
    gen_id_fn=skill_gen_id,
    asset_hash_fn=skill_asset_hash,
    default_body_fn=_skill_default_body,
)

"""Type metadata for SKILL."""
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.skill import (
    extract_skill,
    skill_asset_hash,
    skill_gen_id,
)

def _skill_default_body(entity) -> str:
    """SKILL.md written to the skill's main_ref on create.

    Skill's asset_ref is the folder (.claude/skills/<name>/) — the indexer emits
    the folder and the frontend resolves <folder>/SKILL.md itself. ``main_file``
    names that inner doc so ``upsert_main_ref`` materializes it on create;
    without it, create leaves a dangling folder pointer the editor reports as
    "file not found".
    """
    name = (getattr(entity, "name", None) or "Untitled Skill").strip()
    desc = (getattr(entity, "description", None) or "").strip()
    return render_entity_frontmatter(entity, {"name": name, "description": desc}) + f"\n\n# {name}\n\n{desc}\n"


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

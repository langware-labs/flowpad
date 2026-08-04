"""Type metadata for SKILL."""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, folder_capsule_id
from flow_sdk.fs_store.indexer.functions.skill import (
    extract_skill,
    skill_asset_hash,
    skill_id_from_folder,
)
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


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
    icon="FileBadge",
    displayName="Skills",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="shared",
    family="skills",
    main_layout="folder",
    main_file="SKILL.md",
    from_disk_fn=extract_skill,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(folder_capsule_id, skill_id_from_folder),
    asset_hash_fn=skill_asset_hash,
    default_body_fn=_skill_default_body,
    # On receive, a skill is set up by running ITSELF in a Vibe session — the
    # SELF sentinel (setup_skill == type) tells ``Entity.setup_on_receive`` to
    # seed "Use the <this skill's name> skill …". Replaces the FE
    # useRunReceivedSkill/TESTABLE_TYPES special-case.
    setup_skill=EntityType.SKILL.value,
    reception_verb="Run",
)

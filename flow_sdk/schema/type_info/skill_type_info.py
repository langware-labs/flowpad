"""Type metadata for SKILL."""
from flow_sdk.builtin.skill import SkillSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, folder_md_identity
from flow_sdk.fs_store.indexer.functions.skill import (
    derive_skill,
    skill_asset_hash,
    skill_id_from_folder,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

SKILL = TypeInfo(
    type_name=EntityType.SKILL,
    icon="FileBadge",
    display_name="Skills",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="shared",
    family="skills",
    shape=Folder(main="SKILL.md"),
    editor="skill",
    hub_main_file="SKILL.md",
    fts_content=("name", "description", "body"),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_md_identity(skill_id_from_folder),
    asset_hash_fn=skill_asset_hash,
    asset_spec=SkillSpec,
    derive_fields_fn=derive_skill,
    # On receive, a skill is set up by running ITSELF in a Vibe session — the
    # SELF sentinel (setup_skill == type) tells ``Entity.setup_on_receive`` to
    # seed "Use the <this skill's name> skill …". Replaces the FE
    # useRunReceivedSkill/TESTABLE_TYPES special-case.
    setup_skill=EntityType.SKILL.value,
    reception_verb="Run",
)

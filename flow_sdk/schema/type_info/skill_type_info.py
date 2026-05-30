"""Type metadata for SKILL."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.skill import (
    extract_skill,
    skill_asset_hash,
    skill_gen_id,
)

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
    from_disk_fn=extract_skill,
    gen_id_fn=skill_gen_id,
    asset_hash_fn=skill_asset_hash,
)

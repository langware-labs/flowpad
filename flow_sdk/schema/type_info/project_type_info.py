"""Type metadata for PROJECT."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.claude_projects import (
    extract_claude_project,
    claude_project_id,
)


class ProjectMeta(BaseMeta):
    """FS↔DB metadata schema for project records.

    ``session_count``/``last_session_at`` are deliberately absent — they are
    DB-only denormalizations (``persist=FALSE`` on the entity), computed at
    adopt time, not mirrored to disk.
    """
    fs_storage_mount_path: Optional[str] = None
    last_mode: Optional[str] = None
    session_code: Optional[str] = None
    host_member_id: Optional[str] = None
    artifacts: Optional[list] = None
    members: Optional[list] = None
    # Context-entity buckets + per-entry sidecars: a project's context folders
    # (Folder entity links, the derived ``include_dirs``) live here. Declared
    # in the meta model so the links survive a DB rebuild — without disk
    # persistence a re-index would silently drop every context folder. The
    # TypeId lists serialize as "<type>-<id>" strings (json ``default=str``)
    # and re-validate on hydration; the sidecars are plain dicts. All four are
    # DISK-persistence only — the wire/hub exclusions in ``Entity.share()`` /
    # ``_hub_body`` are unaffected.
    shared_context_entities: Optional[list] = None
    private_context_entities_: Optional[list] = None
    shared_context_entity_data: Optional[dict] = None
    private_context_entity_data: Optional[dict] = None


PROJECT = TypeMetadata(
    type=EntityType.PROJECT,
    icon="Briefcase",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_claude_project,
    gen_uuid_fn=claude_project_id,
    meta_model=ProjectMeta,
)

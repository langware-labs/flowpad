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
    session_code: Optional[str] = None
    host_member_id: Optional[str] = None
    artifacts: Optional[list] = None
    members: Optional[list] = None


PROJECT = TypeMetadata(
    type=EntityType.PROJECT,
    icon="Briefcase",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_claude_project,
    gen_uuid_fn=claude_project_id,
    meta_model=ProjectMeta,
)

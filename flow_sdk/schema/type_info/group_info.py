"""Type metadata for GROUP — the generic folder-like container entity
(docs/entities-groups.md). DB-first entity (no project-tree walker); its
record persists name/group_namespace/icon/color (+ BaseMeta's group_id) so trees
survive a full index rebuild."""
from typing import Optional

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class GroupMeta(BaseMeta):
    group_namespace: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


GROUP = TypeInfo(
    type_name=EntityType.GROUP,
    icon="Folder",
    api_visible=True,
    indexed_by_default=False,
    creatable=False,
    index_fields=["name", "group_namespace", "group_id"],
    meta_model=GroupMeta,
)

"""Type metadata for CONTACTS_GROUP — a named local address-book group of
contacts (participant-shaped entries) for adding several conversation
members at once. DB-first entity; the record persists name + contacts so
groups survive an index rebuild."""

from typing import Optional

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class ContactsGroupMeta(BaseMeta):
    contacts: Optional[list] = None


CONTACTS_GROUP = TypeInfo(
    type_name=EntityType.CONTACTS_GROUP,
    icon="Users",
    api_visible=True,
    indexed_by_default=False,
    creatable=False,
    index_fields=["name"],
    meta_model=ContactsGroupMeta,
)

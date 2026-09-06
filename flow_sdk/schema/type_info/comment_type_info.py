"""Type metadata for COMMENT."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

# ``shared_child=True``: a comment on a shared doc is pulled during the
# shared-context catch-up sync (the live bridge already materializes it). This
# enrolls ``comment`` in ``SchemaRegistry.get_shared_child_types()`` instead of a
# hardcoded tuple in ``flow_message_action``.
COMMENT = TypeInfo(type_name=EntityType.COMMENT, api_visible=True, shared_child=True)

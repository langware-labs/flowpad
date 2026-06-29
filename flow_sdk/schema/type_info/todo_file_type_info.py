"""Type metadata for TODO_FILE."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.todo import (
    extract_todo,
    todo_id,
)

TODO_FILE = TypeMetadata(
    type=EntityType.TODO_FILE,
    icon="ListChecks",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_todo,
    gen_uuid_fn=todo_id,
)

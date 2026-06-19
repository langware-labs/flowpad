"""Type metadata for TASK."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.task import (
    extract_task,
    task_gen_id,
)

TASK = TypeMetadata(
    type=EntityType.TASK,
    icon="CheckSquare",
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "objective"],
    from_disk_fn=extract_task,
    gen_id_fn=task_gen_id,
)

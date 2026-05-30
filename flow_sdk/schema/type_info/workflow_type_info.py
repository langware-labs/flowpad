"""Type metadata for WORKFLOW."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.workflow import (
    extract_workflow,
    workflow_gen_id,
)

WORKFLOW = TypeMetadata(
    type=EntityType.WORKFLOW,
    icon="Workflow",
    browseable=True,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name", "description"],
    main_subdir=".claude/workflows",
    from_disk_fn=extract_workflow,
    gen_id_fn=workflow_gen_id,
)

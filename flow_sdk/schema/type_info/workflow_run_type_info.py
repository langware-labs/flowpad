"""Type metadata for WORKFLOW_RUN."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.workflow_run import (
    extract_workflow_run,
    workflow_run_gen_id,
)


class WorkflowRunMeta(BaseMeta):
    run_id: Optional[str] = None
    workflow_name: Optional[str] = None
    status: Optional[str] = None
    agent_count: Optional[int] = None
    total_tokens: Optional[int] = None
    total_tool_calls: Optional[int] = None
    duration_ms: Optional[int] = None
    default_model: Optional[str] = None


WORKFLOW_RUN = TypeMetadata(
    type=EntityType.WORKFLOW_RUN,
    from_disk_fn=extract_workflow_run,
    gen_uuid_fn=workflow_run_gen_id,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    creatable=False,
    icon="Workflow",
    api_visible=True,
    index_fields=["name", "workflow_name", "status"],
    # Read-only, provider-owned journal: asset_ref is set directly by the
    # extractor (FSRef(..., read_only=True)), like claude_session — no folder
    # layout / main_file materialization here.
    meta_model=WorkflowRunMeta,
)

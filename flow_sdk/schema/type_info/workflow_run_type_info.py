"""Type metadata for WORKFLOW_RUN."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.workflow_run import (
    extract_workflow_run,
    workflow_run_identity_key,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class WorkflowRunMeta(BaseMeta):
    run_id: Optional[str] = None
    workflow_name: Optional[str] = None
    status: Optional[str] = None
    agent_count: Optional[int] = None
    total_tokens: Optional[int] = None
    total_tool_calls: Optional[int] = None
    duration_ms: Optional[int] = None
    default_model: Optional[str] = None
    source_path: Optional[str] = None
    dynamic_workflow_id: Optional[str] = None
    skill_id: Optional[str] = None


WORKFLOW_RUN = TypeInfo(
    type_name=EntityType.WORKFLOW_RUN,
    from_disk_fn=extract_workflow_run,
    shape=File(ext=".json"),
    identity_carrier=derived_identity(),
    id_stable_key_fn=workflow_run_identity_key,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    creatable=False,
    icon="Workflow",
    api_visible=True,
    index_fields=["name", "workflow_name", "status", "dynamic_workflow_id", "skill_id"],
    # Read-only, provider-owned journal: asset_ref is set directly by the
    # extractor (FSRef(..., read_only=True)), like claude_session — no folder
    # layout / main_file materialization here.
    meta_model=WorkflowRunMeta,
)

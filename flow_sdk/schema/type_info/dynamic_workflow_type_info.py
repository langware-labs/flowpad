"""Type metadata for DYNAMIC_WORKFLOW — an authored dynamic-workflow script asset."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import (
    dynamic_workflow_default_body,
    dynamic_workflow_id,
    extract_dynamic_workflow,
)


class DynamicWorkflowMeta(BaseMeta):
    description: Optional[str] = None


DYNAMIC_WORKFLOW = TypeMetadata(
    type=EntityType.DYNAMIC_WORKFLOW,
    icon="Boxes",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name", "description"],
    asset_class="harness",
    harness="claude",
    family="workflows",
    main_ext=".js",
    from_disk_fn=extract_dynamic_workflow,
    gen_uuid_fn=dynamic_workflow_id,
    default_body_fn=dynamic_workflow_default_body,
    meta_model=DynamicWorkflowMeta,
)
